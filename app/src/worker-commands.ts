/**
 * Worker command handlers: one function per thread-scoped command, wired
 * into a registry the worker dispatches through. Each handler receives the
 * WorkerContext plus the raw command; narrowing casts are local and named.
 */

import { toImages, validateImages } from "./images.ts";
import { handleAbortBash, handleBash } from "./bash-commands.ts";
import { selectEntriesWindow } from "./entries-window.ts";
import { toSkillPointer } from "./skill-pointer.ts";
import { tryCompactInvocation } from "./compact-invocation.ts";
import type {
  ClearQueueCmd,
  CloneCmd,
  CompactCmd,
  FollowUpCmd,
  ForkCmd,
  GetCommandsCmd,
  GetEntriesCmd,
  GetForkMessagesCmd,
  GetMessagesCmd,
  GetSandboxStateCmd,
  GetSessionStatsCmd,
  GetStateCmd,
  GetThinkingLevelsCmd,
  GetTreeCmd,
  NavigateTreeCmd,
  PromptCmd,
  SetSessionNameCmd,
  SetThinkingLevelCmd,
  SteerCmd,
  SubagentSteerCmd,
  ImagePayload,
  ThreadResumeCmd,
  UiResponseCmd,
  WorkerGrantResultCmd,
  WorkerSetModelCmd,
  WorkerThreadStartCmd,
} from "./protocol.ts";
import type { PaiThread } from "./backend/ports/session.ts";
import { startShaping } from "./backend/ports/session.ts";
import { collectCommands } from "./command-listing.ts";
import { SessionDestroyedError } from "./session-destroyed-error.ts";
import type { WorkerContext, WorkerHandler } from "./worker-context.ts";

type Handler = WorkerHandler;

function emitThreadOpened(deps: {
  ctx: WorkerContext;
  id: string | undefined;
  command: string;
  thread: PaiThread;
}): void {
  const { ctx, id, command, thread } = deps;
  ctx.success(id, command, {
    threadId: thread.session.sessionId,
    cwd: thread.cwd,
    sessionPath: thread.session.sessionFile ?? null,
  });
}

/** Shared preflight for prompt/steer/follow_up: thread lookup + image shape. */
function requireImagedThread(deps: {
  ctx: WorkerContext;
  threadId: string;
  images: ImagePayload[] | undefined;
  command: string;
  id: string | undefined;
}): PaiThread | undefined {
  const { ctx, threadId, images, command, id } = deps;
  const thread = ctx.requireThread(threadId, command, id);
  if (!thread) return undefined;
  const imagesError = validateImages(images);
  if (imagesError !== undefined) {
    ctx.failure(id, command, imagesError);
    return undefined;
  }
  return thread;
}

function emitStreamingBehaviorError(
  ctx: WorkerContext,
  behavior: string | undefined,
  id: string | undefined,
): boolean {
  if (behavior === undefined) return false;
  if (behavior !== "steer" && behavior !== "followUp") {
    ctx.failure(id, "prompt", 'streamingBehavior must be "steer" or "followUp"');
    return true;
  }
  return false;
}

/** /skill:name rewrite: pointer line instead of the worker's full-body expansion (skill-pointer.ts). */
function pointerMessage(thread: PaiThread, message: string): string {
  return toSkillPointer(message, thread.session.resourceLoader.getSkills().skills);
}

// --- lifecycle ----------------------------------------------------------------

const handleStart: Handler = async (ctx, cmd, id) => {
  const start = cmd as WorkerThreadStartCmd & { id?: string };
  const shaping = startShaping(start);
  const thread = await ctx.sessions.start({
    cwd: start.cwd ?? process.cwd(),
    trusted: start.trusted === true,
    ...(start.sandboxPosture !== undefined ? { posture: start.sandboxPosture } : {}),
    ...(start.model !== undefined ? { model: start.model } : {}),
    ...(shaping !== undefined ? { shaping } : {}),
  });
  emitThreadOpened({ ctx, id, command: "thread/start", thread });
};

const handleResume: Handler = async (ctx, cmd, id) => {
  const resume = cmd as ThreadResumeCmd & { id?: string };
  const thread = await ctx.sessions.resume({
    cwd: resume.cwd,
    trusted: resume.trusted === true,
    sessionPath: resume.sessionPath,
    ...(resume.sandboxPosture !== undefined ? { posture: resume.sandboxPosture } : {}),
  });
  emitThreadOpened({ ctx, id, command: "thread/resume", thread });
};

