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
import { createPermissionGate } from "./permission-gate.ts";
import type { HubFrame, SessionModel } from "./protocol.ts";
import { SessionDestroyedError } from "./session-destroyed-error.ts";
import { copySidecarRules } from "./sidecar-rules.ts";

export interface Thread {
  runtime: AgentSessionRuntime;
  /** Current session; replaced (and re-bound) on fork/clone. */
  session: AgentSession;
  cwd: string;
  sessionPath: string | undefined;
  unsubscribe: () => void;
}

export type UiContextFactory = (threadId: string) => ExtensionUIContext;

export interface SessionHostOptions {
  modelRuntime: ModelRuntime;
  emit: (frame: HubFrame) => void;
  createUi: UiContextFactory;
  onThreadDisposed?: (threadId: string) => void;
  /** Diagnostics sink (worker stderr); used for best-effort degradation notes. */
  writeStderr?: (text: string) => void;
}

/**
 * Streaming events carry cumulative snapshots (message + the partial
 * assistant message inside each delta) that pi's RPC mode strips before
 * serialization; frame size must stay constant per delta, otherwise long
 * replies amplify to quadratic wire traffic. Top-level usage is kept.
 */
export function toWireEvent(event: AgentSessionEvent): AgentSessionEvent {
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

/** Official two-stage factory: services (resource loader, settings, shared
 * model runtime) then the session bound to the passed manager — the runtime
 * calls this again on fork/switch with a fresh manager. */
function makeRuntimeFactory(deps: {
  modelRuntime: ModelRuntime;
  trusted: boolean;
  model: SessionModel | undefined;
  threadIdRef: ThreadIdRef;
}): CreateAgentSessionRuntimeFactory {
  const { modelRuntime, trusted, model, threadIdRef } = deps;
  return async (factoryOptions) => {
    const services = await createAgentSessionServices({
      cwd: factoryOptions.cwd,
      agentDir: factoryOptions.agentDir,
      modelRuntime,
      resourceLoaderOptions: {
        // Extensions are arbitrary code. Untrusted sessions load only the
        // built-in permission gate; skills/prompts/context stay available
        // because they are data, not code.
        ...(trusted ? {} : { noExtensions: true }),
        extensionFactories: [createPermissionGate(() => threadIdRef.id)],
      },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: factoryOptions.sessionManager,
      ...(factoryOptions.sessionStartEvent !== undefined
        ? { sessionStartEvent: factoryOptions.sessionStartEvent }
        : {}),
      ...(model !== undefined ? { model } : {}),
    });
    return { ...created, services, diagnostics: [] };
  };
}

/**
 * The session id is unknown while the runtime factory runs (it exists only
 * after session creation) and changes on every session replacement, so the
 * gate reads it through this mutable ref.
 */
export interface ThreadIdRef {
  id: string;
}

/** Subscribe to session events and register the fork/clone rebind closure:
 * replacement swaps the subscription in place, the thread's id becomes the
 * new session's id (the host updates its routing from the response), and the
 * permission-rule sidecar follows the conversation to the new id. */
function bindThread(deps: {
  thread: Thread;
  emit: (frame: HubFrame) => void;
  createUi: UiContextFactory;
  threadIdRef: ThreadIdRef;
  writeStderr: (text: string) => void;
}): Promise<void> {
  const { thread, emit, createUi, threadIdRef, writeStderr } = deps;
  const { runtime, session } = thread;
  runtime.setRebindSession(async (replacement) => {
    const previousId = thread.session.sessionId;
    thread.unsubscribe();
    thread.session = replacement;
    thread.sessionPath = replacement.sessionFile;
    thread.unsubscribe = replacement.subscribe((event: AgentSessionEvent) => {
      emit({ type: "event", threadId: replacement.sessionId, event: toWireEvent(event) });
    });
    threadIdRef.id = replacement.sessionId;
    // fork/clone (and any other id-changing replacement): rules follow.
    // Best-effort — the replacement is already applied inside pi, so a
    // copy failure degrades to the global rules with a note, never
    // aborts the rebind half-way.
    if (
      replacement.sessionId !== previousId &&
      !copySidecarRules(previousId, replacement.sessionId)
    ) {
      writeStderr(
        `pai-cli could not copy permission rules across the session replacement (${previousId} -> ${replacement.sessionId}); falling back to the global rules\n`,
      );
    }
    await replacement.bindExtensions({
      uiContext: createUi(replacement.sessionId),
      mode: "rpc",
    });
  });
  thread.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    emit({ type: "event", threadId: session.sessionId, event: toWireEvent(event) });
  });
  threadIdRef.id = session.sessionId;
  return session.bindExtensions({ uiContext: createUi(session.sessionId), mode: "rpc" });
}

