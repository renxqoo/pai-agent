/**
 * Single-session host: exactly one AgentSessionRuntime per worker process
 * (design.md migration §1). The runtime layer (same one pi's built-in modes
 * use) carries fork/clone's session replacement; replacement re-binds
 * subscriptions and swaps the session object in place. Conversation
 * multiplicity lives in the host process, not here.
 *
 * Concurrency: session-replacing operations (fork/clone/stop) are serialized
 * — a stop racing a fork could resurrect a stopped session, and two forks
 * could misreport previousThreadId (migration.md F-2).
 */

import { resolve } from "node:path";
import {
  type AgentSession,
  type AgentSessionRuntime,
  type AgentSessionEvent,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionUIContext,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { permissionGate } from "./permission-gate.ts";
import type { HubFrame, SessionModel } from "./protocol.ts";

export interface Thread {
  runtime: AgentSessionRuntime;
  /** Current session; replaced (and re-bound) on fork/clone. */
  session: AgentSession;
  cwd: string;
  sessionPath: string | undefined;
  unsubscribe: () => void;
}

export type UiContextFactory = (threadId: string) => ExtensionUIContext;

/**
 * Fork/clone failed AFTER the runtime tore down the current session
 * (migration.md F-1). The session object left in place is disposed; the
 * worker must fail the command and exit instead of keeping a zombie thread.
 */
export class SessionDestroyedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionDestroyedError";
  }
}

/**
 * Streaming events carry cumulative snapshots (message + the partial
 * assistant message inside each delta) that pi's RPC mode strips before
 * serialization; frame size must stay constant per delta, otherwise long
 * replies amplify to quadratic wire traffic. Top-level usage is kept.
 */
function toWireEvent(event: AgentSessionEvent): AgentSessionEvent {
  if (event.type !== "message_update") return event;
  const { message: _message, assistantMessageEvent, ...rest } = event;
  if (assistantMessageEvent === undefined) {
    return rest as AgentSessionEvent;
  }
  const { partial: _partial, ...delta } = assistantMessageEvent as typeof assistantMessageEvent & {
    partial?: unknown;
  };
  return { ...rest, assistantMessageEvent: delta } as AgentSessionEvent;
}

export class SessionHost {
  private thread: Thread | undefined;
  private readonly modelRuntime: ModelRuntime;
  private readonly emit: (frame: HubFrame) => void;
  private readonly createUi: UiContextFactory;
  private readonly onThreadDisposed?: (threadId: string) => void;
  /** Serializes session-replacing operations (fork/clone/stop). */
  private replacementQueue: Promise<unknown> = Promise.resolve();
  /** Spawn in flight, so shutdown can wait for it and start can reject doubles. */
  private spawning = false;
  private currentSpawn: Promise<unknown> | undefined;
  private closed = false;

  constructor(
    modelRuntime: ModelRuntime,
    emit: (frame: HubFrame) => void,
    createUi: UiContextFactory,
    onThreadDisposed?: (threadId: string) => void,
  ) {
    this.modelRuntime = modelRuntime;
    this.emit = emit;
    this.createUi = createUi;
    this.onThreadDisposed = onThreadDisposed;
  }

  get(): Thread | undefined {
    return this.thread;
  }

  async start(options: { cwd: string; trusted: boolean; model?: SessionModel }): Promise<Thread> {
    if (this.thread !== undefined || this.spawning) {
      throw new Error("Worker already hosts a conversation; one session per worker process");
    }
    this.spawning = true;
    const spawn = this.spawn({
      cwd: options.cwd,
      trusted: options.trusted,
      model: options.model,
      sessionManager: SessionManager.create(options.cwd),
      spawnPath: undefined,
    });
    this.currentSpawn = spawn;
    try {
      return await spawn;
    } finally {
      this.spawning = false;
      this.currentSpawn = undefined;
    }
  }

  async resume(options: {
    cwd: string | undefined;
    trusted: boolean;
    sessionPath: string;
  }): Promise<Thread> {
    if (this.thread !== undefined || this.spawning) {
      throw new Error("Worker already hosts a conversation; one session per worker process");
    }
    this.spawning = true;
    const sessionPath = resolve(options.sessionPath);
    const sessionManager = SessionManager.open(sessionPath);
    // Default cwd comes from the session header, not the worker cwd:
    // resumed tools must operate where the conversation started.
    const cwd = options.cwd ?? sessionManager.getCwd();
    const spawn = this.spawn({
      cwd,
      trusted: options.trusted,
      sessionManager,
      spawnPath: sessionPath,
    });
    this.currentSpawn = spawn;
    try {
      return await spawn;
    } finally {
      this.spawning = false;
      this.currentSpawn = undefined;
    }
  }

  /**
   * Fork from a historical entry. On success the runtime replaced the
   * session in place; resolves the thread under its new session id.
   */
  async fork(
    entryId: string,
    position: "before" | "at",
  ): Promise<{
    thread: Thread;
    previousThreadId: string;
    selectedText: string | undefined;
    cancelled: boolean;
  }> {
    return this.runReplacement(async () => {
      const thread = this.requireSession();
      const previousThreadId = thread.session.sessionId;
      const result = await this.replaceSession(thread, (runtime) =>
        runtime.fork(entryId, { position }),
      );
      if (result.cancelled) {
        return { thread, previousThreadId, selectedText: undefined, cancelled: true };
      }
      return {
        thread,
        previousThreadId,
        selectedText: result.selectedText,
        cancelled: false,
      };
    });
  }

