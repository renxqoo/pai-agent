/**
 * INTERNAL host<->worker protocol (design.md migration §3): the stdio
 * contract between the pai-cli host and its `--internal-worker` children.
 * Never on the Electron wire — the Electron-facing half lives in
 * protocol.ts. Split per the size cap; one definition each (single truth).
 */

import type { SessionModel } from "./protocol.ts";
import type {
  AbortBashCmd,
  AbortCmd,
  BashCmd,
  ClearQueueCmd,
  CloneCmd,
  CompactCmd,
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
  SetModelCmd,
  SetSessionNameCmd,
  SetThinkingLevelCmd,
  SteerCmd,
  FollowUpCmd,
  NavigateTreeCmd,
  PromptCmd,
  SubagentSteerCmd,
  ThreadResumeCmd,
  ThreadStartCmd,
  ThreadStopCmd,
  UiResponseCmd,
} from "./protocol.ts";

// ============================================================================
// INTERNAL: host <-> worker protocol (never on the Electron wire)
// ============================================================================

/** CLI flag that enters single-session worker mode. */
export const WORKER_FLAG = "--internal-worker";

/** Generation convention for host-initiated command ids. Absorption is decided
 * by membership in the host's pending-internal-id set, never by this prefix
 * (the Electron id space is unconstrained). */
export const INTERNAL_ID_PREFIX = "pai-internal-";

/** Worker heartbeat carries the worker-side truth: how long the session has
 * been idle (observer commands do not reset it), whether it is streaming,
 * the current session file path (null until first persist; the host needs
 * it to park a retired conversation), — v0.5 — the number of live
 * subagent (grandchild) processes (observability; no host quota), and —
 * v0.13 — the worker's own RSS (always present). */
export interface WorkerHeartbeatFrame {
  type: "heartbeat";
  idleMs: number;
  streaming: boolean;
  sessionPath: string | null;
  subagents?: number;
  rssBytes: number;
}

/** v0.8 INTERNAL worker→host hello (worker contract v1, docs/worker-contract.md):
 * the FIRST frame a worker writes after taking over stdout — before the
 * heartbeat timer arms. The host rejects version/backend mismatches through
 * the spawning-failure recycle path (occupancy reclaimed, pending ids
 * failed exactly once, no thread_died). */
export const WORKER_PROTOCOL_VERSION = 1;

export interface WorkerHelloFrame {
  type: "hello";
  protocolVersion: number;
  backendId: string;
  capabilities: string[];
}

/**
 * v0.6 INTERNAL worker→host grant arbitration (global running-grandchild
 * cap, PAI_MAX_SUBAGGENTS — design.md v0.6 / migration §3 addendum).
 * acquire: `{"type":"grant","id":"g-<seq>","n":1}` — host replies with an
 * internal `grant_result` command carrying the same id.
 * release: same frame with `"release":true` — no reply.
 */
export interface WorkerGrantFrame {
  type: "grant";
  id: string;
  n?: number;
  release?: boolean;
}

/** v0.6 INTERNAL host→worker grant decision (id = the grant id). The worker
 * resolves its pending acquire and replies with an absorbed ack response;
 * `running` (denials only) feeds the retryable limit-error message. */
export interface WorkerGrantResultCmd {
  type: "grant_result";
  granted: boolean;
  running?: number;
}

/** INTERNAL thread/start: host injects the resolved model object. v0.5 adds
 * the subagent extension fields (used by the task tool's grandchild spawns):
 * systemPrompt/tools/thinkingLevel shape the grandchild session,
 * permissionThreadId re-reads the parent conversation's live ruleset on
 * every gate decision (never a frozen snapshot), subagent disables the task
 * tool inside the grandchild (depth 1) and enables its communication tools
 * (report/send), subagentId/agentName label the grandchild's outgoing
 * subagent_message frames (advisory — the parent re-stamps), ephemeral runs
 * an in-memory session (the pi --no-session equivalent). */
export interface WorkerThreadStartCmd extends Omit<ThreadStartCmd, "provider" | "modelId"> {
  model?: SessionModel;
  systemPrompt?: string;
  tools?: string[];
  thinkingLevel?: SetThinkingLevelCmd["level"];
  permissionThreadId?: string;
  /** Conversation-cwd paths a grandchild must never write (sandbox P3). */
  parentProtectedPaths?: string[];
  subagent?: boolean;
  subagentId?: string;
  agentName?: string;
  ephemeral?: boolean;
}

/** INTERNAL set_model: host injects the resolved model object. */
export interface WorkerSetModelCmd extends Omit<SetModelCmd, "provider" | "modelId"> {
  model: SessionModel;
}

type ThreadScopedCmd =
  | PromptCmd
  | SteerCmd
  | FollowUpCmd
  | AbortCmd
  | CompactCmd
  | GetStateCmd
  | GetMessagesCmd
  | SetThinkingLevelCmd
  | GetThinkingLevelsCmd
  | GetEntriesCmd
  | GetTreeCmd
  | SetSessionNameCmd
  | GetSessionStatsCmd
  | ClearQueueCmd
  | ForkCmd
  | CloneCmd
  | NavigateTreeCmd
  | GetForkMessagesCmd
  | GetCommandsCmd
  | BashCmd
  | AbortBashCmd
  | ThreadResumeCmd
  | ThreadStopCmd
  | UiResponseCmd
  | SubagentSteerCmd
  | GetSandboxStateCmd;

export type WorkerCommand =
  | (WorkerThreadStartCmd & { id?: string })
  | (WorkerSetModelCmd & { id?: string })
  | (WorkerGrantResultCmd & { id?: string })
  | (ThreadScopedCmd & { id?: string });

/** Commands that do not mutate or exercise the session; they never reset the
 * worker's idle timer (a polling client must not keep workers alive). */
export const OBSERVER_COMMANDS: ReadonlySet<string> = new Set([
  "get_state",
  "get_messages",
  "get_entries",
  "get_tree",
  "get_session_stats",
  "get_commands",
  "get_fork_messages",
]);

/** Commands the host routes verbatim to the owning worker. Anything else on
 * stdin is rejected with the v0.3 "Unknown command" wording. */
export const THREAD_SCOPED_COMMANDS: ReadonlySet<string> = new Set([
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "compact",
  "get_state",
  "get_messages",
  "set_thinking_level",
  "get_thinking_levels",
  "get_entries",
  "get_tree",
  "set_session_name",
  "get_session_stats",
  "clear_queue",
  "fork",
  "clone",
  "navigate_tree",
  "get_fork_messages",
  "get_commands",
  "bash",
  "abort_bash",
  "subagent/steer",
  "get_sandbox_state",
]);
