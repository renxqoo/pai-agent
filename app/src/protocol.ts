/**
 * pai-cli protocol types.
 *
 * Wire format: JSONL over stdio, LF is the only record delimiter.
 * - Electron -> host (stdin): commands with optional `id` for correlation
 * - host -> Electron (stdout): responses (`id` echoes the command), events
 *   (tagged with `threadId`), dialog requests, heartbeat, thread_died
 *
 * Two protocol layers live here: the public Electron-facing v0.3+v0.4 shapes,
 * and the internal host<->worker shapes (marked INTERNAL; they never appear
 * on the Electron wire).
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { PermissionRules } from "./rules.ts";

export interface ImagePayload {
  type: "image";
  data: string;
  mimeType: string;
}

/** v0.8: pai-owned session model type. pi-ai is pai's direct dependency and
 * the shared currency of every backend (both upstreams speak pi-ai models). */
export type SessionModel = Model<Api>;

// ============================================================================
// Event vocabulary (v0.8: pai-owned, closed name set)
// ============================================================================

/** v0.8: the closed event-name set pai claims and guarantees on the wire
 * (design.md v0.8; lifted 1:1 from the pi session event vocabulary, A-2
 * enumeration). Events whose names are NOT in this set pass through the
 * host verbatim — the wire is never filtered by this list; upstream
 * vocabulary drift surfaces as unknown members clients must tolerate. */
export const PAI_EVENT_NAMES = [
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "bash_execution_update",
] as const;

export type PaiEventName = (typeof PAI_EVENT_NAMES)[number];

/** Members whose payloads the pai contract documents structurally. */
export interface PaiMessageUpdateEvent {
  type: "message_update";
  /** Delta envelope; the cumulative snapshot is stripped before the wire. */
  assistantMessageEvent?: unknown;
}

export interface PaiAgentEndEvent {
  type: "agent_end";
  messages: unknown[];
  willRetry?: boolean;
}

export interface PaiQueueUpdateEvent {
  type: "queue_update";
  steering: readonly string[];
  followUp: readonly string[];
}

export interface PaiBashExecutionUpdateEvent {
  type: "bash_execution_update";
  id?: string;
  delta: string;
}

/** The wire event: closed name vocabulary; payloads pai does not constrain
 * ride along verbatim (unknown — the wire is JSON; backend adapters lift
 * their native events into this shape at the adapter boundary). */
export type PaiEvent =
  | PaiMessageUpdateEvent
  | PaiAgentEndEvent
  | PaiQueueUpdateEvent
  | PaiBashExecutionUpdateEvent
  | {
      type: Exclude<
        PaiEventName,
        "message_update" | "agent_end" | "queue_update" | "bash_execution_update"
      >;
    };

// ============================================================================
// Commands (stdin, Electron -> host)
// ============================================================================

export interface ThreadStartCmd {
  type: "thread/start";
  /** Working directory for the conversation. Defaults to the pai-cli process cwd. */
  cwd?: string;
  /** Initial model. Requires both provider and modelId. */
  provider?: string;
  modelId?: string;
  /** Trust project-local `.pi` extensions for this thread. Extensions are
   * arbitrary code; untrusted threads load only the built-in permission
   * gate. Defaults to false. */
  trusted?: boolean;
}

export interface ThreadResumeCmd {
  type: "thread/resume";
  /** Session file to resume. */
  sessionPath: string;
  cwd?: string;
  trusted?: boolean;
}

/** v0.12 thread/register: admit a session file as a parked entry WITHOUT a
 * worker — the read shortcut (get_entries/get_state direct read) needs a
 * table entry, and cold-start hosts have an empty table (clients reconcile
 * from list_saved without resuming). Idempotent per session path/thread id. */
export interface ThreadRegisterCmd {
  type: "thread/register";
  sessionPath: string;
  trusted?: boolean;
}

export interface ThreadStopCmd {
  type: "thread/stop";
  threadId: string;
}

export interface ThreadListCmd {
  type: "thread/list";
}

