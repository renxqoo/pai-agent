/**
 * Grandchild contract (split from subagent-process.ts for the 500-line
 * file budget): task spec, results, driver surface, and budget constants.
 * The runner implementation stays in subagent-process.ts.
 */

import { randomBytes } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionModel } from "./protocol.ts";

export const SUBAGENT_START_TIMEOUT_MS_DEFAULT = 30_000;
export const SUBAGENT_STALE_MS_DEFAULT = 30_000;
export const SUBAGENT_KILL_GRACE_MS = 5_000;
export const RESULT_CONTENT_CAP_BYTES = 50 * 1024;
export const RELAY_BUFFER_CAP_BYTES = 256 * 1024;
export const STDERR_CAP_BYTES = 32 * 1024;

export function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface GrandchildTaskSpec {
  subagentId: string;
  agent: string;
  task: string;
  cwd: string;
  systemPrompt: string;
  tools?: string[];
  model?: SessionModel;
  thinkingLevel?: string;
  /** Parent conversation id: the grandchild's gate re-reads its ruleset. */
  permissionThreadId: string;
  /** Stage 8: agent definition came from the project directory — messages
   * from this task are enveloped as unverified data (trust guardrail). */
  projectSourced?: boolean;
}

/** One relayed inter-agent message (stage 8/9): report (no `to`) or a
 * sibling-routing request (`to` names another subagent of the father). */
export interface GrandchildMessage {
  text: string;
  to?: string;
}

export interface GrandchildHooks {
  /** One grandchild event (already relay-stripped by the caller). */
  onEvent: (event: AgentSessionEvent) => void;
  /** Grandchild ui_request relayed upward; answers arrive via resolveUi. */
  onUiRequest: (frame: Record<string, unknown>) => void;
  /** Grandchild report/send tool output (stage 8/9); absent in tests that
   * do not exercise inter-agent messaging. */
  onMessage?: (message: GrandchildMessage) => void;
  writeStderr: (text: string) => void;
}

export interface GrandchildUsage {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
}

export interface GrandchildResult {
  agent: string;
  task: string;
  output: string;
  isError: boolean;
  errorMessage?: string;
  aborted: boolean;
  usage: GrandchildUsage;
  stderr: string;
  /** Relay/detail buffer hit a cap; dropped data is counted, not stored. */
  truncated: boolean;
  eventsRelayed: number;
}

export interface LiveProgress {
  text: string;
  usage: GrandchildUsage;
  eventsRelayed: number;
  truncated: boolean;
}

export interface GrandchildDriver {
  result: Promise<GrandchildResult>;
  /** Route a ui_response back into the grandchild (reconstructed line: the
   * host's internal id never crosses this boundary). False = unknown/late. */
  resolveUi: (requestId: string, payload: Record<string, unknown>) => boolean;
  /** Steer a RUNNING grandchild (stage 7): writes the steer command and
   * resolves with the grandchild's ack — true on success, an error string
   * when its session rejected the steer, false when already settled/gone. */
  steer: (message: string) => Promise<boolean | string>;
  /** Live progress for task_out snapshots: last assistant text tail,
   * running usage totals, and relay counters; undefined once settled. */
  progress: () => LiveProgress | undefined;
}

// --- runner-internal shapes (kept beside the contract; the runner in
// subagent-process.ts owns the state machine) -------------------------------

export interface AssistantMessage {
  role?: string;
  content?: Array<{ type: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost?: { total: number };
    totalTokens: number;
  };
}

export interface DriverState {
  threadId: string;
  waiters: Map<string, (frame: Record<string, unknown>) => void>;
  pendingUiRequests: Set<string>;
  /** Aggregated over every assistant turn; text/stopReason from the last. */
  usage: GrandchildUsage;
  lastText: string;
  lastStopReason: string | undefined;
  lastErrorMessage: string | undefined;
  relayBytes: number;
  truncated: boolean;
  stderrBytes: number;
  stderr: string;
  eventsRelayed: number;
  fatal: string | undefined;
  settled: boolean;
  /** close arrived (possibly before the settle wait was armed). */
  closedEarly: boolean;
  settleResolve: (() => void) | undefined;
}

export function newSubagentId(): string {
  return `sub_${randomBytes(4).toString("hex")}`;
}
