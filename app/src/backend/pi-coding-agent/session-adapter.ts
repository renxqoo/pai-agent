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
  type InlineExtension,
  type ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createPermissionGate, effectiveRules } from "./permission-gate.ts";
import {
  type SandboxGateState,
  createSandboxGate,
  freshExemptions,
  snapshotSandboxConfig,
} from "./sandbox-gate.ts";
import { stripCumulativeSnapshot } from "../ports/event-strip.ts";
import type { PaiEvent } from "../../protocol.ts";
import type { SpawnShaping } from "../ports/session.ts";
import type { PermissionRules } from "../../rules.ts";
import type { HubFrame, SessionModel } from "../../protocol.ts";
import { SessionDestroyedError } from "../../session-destroyed-error.ts";
import { copySidecarRules } from "../../sidecar-rules.ts";

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
  /**
   * Extra built-in extensions, called per spawn with the spawn's trust flag
   * and — for grandchild spawns — the subagent shaping (stages 8/9: the
   * worker returns the depth-1 communication tools instead of the task
   * tool; the task tool never exists inside a grandchild).
   */
  createExtensions?: (spawn: {
    trusted: boolean;
    subagent: boolean;
    subagentId?: string;
    agentName?: string;
  }) => InlineExtension[];
}

/** Subagent shaping of a spawn (plan §3.2 internal thread/start fields).
 * thinkingLevel matches pi's ThinkingLevel union (protocol's level type). */

/**
 * Streaming events carry cumulative snapshots (message + the partial
 * assistant message inside each delta) that pi's RPC mode strips before
 * serialization; frame size must stay constant per delta, otherwise long
 * replies amplify to quadratic wire traffic. Top-level usage is kept.
 */

/** Session-shaping extras (tool allowlist, thinking level). */
function shapingOptions(shaping: SpawnShaping | undefined): Record<string, unknown> {
  if (shaping === undefined) return {};
  return {
    ...(shaping.tools !== undefined ? { tools: shaping.tools } : {}),
    ...(shaping.thinkingLevel !== undefined ? { thinkingLevel: shaping.thinkingLevel } : {}),
  };
}

/** Loader options shared by every spawn of this factory (trust + shaping). */
function resourceOptionsFor(
  deps: { trusted: boolean; shaping: SpawnShaping | undefined },
  base: { cwd: string; extensionFactories: InlineExtension[] },
) {
  const { trusted, shaping } = deps;
  return {
    ...(trusted ? {} : { noExtensions: true }),
    extensionFactories: base.extensionFactories,
    ...(shaping?.systemPrompt !== undefined ? { systemPrompt: shaping.systemPrompt } : {}),
  };
}

/** Official two-stage factory: services (resource loader, settings, shared
 * model runtime) then the session bound to the passed manager — the runtime
 * calls this again on fork/switch with a fresh manager. Subagent shaping
 * (system prompt, tool allowlist, injected rules, depth-1) applies here. */
/** Host callback adding worker-owned extensions per spawn (task tool or the
 * grandchild communication tools). */
type CreateExtensionsFn = (spawn: {
  trusted: boolean;
  subagent: boolean;
  subagentId?: string;
  agentName?: string;
}) => InlineExtension[];

function makeRuntimeFactory(deps: {
  modelRuntime: ModelRuntime;
  trusted: boolean;
  model: SessionModel | undefined;
  threadIdRef: ThreadIdRef;
  shaping: SpawnShaping | undefined;
  sandboxState: SandboxGateState;
  writeStderr: (text: string) => void;
  createExtensions: CreateExtensionsFn | undefined;
}): CreateAgentSessionRuntimeFactory {
  const { trusted, model, threadIdRef, shaping, createExtensions } = deps;
  return async (factoryOptions) => {
    const services = await createAgentSessionServices({
      cwd: factoryOptions.cwd,
      agentDir: factoryOptions.agentDir,
      modelRuntime: deps.modelRuntime,
      // Extensions are arbitrary code. Untrusted sessions load only the
      // built-in gates (permission + sandbox, and the task tool, which is
      // built-in); skills/prompts/context stay available — data, not code.
      resourceLoaderOptions: resourceOptionsFor(deps, {
        cwd: factoryOptions.cwd,
        extensionFactories: spawnExtensions({
          trusted,
          threadIdRef,
          shaping,
          cwd: factoryOptions.cwd,
          sandboxState: deps.sandboxState,
          writeStderr: deps.writeStderr,
          createExtensions,
        }),
      }),
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: factoryOptions.sessionManager,
      ...(factoryOptions.sessionStartEvent !== undefined
        ? { sessionStartEvent: factoryOptions.sessionStartEvent }
        : {}),
      ...(model !== undefined ? { model } : {}),
      ...shapingOptions(shaping),
    });
    return { ...created, services, diagnostics: [] };
  };
}