export interface ThreadListSavedCmd {
  type: "thread/list_saved";
  cwd?: string;
}

export interface PromptCmd {
  type: "prompt";
  threadId: string;
  message: string;
  /** Required when the thread is already streaming: "steer" or "followUp". */
  streamingBehavior?: "steer" | "followUp";
  images?: ImagePayload[];
}

export interface SteerCmd {
  type: "steer";
  threadId: string;
  message: string;
  images?: ImagePayload[];
}

export interface FollowUpCmd {
  type: "follow_up";
  threadId: string;
  message: string;
  images?: ImagePayload[];
}

export interface AbortCmd {
  type: "abort";
  threadId: string;
}

export interface CompactCmd {
  type: "compact";
  threadId: string;
  customInstructions?: string;
}

export interface GetStateCmd {
  type: "get_state";
  threadId: string;
}

export interface GetMessagesCmd {
  type: "get_messages";
  threadId: string;
}

export interface SetModelCmd {
  type: "set_model";
  threadId: string;
  provider: string;
  modelId: string;
}

export interface GetModelsCmd {
  type: "get_models";
}

/** v0.9: persist per-model overrides (models.json modelOverrides) and hot
 * refresh the host snapshot. `null` clears one field; `remove` deletes the
 * whole override entry (idempotent). */
export interface SetModelOverrideCmd {
  type: "set_model_override";
  provider: string;
  modelId: string;
  contextWindow?: number | null;
  maxTokens?: number | null;
  remove?: boolean;
}

