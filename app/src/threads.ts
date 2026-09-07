/**
 * Thread lifecycle: one AgentSessionRuntime per conversation inside this
 * process. The runtime layer (same one pi's built-in modes use) carries
 * fork/clone's session replacement; replacement re-binds subscriptions and
 * re-keys the thread map, and the thread's id becomes the new session's id.
 *
 * Concurrency budget (design.md): spawns are serialized and double-open
 * guards key on the resolved session path, so two concurrent resumes of the
 * same file can never both pass (check-then-act window is closed).
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
import type { HubFrame } from "./protocol.ts";

export interface Thread {
  runtime: AgentSessionRuntime;
  /** Current session; replaced (and re-bound) on fork/clone. */
  session: AgentSession;
  cwd: string;
  sessionPath: string | undefined;
  unsubscribe: () => void;
}

/** Session model type without importing the transitive pi-ai package. */
export type SessionModel = NonNullable<AgentSession["model"]>;

export type UiContextFactory = (threadId: string) => ExtensionUIContext;

export interface NavigateTreeOptions {
  summarize?: boolean;
  customInstructions?: string;
  replaceInstructions?: string;
  label?: string;
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

export class ThreadManager {
  private readonly threads = new Map<string, Thread>();
  private readonly modelRuntime: ModelRuntime;
  private readonly emit: (frame: HubFrame) => void;
  private readonly createUi: UiContextFactory;
  private readonly onThreadDisposed?: (threadId: string) => void;
  /** Serializes spawns so double-open guards have no check-then-act window. */
  private spawnQueue: Promise<unknown> = Promise.resolve();
  /**
   * Per-thread mutation queue: fork/clone/stop (and any future session-
   * replacing operation) must not interleave on one thread — a stop racing a
   * fork could resurrect a stopped thread under a new id, and two forks
   * could misreport previousThreadId.
   */
  private readonly threadQueues = new Map<string, Promise<unknown>>();
  /** Resolved session paths with a spawn in flight. */
  private readonly spawningPaths = new Set<string>();
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

  get(threadId: string): Thread | undefined {
    return this.threads.get(threadId);
  }

  list(): Array<{
    threadId: string;
    cwd: string;
    sessionPath: string | null;
    isStreaming: boolean;
  }> {
    return [...this.threads.values()].map((thread) => ({
      threadId: thread.session.sessionId,
      cwd: thread.cwd,
      sessionPath: thread.session.sessionFile ?? null,
      isStreaming: thread.session.isStreaming,
    }));
  }

  async start(options: { cwd: string; trusted: boolean; model?: SessionModel }): Promise<Thread> {
    return this.enqueueSpawn(() =>
      this.spawn({
        cwd: options.cwd,
        trusted: options.trusted,
        model: options.model,
        sessionManager: SessionManager.create(options.cwd),
        spawnPath: undefined,
      }),
    );
  }

  async resume(options: {
    cwd: string | undefined;
    trusted: boolean;
    model?: SessionModel;
    sessionPath: string;
  }): Promise<Thread> {
    return this.enqueueSpawn(async () => {
      const sessionPath = resolve(options.sessionPath);
      this.assertNotOpen(sessionPath);
      this.spawningPaths.add(sessionPath);
      try {
        const sessionManager = SessionManager.open(sessionPath);
        // Default cwd comes from the session header, not the hub cwd:
        // resumed tools must operate where the conversation started.
        const cwd = options.cwd ?? sessionManager.getCwd();
        return await this.spawn({
          cwd,
          trusted: options.trusted,
          model: options.model,
          sessionManager,
          spawnPath: sessionPath,
        });
      } finally {
        this.spawningPaths.delete(sessionPath);
      }
    });
  }

