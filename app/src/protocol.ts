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

/** v0.13: manual idle-retire — parks the entry (opposite of thread/stop's dispose). */
export interface ThreadRetireCmd {
  type: "thread/retire";
  threadId: string;
}

/** v0.13: per-thread keepalive flag — the idle sweep skips live workers whose
 * entry is marked (stale-heartbeat kills still apply). Not persisted; the
 * client's registry is the durable truth and re-asserts on wake. */
export interface ThreadSetKeepaliveCmd {
  type: "thread/set_keepalive";
  threadId: string;
  keepalive: boolean;
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

/** v0.13: runtime idle-retire threshold change (clamped to 1s..24h; the
 * response data carries the applied value). */
export interface SetIdleRetireMsCmd {
  type: "set_idle_retire_ms";
  ms: number;
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
  | (ThreadRetireCmd & { id?: string })
  | (ThreadSetKeepaliveCmd & { id?: string })
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
  | (SetIdleRetireMsCmd & { id?: string })
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

/** Host heartbeat; v0.5 adds the aggregate in-flight subagent count; v0.13
 * adds host-process resource numbers (rssBytes always; cpuPercent is a
 * process.cpuUsage 1s differential normalized to one core, may exceed 100). */
export interface HeartbeatFrame {
  type: "heartbeat";
  subagents?: number;
  rssBytes?: number;
  cpuPercent?: number;
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

/** v0.13: a worker was retired (idle sweep or thread/retire); the entry moved
 * to "parked" and the session file is kept. Emitted exactly once from the
 * close settlement — the healthy counterpart of thread_died. */
export interface ThreadParkedFrame {
  type: "thread_parked";
  threadId: string;
  reason: "idle" | "manual";
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
  /** v0.13 observability: idle duration from the worker heartbeat (0 for non-live). */
  idleMs: number;
  /** v0.13: in-flight subagents per the last heartbeat (0 for non-live). */
  subagents: number;
  /** v0.13: worker RSS as reported by its heartbeat; null until first report. */
  rssBytes: number | null;
  /** v0.13: entry flag — the idle sweep skips live workers marked keepalive. */
  keepalive: boolean;
}

export type HubFrame =
  | ResponseFrame
  | EventFrame
  | UiRequestFrame
  | HeartbeatFrame
  | HubErrorFrame
  | ThreadDiedFrame
  | ThreadParkedFrame
  | SubagentEventFrame
  | SubagentMessageFrame;