const handleStop: Handler = async (ctx, _cmd, id) => {
  // U2 (background plan): stopping the conversation kills every subagent.
  ctx.killSubagents();
  await ctx.sessions.stop();
  ctx.success(id, "thread/stop");
};

// --- conversation driving -------------------------------------------------------

const handlePrompt: Handler = (ctx, cmd, id) => {
  const prompt = cmd as PromptCmd & { id?: string };
  const thread = requireImagedThread({
    ctx,
    threadId: prompt.threadId,
    images: prompt.images,
    command: "prompt",
    id,
  });
  if (!thread) return Promise.resolve();
  if (emitStreamingBehaviorError(ctx, prompt.streamingBehavior, id)) return Promise.resolve();
  // v0.11: a line-start /compact never reaches the model — the hub runs the
  // compact operation instead (compact-invocation.ts; capability-gated).
  const intercepted = tryCompactInvocation({
    ctx,
    thread,
    message: prompt.message,
    images: prompt.images,
    id,
  });
  if (intercepted !== undefined) return intercepted;
  // Fire-and-accept via the SDK's preflight hook (same strategy as pi's RPC
  // mode): exactly one response at acceptance time; failures before
  // acceptance become the failure response, failures after acceptance ride
  // the event stream.
  let accepted = false;
  void thread.session
    .prompt(pointerMessage(thread, prompt.message), {
      images: toImages(prompt.images),
      ...(prompt.streamingBehavior ? { streamingBehavior: prompt.streamingBehavior } : {}),
      source: "rpc",
      preflightResult: (didSucceed: boolean) => {
        if (didSucceed) {
          accepted = true;
          ctx.success(id, "prompt");
        }
      },
    })
    .catch((error: unknown) => {
      if (!accepted) {
        ctx.failure(id, "prompt", error instanceof Error ? error.message : String(error));
      }
    });
  return Promise.resolve();
};

const handleSteer: Handler = async (ctx, cmd, id) => {
  const steer = cmd as SteerCmd & { id?: string };
  const thread = requireImagedThread({
    ctx,
    threadId: steer.threadId,
    images: steer.images,
    command: "steer",
    id,
  });
  if (!thread) return;
  await thread.session.steer(pointerMessage(thread, steer.message), toImages(steer.images));
  ctx.success(id, "steer");
};

const handleFollowUp: Handler = async (ctx, cmd, id) => {
  const followUp = cmd as FollowUpCmd & { id?: string };
  const thread = requireImagedThread({
    ctx,
    threadId: followUp.threadId,
    images: followUp.images,
    command: "follow_up",
    id,
  });
  if (!thread) return;
  await thread.session.followUp(
    pointerMessage(thread, followUp.message),
    toImages(followUp.images),
  );
  ctx.success(id, "follow_up");
};

const handleAbort: Handler = async (ctx, cmd, id) => {
  const abort = cmd as GetStateCmd & { id?: string };
  const thread = ctx.requireThread(abort.threadId, "abort", id);
  if (!thread) return;
  // U2 (background plan): an abort means the user does not want this work —
  // foreground tool signals and every background task die together.
  ctx.killSubagents();
  await thread.session.abort();
  ctx.success(id, "abort");
};

const handleCompact: Handler = async (ctx, cmd, id) => {
  const compact = cmd as CompactCmd & { id?: string };
  const thread = ctx.requireThread(compact.threadId, "compact", id);
  if (!thread) return;
  const inflight = ctx.registerInflight(() => thread.session.abortCompaction());
  try {
    const result = await thread.session.compact(compact.customInstructions);
    ctx.success(id, "compact", result);
  } finally {
    inflight.unregister();
  }
};

// --- state and history ----------------------------------------------------------

const handleGetState: Handler = (ctx, cmd, id) => {
  const state = cmd as GetStateCmd & { id?: string };
  const thread = ctx.requireThread(state.threadId, "get_state", id);
  if (!thread) return Promise.resolve();
  const { session } = thread;
  ctx.success(id, "get_state", {
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    sessionId: session.sessionId,
    sessionName: session.sessionName ?? null,
    sessionFile: session.sessionFile ?? null,
    messageCount: session.messages.length,
  });
  return Promise.resolve();
};