  /**
   * Fork from a historical entry. On success the runtime replaced the
   * session; the thread was re-keyed and this resolves the NEW thread.
   */
  async fork(
    threadId: string,
    entryId: string,
    position: "before" | "at",
  ): Promise<{
    thread: Thread;
    previousThreadId: string;
    selectedText: string | undefined;
    cancelled: boolean;
  }> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Unknown threadId: ${threadId}`);
    const previousThreadId = thread.session.sessionId;
    const result = await thread.runtime.fork(entryId, { position });
    if (result.cancelled) {
      return { thread, previousThreadId, selectedText: undefined, cancelled: true };
    }
    // Rebind already re-keyed the map; fetch the thread under its new id.
    const rebound = this.threads.get(thread.session.sessionId) ?? thread;
    return {
      thread: rebound,
      previousThreadId,
      selectedText: result.selectedText,
      cancelled: false,
    };
  }

  /** Clone: fork at the current leaf. */
  async clone(
    threadId: string,
  ): Promise<{ thread: Thread; previousThreadId: string; cancelled: boolean }> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Unknown threadId: ${threadId}`);
    const leafId = thread.session.sessionManager.getLeafId();
    if (!leafId) {
      throw new Error("Cannot clone: session has no entries");
    }
    const previousThreadId = thread.session.sessionId;
    const result = await thread.runtime.fork(leafId, { position: "at" });
    if (result.cancelled) {
      return { thread, previousThreadId, cancelled: true };
    }
    const rebound = this.threads.get(thread.session.sessionId) ?? thread;
    return { thread: rebound, previousThreadId, cancelled: false };
  }

  /** Idempotent: stopping an unknown thread succeeds silently. */
  async stop(threadId: string): Promise<void> {
    return this.runExclusive(threadId, async () => {
      const thread = this.threads.get(threadId);
      if (!thread) return;
      this.threads.delete(threadId);
      thread.unsubscribe();
      await thread.runtime.dispose();
      this.onThreadDisposed?.(threadId);
    });
  }

  async stopAll(): Promise<void> {
    this.closed = true;
    // Wait for any in-flight spawn so it observes `closed` and cleans up
    // after itself instead of registering a never-disposed thread.
    await this.spawnQueue.catch(() => {});
    for (const threadId of Array.from(this.threads.keys())) {
      await this.stop(threadId);
    }
  }

  resolveModel(provider: string, modelId: string): SessionModel | undefined {
    return this.modelRuntime
      .getAvailableSnapshot()
      .find((model) => model.provider === provider && model.id === modelId);
  }

  /** Serialize per-thread mutations; keyed by the thread id at call time. */
  private runExclusive<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.threadQueues.get(threadId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.threadQueues.set(
      threadId,
      next.catch(() => {}),
    );
    return next;
  }

  private enqueueSpawn<T>(spawn: () => Promise<T>): Promise<T> {
    const next = this.spawnQueue.then(spawn, spawn);
    this.spawnQueue = next.catch(() => {});
    return next;
  }

  private assertNotOpen(resolvedPath: string): void {
    for (const thread of this.threads.values()) {
      if (
        thread.session.sessionFile !== undefined &&
        resolve(thread.session.sessionFile) === resolvedPath
      ) {
        throw new Error(
          `Session already open in this pai-cli process (threadId: ${thread.session.sessionId}); ` +
            "two writers would corrupt the session file",
        );
      }
    }
    if (this.spawningPaths.has(resolvedPath)) {
      throw new Error(
        "Session is currently being opened in this pai-cli process; retry after the first resume settles",
      );
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
            // Extensions are arbitrary code. Untrusted threads load only
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
      // file is flushed and nothing leaks past stopAll.
      await runtime.dispose();
      this.onThreadDisposed?.(session.sessionId);
      throw new Error("pai-cli is shutting down");
    }

    const thread: Thread = {
      runtime,
      session,
      cwd: options.cwd,
      sessionPath: session.sessionFile,
      unsubscribe: () => {},
    };

    // fork/clone replaces the session inside the runtime; rebind swaps the
    // subscription, re-keys the map, and re-binds extensions. The thread's
    // id becomes the new session's id (design.md "threadId 语义修订").
    runtime.setRebindSession(async (replacement) => {
      thread.unsubscribe();
      this.threads.delete(thread.session.sessionId);
      thread.session = replacement;
      thread.sessionPath = replacement.sessionFile;
      thread.unsubscribe = replacement.subscribe((event: AgentSessionEvent) => {
        this.emit({ type: "event", threadId: replacement.sessionId, event: toWireEvent(event) });
      });
      this.threads.set(replacement.sessionId, thread);
      await replacement.bindExtensions({
        uiContext: this.createUi(replacement.sessionId),
        mode: "rpc",
      });
    });

    thread.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      this.emit({ type: "event", threadId: session.sessionId, event: toWireEvent(event) });
    });
    await session.bindExtensions({ uiContext: this.createUi(session.sessionId), mode: "rpc" });
    this.threads.set(session.sessionId, thread);
    return thread;
  }
}