/** Sandbox gate wiring: grandchildren additionally protect the parent
 * conversation's project sandbox file (batch-2 review P3) and never
 * escalate confirmable violations to dialogs (v0.10 fail-closed). */
function sandboxGateDeps(factory: {
  trusted: boolean;
  cwd: string;
  sandboxState: SandboxGateState;
  writeStderr: (text: string) => void;
  shaping: SpawnShaping | undefined;
}) {
  const { trusted, cwd, sandboxState, writeStderr, shaping } = factory;
  return {
    trusted,
    cwd,
    state: sandboxState,
    writeStderr,
    ...(shaping?.subagent === true ? { subagent: true } : {}),
    ...(shaping?.parentProtectedPaths !== undefined
      ? { parentProtectedPaths: shaping.parentProtectedPaths }
      : {}),
  };
}

/** Permission gate + built-in extensions for one spawn. Subagent spawns
 * reach this too (stages 8/9): the worker's callback swaps the task tool
 * for the depth-1 communication tools. */
function spawnExtensions(factory: {
  trusted: boolean;
  threadIdRef: ThreadIdRef;
  shaping: SpawnShaping | undefined;
  cwd: string;
  sandboxState: SandboxGateState;
  writeStderr: (text: string) => void;
  createExtensions:
    | ((spawn: {
        trusted: boolean;
        subagent: boolean;
        subagentId?: string;
        agentName?: string;
      }) => InlineExtension[])
    | undefined;
}): InlineExtension[] {
  const { trusted, threadIdRef, shaping, cwd, sandboxState, writeStderr, createExtensions } =
    factory;
  const permissionThreadId = shaping?.permissionThreadId;
  const extensions: InlineExtension[] = [
    createPermissionGate(
      () => threadIdRef.id,
      // Grandchild gate: re-read the parent conversation's ruleset on
      // every decision (review B-P2-5) — never a frozen snapshot.
      permissionThreadId === undefined ? undefined : () => effectiveRules(permissionThreadId),
      cwd,
    ),
    // Second defense line, layered AFTER the advisory gate (physical/hard
    // policy). Inline for every thread incl. grandchildren (restrict-only).
    createSandboxGate(sandboxGateDeps({ trusted, cwd, sandboxState, writeStderr, shaping })),
  ];
  if (createExtensions !== undefined) {
    extensions.push(
      ...createExtensions({
        trusted,
        subagent: shaping?.subagent === true,
        ...(shaping?.subagentId !== undefined ? { subagentId: shaping.subagentId } : {}),
        ...(shaping?.agentName !== undefined ? { agentName: shaping.agentName } : {}),
      }),
    );
  }
  return extensions;
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
/** The fork/clone rebind closure: swap the session in place, re-point the
 * subscription and the id ref, and copy the permission sidecar across
 * (best-effort; failure degrades to the global rules with a note). */
async function rebindThread(deps: {
  thread: Thread;
  replacement: AgentSession;
  emit: (frame: HubFrame) => void;
  createUi: UiContextFactory;
  threadIdRef: ThreadIdRef;
  writeStderr: (text: string) => void;
}): Promise<void> {
  const { thread, replacement, emit, createUi, threadIdRef, writeStderr } = deps;
  const previousId = thread.session.sessionId;
  thread.unsubscribe();
  thread.session = replacement;
  thread.sessionPath = replacement.sessionFile;
  thread.unsubscribe = replacement.subscribe((event: AgentSessionEvent) => {
    // Adapter lift: strip the cumulative snapshot, then hand the pai-owned
    // wire vocabulary the (structurally compatible) pi event.
    emit({
      type: "event",
      threadId: replacement.sessionId,
      event: stripCumulativeSnapshot(event) as PaiEvent,
    });
  });
  threadIdRef.id = replacement.sessionId;
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
}

function bindThread(deps: {
  thread: Thread;
  emit: (frame: HubFrame) => void;
  createUi: UiContextFactory;
  threadIdRef: ThreadIdRef;
  writeStderr: (text: string) => void;
}): Promise<void> {
  const { thread, emit, createUi, threadIdRef, writeStderr } = deps;
  const { runtime, session } = thread;
  runtime.setRebindSession((replacement) =>
    rebindThread({ thread, replacement, emit, createUi, threadIdRef, writeStderr }),
  );
  thread.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    emit({
      type: "event",
      threadId: session.sessionId,
      event: stripCumulativeSnapshot(event) as PaiEvent,
    });
  });
  threadIdRef.id = session.sessionId;
  return session.bindExtensions({ uiContext: createUi(session.sessionId), mode: "rpc" });
}