const handleGetMessages: Handler = (ctx, cmd, id) => {
  const messages = cmd as GetMessagesCmd & { id?: string };
  const thread = ctx.requireThread(messages.threadId, "get_messages", id);
  if (!thread) return Promise.resolve();
  ctx.success(id, "get_messages", { messages: thread.session.messages });
  return Promise.resolve();
};

const handleSetModel: Handler = async (ctx, cmd, id) => {
  const setModel = cmd as WorkerSetModelCmd & { id?: string };
  const thread = ctx.requireThread(setModel.threadId, "set_model", id);
  if (!thread) return;
  // Model was resolved by the host against its always-fresh snapshot
  // (design.md migration §1); the worker applies it as-is.
  await thread.session.setModel(setModel.model);
  ctx.success(id, "set_model", { model: setModel.model });
};

const handleSetThinkingLevel: Handler = (ctx, cmd, id) => {
  const level = cmd as SetThinkingLevelCmd & { id?: string };
  const thread = ctx.requireThread(level.threadId, "set_thinking_level", id);
  if (!thread) return Promise.resolve();
  thread.session.setThinkingLevel(level.level);
  ctx.success(id, "set_thinking_level");
  return Promise.resolve();
};

const handleGetThinkingLevels: Handler = (ctx, cmd, id) => {
  const levels = cmd as GetThinkingLevelsCmd & { id?: string };
  const thread = ctx.requireThread(levels.threadId, "get_thinking_levels", id);
  if (!thread) return Promise.resolve();
  ctx.success(id, "get_thinking_levels", { levels: thread.session.getAvailableThinkingLevels() });
  return Promise.resolve();
};

const handleGetEntries: Handler = async (ctx, cmd, id) => {
  const entries = cmd as GetEntriesCmd & { id?: string };
  const thread = ctx.requireThread(entries.threadId, "get_entries", id);
  if (!thread) return;
  const { sessionManager } = thread.session;
  const window = selectEntriesWindow(sessionManager.getEntries(), entries);
  if (!window.ok) return void ctx.failure(id, "get_entries", window.error);
  ctx.success(id, "get_entries", {
    entries: window.entries,
    leafId: sessionManager.getLeafId(),
    hasMore: window.hasMore,
  });
};

const handleGetTree: Handler = (ctx, cmd, id) => {
  const tree = cmd as GetTreeCmd & { id?: string };
  const thread = ctx.requireThread(tree.threadId, "get_tree", id);
  if (!thread) return Promise.resolve();
  const { sessionManager } = thread.session;
  ctx.success(id, "get_tree", {
    tree: sessionManager.getTree(),
    leafId: sessionManager.getLeafId(),
  });
  return Promise.resolve();
};

const handleSetSessionName: Handler = (ctx, cmd, id) => {
  const name = cmd as SetSessionNameCmd & { id?: string };
  const thread = ctx.requireThread(name.threadId, "set_session_name", id);
  if (!thread) return Promise.resolve();
  const trimmed = name.name.trim();
  if (trimmed.length === 0) {
    ctx.failure(id, "set_session_name", "Session name cannot be empty");
    return Promise.resolve();
  }
  thread.session.setSessionName(trimmed);
  ctx.success(id, "set_session_name");
  return Promise.resolve();
};

const handleGetSessionStats: Handler = (ctx, cmd, id) => {
  const stats = cmd as GetSessionStatsCmd & { id?: string };
  const thread = ctx.requireThread(stats.threadId, "get_session_stats", id);
  if (!thread) return Promise.resolve();
  ctx.success(id, "get_session_stats", thread.session.getSessionStats());
  return Promise.resolve();
};

const handleClearQueue: Handler = (ctx, cmd, id) => {
  const clear = cmd as ClearQueueCmd & { id?: string };
  const thread = ctx.requireThread(clear.threadId, "clear_queue", id);
  if (!thread) return Promise.resolve();
  ctx.success(id, "clear_queue", thread.session.clearQueue());
  return Promise.resolve();
};

// --- session tree / forking -----------------------------------------------------