  /** Clone: fork at the current leaf. */
  async clone(): Promise<{ thread: Thread; previousThreadId: string; cancelled: boolean }> {
    return this.runReplacement(async () => {
      const thread = this.requireSession();
      const leafId = thread.session.sessionManager.getLeafId();
      if (!leafId) {
        throw new Error("Cannot clone: session has no entries");
      }
      const previousThreadId = thread.session.sessionId;
      const result = await this.replaceSession(thread, (runtime) =>
        runtime.fork(leafId, { position: "at" }),
      );
      return { thread, previousThreadId, cancelled: result.cancelled };
    });
  }

  /** Idempotent: stopping when no session is hosted succeeds silently. */
  async stop(): Promise<void> {
    return this.runReplacement(async () => {
      const thread = this.thread;
      if (!thread) return;
      const threadId = thread.session.sessionId;
      this.thread = undefined;
      thread.unsubscribe();
      await thread.runtime.dispose();
      this.onThreadDisposed?.(threadId);
    });
  }

  /** Worker shutdown: wait for any in-flight spawn, then stop the session. */
  async dispose(): Promise<void> {
    this.closed = true;
    await this.currentSpawn?.catch(() => {});
    await this.stop();
  }

  private requireSession(): Thread {
    const thread = this.thread;
    if (!thread) throw new Error("No active session in this worker");
    return thread;
  }

  /** Serialize session-replacing operations on the one session. */
  private runReplacement<T>(task: () => Promise<T>): Promise<T> {
    const next = this.replacementQueue.then(task, task);
    this.replacementQueue = next.catch(() => {});
    return next;
  }

  /**
   * Run one runtime session replacement, translating post-teardown failures
   * into SessionDestroyedError: pi's runtime disposes the current session
   * (teardownCurrent) before creating the replacement, and a failure in
   * createRuntime after that point would leave a disposed session in place
   * (migration.md F-1). The public beforeSessionInvalidate hook is the exact
   * "teardown started" signal.
   */
  private async replaceSession(
    thread: Thread,
    op: (runtime: AgentSessionRuntime) => Promise<{
      cancelled: boolean;
      selectedText?: string;
    }>,
  ): Promise<{ cancelled: boolean; selectedText?: string }> {
    let invalidated = false;
    thread.runtime.setBeforeSessionInvalidate(() => {
      invalidated = true;
    });
    try {
      return await op(thread.runtime);
    } catch (error) {
      if (invalidated) {
        throw new SessionDestroyedError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      thread.runtime.setBeforeSessionInvalidate(undefined);
    }
  }

  private async spawn(options: {
    cwd: string;
    trusted: boolean;
    model?: SessionModel;
    sessionManager: SessionManager;
    spawnPath: string | undefined;
  }): Promise<Thread> {
    // Official two-stage factory: services (resource loader, settings,
    // shared model runtime) then the session bound to the passed manager —
    // the runtime calls this again on fork/switch with a fresh manager.
    const makeFactory = (
      trusted: boolean,
      model: SessionModel | undefined,
    ): CreateAgentSessionRuntimeFactory => {
      return async (factoryOptions) => {
        const services = await createAgentSessionServices({
          cwd: factoryOptions.cwd,
          agentDir: factoryOptions.agentDir,
          modelRuntime: this.modelRuntime,
          resourceLoaderOptions: {
            // Extensions are arbitrary code. Untrusted sessions load only
            // the built-in permission gate; skills/prompts/context stay
            // available because they are data, not code.
            ...(trusted ? {} : { noExtensions: true }),
            extensionFactories: [permissionGate],
          },
        });
        const created = await createAgentSessionFromServices({
          services,
          sessionManager: factoryOptions.sessionManager,
          ...(factoryOptions.sessionStartEvent !== undefined
            ? { sessionStartEvent: factoryOptions.sessionStartEvent }
            : {}),
          ...(model ? { model } : {}),
        });
        return { ...created, services, diagnostics: [] };
      };
    };

    const runtime = await createAgentSessionRuntime(makeFactory(options.trusted, options.model), {
      cwd: options.cwd,
      agentDir: getAgentDir(),
      sessionManager: options.sessionManager,
    });
    const session = runtime.session;

    if (this.closed) {
      // Shutdown raced this spawn: dispose immediately so the session
      // file is flushed and nothing leaks past dispose().
      await runtime.dispose();
      throw new Error("pai-cli worker is shutting down");
    }

    const thread: Thread = {
      runtime,
      session,
      cwd: options.cwd,
      sessionPath: session.sessionFile,
      unsubscribe: () => {},
    };

    // fork/clone replaces the session inside the runtime; rebind swaps the
    // subscription and re-binds extensions. The thread's id becomes the new
    // session's id (v0.3 "threadId 语义修订" — the host updates its routing
    // from the fork/clone response).
    runtime.setRebindSession(async (replacement) => {
      thread.unsubscribe();
      thread.session = replacement;
      thread.sessionPath = replacement.sessionFile;
      thread.unsubscribe = replacement.subscribe((event: AgentSessionEvent) => {
        this.emit({ type: "event", threadId: replacement.sessionId, event: toWireEvent(event) });
      });
      await replacement.bindExtensions({
        uiContext: this.createUi(replacement.sessionId),
        mode: "rpc",
      });
    });

    thread.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      this.emit({ type: "event", threadId: session.sessionId, event: toWireEvent(event) });
    });
    await session.bindExtensions({ uiContext: this.createUi(session.sessionId), mode: "rpc" });
    this.thread = thread;
    return thread;
  }
}