export class SessionHost {
  private thread: Thread | undefined;
  private readonly options: SessionHostOptions;
  /** Current session id for the permission gate (set on bind/rebind). */
  private readonly threadIdRef: ThreadIdRef = { id: "" };
  /** Sandbox snapshot + runtime state for the current session (read by
   * get_sandbox_state; mutated by the sandbox gate at factory time and
   * session_start). */
  private readonly sandboxState: SandboxGateState = {
    snapshot: snapshotSandboxConfig({ trusted: false, cwd: process.cwd(), env: {} }),
    runtime: { active: false },
    exemptions: freshExemptions(),
  };
  /** Grandchild gate anchor: the parent conversation whose ruleset is
   * re-read on every decision. */
  private permissionThreadId: string | undefined;
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

  /** Current session id for permission callers ("" before the first spawn). */
  threadId(): string {
    return this.threadIdRef.id;
  }

  /** Grandchild gate ruleset (parent's live rules; undefined for normal
   * conversations — the caller then falls back to its own threadId). */
  /** Sandbox observability: the gate keeps this current (session-scoped). */
  getSandboxState(): SandboxGateState {
    return this.sandboxState;
  }

  getInjectedRules(): PermissionRules | undefined {
    return this.permissionThreadId === undefined
      ? undefined
      : effectiveRules(this.permissionThreadId);
  }

  async start(options: {
    cwd: string;
    trusted: boolean;
    model?: SessionModel;
    shaping?: SpawnShaping;
  }): Promise<Thread> {
    if (this.thread !== undefined || this.spawning) {
      throw this.oneSessionError();
    }
    this.permissionThreadId = options.shaping?.permissionThreadId;
    return this.runSpawn(() =>
      this.spawn({
        cwd: options.cwd,
        trusted: options.trusted,
        model: options.model,
        shaping: options.shaping,
        sessionManager:
          options.shaping?.ephemeral === true
            ? SessionManager.inMemory(options.cwd)
            : SessionManager.create(options.cwd),
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
    shaping?: SpawnShaping;
    sessionManager: SessionManager;
    spawnPath: string | undefined;
  }): Promise<Thread> {
    const runtime = await createAgentSessionRuntime(
      makeRuntimeFactory({
        modelRuntime: this.options.modelRuntime,
        trusted: options.trusted,
        model: options.model,
        threadIdRef: this.threadIdRef,
        shaping: options.shaping,
        sandboxState: this.sandboxState,
        writeStderr: this.options.writeStderr ?? (() => {}),
        createExtensions: this.options.createExtensions,
      }),
      {
        cwd: options.cwd,
        agentDir: getAgentDir(),
        sessionManager: options.sessionManager,
      },
    );
    const { session } = runtime;

    // Shutdown raced this spawn: dispose so the session file is flushed.
    if (this.closed) {
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