const handleFork: Handler = async (ctx, cmd, id) => {
  const fork = cmd as ForkCmd & { id?: string };
  const thread = ctx.requireThread(fork.threadId, "fork", id);
  if (!thread) return;
  let forkError: string | undefined;
  let result:
    | {
        thread: PaiThread;
        previousThreadId: string;
        selectedText?: string;
        cancelled: boolean;
      }
    | undefined;
  try {
    result = await ctx.sessions.fork(fork.threadId, fork.entryId, fork.position ?? "before");
  } catch (error) {
    if (error instanceof SessionDestroyedError) {
      // Teardown already disposed the session (migration.md F-1): the
      // thread cannot continue. Fail the command, then exit — the host
      // turns this into thread_died.
      ctx.failure(id, "fork", error.message);
      ctx.triggerShutdown("session destroyed by failed fork");
      return;
    }
    forkError = error instanceof Error ? error.message : String(error);
  }
  if (forkError !== undefined || result === undefined) {
    ctx.failure(id, "fork", forkError ?? "fork failed");
    return;
  }
  ctx.success(id, "fork", {
    threadId: result.thread.session.sessionId,
    previousThreadId: result.previousThreadId,
    sessionPath: result.thread.session.sessionFile ?? null,
    text: result.selectedText ?? null,
    cancelled: result.cancelled,
  });
};

const handleClone: Handler = async (ctx, cmd, id) => {
  const clone = cmd as CloneCmd & { id?: string };
  const thread = ctx.requireThread(clone.threadId, "clone", id);
  if (!thread) return;
  let cloneError: string | undefined;
  let result: { thread: PaiThread; previousThreadId: string; cancelled: boolean } | undefined;
  try {
    result = await ctx.sessions.clone(clone.threadId);
  } catch (error) {
    if (error instanceof SessionDestroyedError) {
      ctx.failure(id, "clone", error.message);
      ctx.triggerShutdown("session destroyed by failed clone");
      return;
    }
    cloneError = error instanceof Error ? error.message : String(error);
  }
  if (cloneError !== undefined || result === undefined) {
    ctx.failure(id, "clone", cloneError ?? "clone failed");
    return;
  }
  ctx.success(id, "clone", {
    threadId: result.thread.session.sessionId,
    previousThreadId: result.previousThreadId,
    sessionPath: result.thread.session.sessionFile ?? null,
    cancelled: result.cancelled,
  });
};

const handleNavigateTree: Handler = async (ctx, cmd, id) => {
  const navigate = cmd as NavigateTreeCmd & { id?: string };
  const thread = ctx.requireThread(navigate.threadId, "navigate_tree", id);
  if (!thread) return;
  const result = await thread.session.navigateTree(navigate.targetId, {
    ...(navigate.summarize !== undefined ? { summarize: navigate.summarize } : {}),
    ...(navigate.customInstructions !== undefined
      ? { customInstructions: navigate.customInstructions }
      : {}),
    ...(navigate.replaceInstructions !== undefined
      ? { replaceInstructions: navigate.replaceInstructions }
      : {}),
    ...(navigate.label !== undefined ? { label: navigate.label } : {}),
  });
  ctx.success(id, "navigate_tree", result);
};

const handleGetForkMessages: Handler = (ctx, cmd, id) => {
  const forkMessages = cmd as GetForkMessagesCmd & { id?: string };
  const thread = ctx.requireThread(forkMessages.threadId, "get_fork_messages", id);
  if (!thread) return Promise.resolve();
  ctx.success(id, "get_fork_messages", {
    messages: thread.session.getUserMessagesForForking(),
  });
  return Promise.resolve();
};

const handleGetCommands: Handler = (ctx, cmd, id) => {
  const commands = cmd as GetCommandsCmd & { id?: string };
  const thread = ctx.requireThread(commands.threadId, "get_commands", id);
  if (!thread) return Promise.resolve();
  ctx.success(id, "get_commands", { commands: collectCommands(thread, ctx.capabilities) });
  return Promise.resolve();
};

/** Stage 7: client-facing steer into a running grandchild (same pipeline as
 * the model's task_steer tool; the registry owns the not-running wording). */