export class SessionHost {
  private thread: Thread | undefined;
  private readonly options: SessionHostOptions;
  /** Current session id for the permission gate (set on bind/rebind). */
  private readonly threadIdRef: ThreadIdRef = { id: "" };
  /** Serializes session-replacing operations (fork/clone/stop). */
  private replacementQueue: Promise<unknown> = Promise.resolve();
  /** Spawn in flight, so shutdown can wait for it and start can reject doubles. */
  private spawning = false;
  private currentSpawn: Promise<unknown> | undefined;
  private closed = false;

  constructor(options: SessionHostOptions) {
    this.options = options;
  }

  get(): Thread | undefined {
    return this.thread;
  }

  async start(options: { cwd: string; trusted: boolean; model?: SessionModel }): Promise<Thread> {
    if (this.thread !== undefined || this.spawning) {
      throw this.oneSessionError();
    }
    return this.runSpawn(() =>
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
    sessionPath: string;
  }): Promise<Thread> {
    if (this.thread !== undefined || this.spawning) {
      throw this.oneSessionError();
    }
    return this.runSpawn(() => {
      const sessionPath = resolve(options.sessionPath);
      const sessionManager = SessionManager.open(sessionPath);
      // Default cwd comes from the session header, not the worker cwd:
      // resumed tools must operate where the conversation started.
      const cwd = options.cwd ?? sessionManager.getCwd();
      return this.spawn({ cwd, trusted: options.trusted, sessionManager, spawnPath: sessionPath });
    });
  }

  /**
   * Fork from a historical entry. On success the runtime replaced the
   * session in place; resolves the thread under its new session id.
   * `expectedThreadId` is validated INSIDE the serialized task: a second
   * fork queued behind a re-keying first fork must fail on the stale id
   * instead of forking the replacement session (v0.3 defensive behavior).
   */
  async fork(
    expectedThreadId: string,
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
      this.assertThreadId(thread, expectedThreadId);
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
  async clone(expectedThreadId: string): Promise<{
    thread: Thread;
    previousThreadId: string;
    cancelled: boolean;
  }> {
    return this.runReplacement(async () => {
      const thread = this.requireSession();
      this.assertThreadId(thread, expectedThreadId);
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
      const { thread } = this;
      if (!thread) return;
      const threadId = thread.session.sessionId;
      this.thread = undefined;
      thread.unsubscribe();
      await thread.runtime.dispose();
      this.options.onThreadDisposed?.(threadId);
    });
  }

  /** Worker shutdown: wait for any in-flight spawn, then stop the session. */
  async dispose(): Promise<void> {
    this.closed = true;
    await this.currentSpawn?.catch(() => {});
    await this.stop();
  }

  private oneSessionError(): Error {
    return new Error("Worker already hosts a conversation; one session per worker process");
  }

  private async runSpawn(spawn: () => Promise<Thread>): Promise<Thread> {
    this.spawning = true;
    const pending = spawn();
    this.currentSpawn = pending;
    try {
      return await pending;
    } finally {
      this.spawning = false;
      this.currentSpawn = undefined;
    }
  }

  private requireSession(): Thread {
    const { thread } = this;
    if (!thread) throw new Error("No active session in this worker");
    return thread;
  }

  /** Executed inside the replacement queue: the id the command addressed
   * must still be the live session's id at execution time. */
  private assertThreadId(thread: Thread, expectedThreadId: string): void {
    if (thread.session.sessionId !== expectedThreadId) {
      throw new Error(`Unknown threadId: ${expectedThreadId}`);
    }
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
    const runtime = await createAgentSessionRuntime(
      makeRuntimeFactory({
        modelRuntime: this.options.modelRuntime,
        trusted: options.trusted,
        model: options.model,
        threadIdRef: this.threadIdRef,
      }),
      {
        cwd: options.cwd,
        agentDir: getAgentDir(),
        sessionManager: options.sessionManager,
      },
    );
    const { session } = runtime;

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
    await bindThread({
      thread,
      emit: this.options.emit,
      createUi: this.options.createUi,
      threadIdRef: this.threadIdRef,
      writeStderr: this.options.writeStderr ?? (() => {}),
    });
    this.thread = thread;
    return thread;
  }
}