export interface SetThinkingLevelCmd {
  type: "set_thinking_level";
  threadId: string;
  level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface GetThinkingLevelsCmd {
  type: "get_thinking_levels";
  threadId: string;
}

/** List configured provider credentials (never includes the key itself). */
export interface AuthListCmd {
  type: "auth/list";
}

/** Set (and persist) an API key for a provider. Key never appears in frames. */
export interface AuthSetApiKeyCmd {
  type: "auth/set_api_key";
  provider: string;
  apiKey: string;
}

/** Remove a provider's API key credential (runtime + persisted storage). */
export interface AuthRemoveKeyCmd {
  type: "auth/remove_key";
  provider: string;
}

/** Session entries in append order; `since`/`before` are durable cursors
 * (forward increment / backward paging) and `limit` caps the window to the
 * most recent N entries (bounded single frame, design.md). */
export interface GetEntriesCmd {
  type: "get_entries";
  threadId: string;
  since?: string;
  before?: string;
  limit?: number;
}

/** Session as a tree of entries with the current leaf. */
export interface GetTreeCmd {
  type: "get_tree";
  threadId: string;
}

/** Set the session's display name. */
export interface SetSessionNameCmd {
  type: "set_session_name";
  threadId: string;
  name: string;
}

/** Token usage, cost, and context window usage. */
export interface GetSessionStatsCmd {
  type: "get_session_stats";
  threadId: string;
}

/** Drop queued steering/follow-up messages; returns their text. */
export interface ClearQueueCmd {
  type: "clear_queue";
  threadId: string;
}

/** Fork the thread from a historical entry; thread gets a NEW threadId. */
export interface ForkCmd {
  type: "fork";
  threadId: string;
  entryId: string;
  position?: "before" | "at";
}

/** Clone: fork at the current leaf; thread gets a NEW threadId. */
export interface CloneCmd {
  type: "clone";
  threadId: string;
}

/** Move the active leaf within the current session file. */
export interface NavigateTreeCmd {
  type: "navigate_tree";
  threadId: string;
  targetId: string;
  summarize?: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

/** User messages available as fork points. */
export interface GetForkMessagesCmd {
  type: "get_fork_messages";
  threadId: string;
}

/** Slash commands / skills enumeration for input autocomplete. */
export interface GetCommandsCmd {
  type: "get_commands";
  threadId: string;
}

/** Execute a shell command directly; output streams via event frames. */
export interface BashCmd {
  type: "bash";
  threadId: string;
  command: string;
  excludeFromContext?: boolean;
  /**
   * v0.6 server-side wall clock: positive integer <= 86_400_000; `0` disables
   * the timeout for this command; omitted = the PAI_BASH_TIMEOUT_MS default.
   * Firing aborts via abortBash (BashResult.cancelled:true, not a failure).
   */
  timeoutMs?: number;
}

/** Abort a running direct bash command. */
export interface AbortBashCmd {
  type: "abort_bash";
  threadId: string;
}

/** Reply to a dialog request emitted on stdout. */
export interface UiResponseCmd {
  type: "ui_response";
  /** Must match the requestId of the dialog request. */
  requestId: string;
  /** e.g. { confirmed: true }, { value: "Allow" }, { cancelled: true } */
  payload: Record<string, unknown>;
}

/**
 * v0.5: per-conversation permission rules. Both are host-local commands
 * (pure file operations — never routed to a worker, never wake one).
 */
export interface GetPermissionRulesCmd {
  type: "get_permission_rules";
  threadId: string;
}

/** `rules: null` deletes the sidecar (the thread falls back to the global file). */
export interface SetPermissionRulesCmd {
  type: "set_permission_rules";
  threadId: string;
  rules: PermissionRules | null;
}

/**
 * v0.5: enumerate agent definitions (host-local). With a threadId the
 * project-level directory of that thread's cwd is included when the thread
 * is trusted; without one only user-level agents are listed.
 */
export interface AgentsListCmd {
  type: "agents/list";
  threadId?: string;
}

/** v0.5 stage 7: steer a RUNNING background subagent of this conversation
 * (host routes to the conversation's worker, which writes the steer line
 * into the grandchild's stdin). Settled/queued/unknown ids fail. */
export interface SubagentSteerCmd {
  type: "subagent/steer";
  threadId: string;
  subagentId: string;
  message: string;
}

/**
 * v0.6: host-local observability entry point (versions/counts/limits). No
 * paths, env values, or credentials — numbers and version strings only.
 */
export interface GetHostInfoCmd {
  type: "get_host_info";
}

/** v0.7: the thread's sandbox snapshot + OS-runtime state (docs/plans
 * 2026-09-09-sandbox.md). */
export interface GetSandboxStateCmd {
  type: "get_sandbox_state";
  threadId: string;
}

/** Response payload of get_host_info (design.md v0.6 addendum). */
export interface HostInfo {
  version: string;
  piVersion: string;
  bunVersion: string;
  pid: number;
  uptimeMs: number;
  rssBytes: number;
  threads: { live: number; parked: number; dead: number };
  /** Global RUNNING grandchildren per the host grant ledger (a different
   * metric from the heartbeat `subagents` in-flight count). */
  subagents: { running: number };
  limits: {
    maxThreads: number;
    idleRetireMs: number;
    workerStaleMs: number;
    workerExitTimeoutMs: number;
    maxSubagents: number;
    bashTimeoutMs: number;
  };
  /** v0.8: the selected backend, its SDK version, and its capability bits
   * (strings and enums only — no paths/env/credentials, v0.6 promise intact). */
  backend: { id: string; version: string; capabilities: string[] };
}

export type HubCommand =
  | (ThreadStartCmd & { id?: string })
  | (ThreadResumeCmd & { id?: string })
  | (ThreadRegisterCmd & { id?: string })
  | (ThreadStopCmd & { id?: string })
  | (ThreadListCmd & { id?: string })
  | (ThreadListSavedCmd & { id?: string })
  | (PromptCmd & { id?: string })
  | (SteerCmd & { id?: string })
  | (FollowUpCmd & { id?: string })
  | (AbortCmd & { id?: string })
  | (CompactCmd & { id?: string })
  | (GetStateCmd & { id?: string })
  | (GetMessagesCmd & { id?: string })
  | (SetModelCmd & { id?: string })
  | (GetModelsCmd & { id?: string })
  | (SetModelOverrideCmd & { id?: string })
  | (SetThinkingLevelCmd & { id?: string })
  | (GetThinkingLevelsCmd & { id?: string })
  | (AuthListCmd & { id?: string })
  | (AuthSetApiKeyCmd & { id?: string })
  | (AuthRemoveKeyCmd & { id?: string })
  | (GetEntriesCmd & { id?: string })
  | (GetTreeCmd & { id?: string })
  | (SetSessionNameCmd & { id?: string })
  | (GetSessionStatsCmd & { id?: string })
  | (ClearQueueCmd & { id?: string })
  | (ForkCmd & { id?: string })
  | (CloneCmd & { id?: string })
  | (NavigateTreeCmd & { id?: string })
  | (GetForkMessagesCmd & { id?: string })
  | (GetCommandsCmd & { id?: string })
  | (BashCmd & { id?: string })
  | (AbortBashCmd & { id?: string })
  | (UiResponseCmd & { id?: string })
  | (GetPermissionRulesCmd & { id?: string })
  | (SetPermissionRulesCmd & { id?: string })
  | (AgentsListCmd & { id?: string })
  | (SubagentSteerCmd & { id?: string })
  | (GetHostInfoCmd & { id?: string })
  | (GetSandboxStateCmd & { id?: string });

// ============================================================================
// Frames (stdout, host -> Electron)
// ============================================================================

export interface ResponseFrame {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface EventFrame {
  type: "event";
  threadId: string;
  event: PaiEvent;
}

export interface UiRequestFrame {
  type: "ui_request";
  requestId: string;
  threadId: string;
  /** Dialog method: "confirm" | "select" | "input" | "editor" | "notify" | "setStatus" */
  method?: string;
  /** v0.5: set when the dialog was relayed from a subagent of this thread. */
  subagentId?: string;
  /** v0.5: agent name of the relaying subagent. */
  agent?: string;
  [key: string]: unknown;
}

/** Host heartbeat; v0.5 adds the aggregate in-flight subagent count. */
export interface HeartbeatFrame {
  type: "heartbeat";
  subagents?: number;
}

export interface HubErrorFrame {
  type: "hub_error";
  /** Present when the error originated inside a worker; identifies the thread. */
  threadId?: string;
  scope: string;
  error: string;
}

/** v0.4: a worker died unexpectedly; the thread entry moves to state "dead". */
export interface ThreadDiedFrame {
  type: "thread_died";
  threadId: string;
  reason: string;
}

/**
 * v0.5: a subagent (grandchild worker) event relayed by the conversation's
 * worker. The event is the grandchild's AgentSessionEvent verbatim; frame
 * fields are additive so older consumers can ignore them.
 */
export interface SubagentEventFrame {
  type: "subagent_event";
  threadId: string;
  subagentId: string;
  agent: string;
  task: string;
  event: PaiEvent;
}

/**
 * v0.5 stage 8: an inter-agent message relayed from a grandchild (its
 * `report`/`send` tools). The conversation's worker re-stamps identity from
 * its own registry (the grandchild's self-declared id is never trusted) and
 * forwards the frame to the client verbatim; `to` is present only for
 * sibling routing (stage 9), where the father model mediates delivery.
 */
export interface SubagentMessageFrame {
  type: "subagent_message";
  threadId: string;
  subagentId: string;
  agent: string;
  text: string;
  to?: string;
}

export interface ThreadListEntry {
  threadId: string;
  cwd: string;
  sessionPath: string | null;
  isStreaming: boolean;
  state: "live" | "parked" | "dead";
}

export type HubFrame =
  | ResponseFrame
  | EventFrame
  | UiRequestFrame
  | HeartbeatFrame
  | HubErrorFrame
  | ThreadDiedFrame
  | SubagentEventFrame
  | SubagentMessageFrame;

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
 * it to park a retired conversation), and — v0.5 — the number of live
 * subagent (grandchild) processes (observability; no host quota). */
export interface WorkerHeartbeatFrame {
  type: "heartbeat";
  idleMs: number;
  streaming: boolean;
  sessionPath: string | null;
  subagents?: number;
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