const handleSubagentSteer: Handler = async (ctx, cmd, id) => {
  const steer = cmd as SubagentSteerCmd & { id?: string };
  const thread = ctx.requireThread(steer.threadId, "subagent/steer", id);
  if (!thread) return;
  if (typeof steer.message !== "string" || steer.message.length === 0) {
    ctx.failure(id, "subagent/steer", "message must be a non-empty string");
    return;
  }
  if (typeof steer.subagentId !== "string" || steer.subagentId.length === 0) {
    ctx.failure(id, "subagent/steer", "subagentId must be a non-empty string");
    return;
  }
  const outcome = await ctx.steerSubagent(steer.subagentId, steer.message);
  if (outcome === true) {
    ctx.success(id, "subagent/steer", { subagentId: steer.subagentId, steered: true });
    return;
  }
  ctx.failure(id, "subagent/steer", typeof outcome === "string" ? outcome : "subagent is gone");
};

const handleUiResponse: Handler = (ctx, cmd, id) => {
  const uiResponse = cmd as UiResponseCmd & { id?: string };
  // Subagent-relayed dialogs first (their requestIds never collide with the
  // broker's): routed into the grandchild, one ack either way.
  if (!ctx.routeSubagentUi(uiResponse.requestId, uiResponse.payload)) {
    ctx.broker.resolve(uiResponse.requestId, uiResponse.payload);
  }
  ctx.success(id, "ui_response");
  return Promise.resolve();
};

/** Registry the worker dispatches through; keys are the command `type`s. */
/** v2 (plan 2026-09-10-sandbox-v2.md §4.6): the conversation's sandbox
 * snapshot + OS-runtime state + coarse session grants. */
const handleGetSandboxState: Handler = async (ctx, cmd, id) => {
  const query = cmd as GetSandboxStateCmd;
  const thread = ctx.requireThread(query.threadId, "get_sandbox_state", id);
  if (!thread) return;
  const state = ctx.sessions.getSandboxState();
  ctx.success(id, "get_sandbox_state", {
    enabled: state.snapshot.config.enabled,
    posture: state.snapshot.config.posture,
    platform: process.platform,
    ...(state.runtime.degraded !== undefined ? { degraded: state.runtime.degraded } : {}),
    network: state.snapshot.config.network,
    filesystem: state.snapshot.config.filesystem,
    grants: state.snapshot.config.grants,
    credentials: { maskEnvVars: state.snapshot.config.credentials.maskEnvVars },
    source: state.snapshot.source,
    ...(state.runtime.active ? { bashSandboxed: true } : { bashSandboxed: false }),
    onViolation: state.snapshot.config.onViolation,
    sessionGrants: {
      writeDirs: [...state.grants.writeDirs],
      writePatterns: [...state.grants.writePatterns],
      domains: [...state.grants.domains],
      bashPrefixes: [...state.grants.bashPrefixes],
    },
  });
};

/** INTERNAL v0.6 grant decision from the host: wake the pending acquire by
 * grant id (the command id doubles as the grant id) and ack — the host
 * absorbs this response via its internal-waiter mechanism. */
const handleGrantResult: Handler = async (ctx, cmd, id) => {
  const grant = cmd as WorkerGrantResultCmd & { id?: string };
  ctx.resolveGrant(id ?? "", grant.granted === true, grant.running);
  ctx.success(id, "grant_result", { granted: grant.granted === true });
};

export const workerHandlers: ReadonlyMap<string, Handler> = new Map<string, Handler>(
  Object.entries({
    "thread/start": handleStart,
    "thread/resume": handleResume,
    "thread/stop": handleStop,
    prompt: handlePrompt,
    steer: handleSteer,
    follow_up: handleFollowUp,
    abort: handleAbort,
    compact: handleCompact,
    get_state: handleGetState,
    get_messages: handleGetMessages,
    set_model: handleSetModel,
    set_thinking_level: handleSetThinkingLevel,
    get_thinking_levels: handleGetThinkingLevels,
    get_entries: handleGetEntries,
    get_tree: handleGetTree,
    set_session_name: handleSetSessionName,
    get_session_stats: handleGetSessionStats,
    clear_queue: handleClearQueue,
    fork: handleFork,
    clone: handleClone,
    navigate_tree: handleNavigateTree,
    get_fork_messages: handleGetForkMessages,
    get_commands: handleGetCommands,
    bash: handleBash,
    abort_bash: handleAbortBash,
    grant_result: handleGrantResult,
    get_sandbox_state: handleGetSandboxState,
    "subagent/steer": handleSubagentSteer,
    ui_response: handleUiResponse,
  }),
);
