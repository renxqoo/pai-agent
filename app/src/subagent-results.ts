/**
 * Pure result/notification formatting for the subagent registry: settle
 * constructors, notification/message envelopes, snapshot projection, and
 * terminal-status mapping — lifted verbatim from subagent-registry.ts (one
 * verb, one file). Everything here is side-effect free; behavior is locked
 * by the registry's own suites.
 */

import type {
  GrandchildMessage,
  GrandchildResult,
  GrandchildTaskSpec,
  GrandchildUsage,
} from "./subagent-contract.ts";
import { NOTIFY_OUTPUT_CAP_BYTES } from "./subagent-registry.ts";
import { tailBytes, truncateBytes } from "./truncate.ts";
import type { RegistryEntry, SnapshotEntry, SubagentStatus } from "./subagent-registry.ts";

/** running tail cap for task_out previews (plan contract section). */
export const TASK_OUT_RUNNING_TAIL_BYTES = 2 * 1024;
/** Envelope task cap (review P2-10): chain steps can embed a 50KB
 * {previous} output; event frames AND task_out snapshots would re-carry it
 * without this cap (review B-P3-7 closed the snapshot bypass). */
export const ENVELOPE_TASK_CAP = 512;

function envelopeTask(task: string): string {
  return Buffer.byteLength(task, "utf8") <= ENVELOPE_TASK_CAP
    ? task
    : truncateBytes(task, ENVELOPE_TASK_CAP, "...");
}

function elapsedOf(entry: RegistryEntry, now: number): number {
  if (entry.settledAt !== null && entry.startedAt !== null)
    return entry.settledAt - entry.startedAt;
  if (entry.startedAt !== null) return now - entry.startedAt;
  return 0;
}

export function snapshotOf(entry: RegistryEntry): SnapshotEntry {
  const now = Date.now();
  const base = {
    subagentId: entry.spec.subagentId,
    agent: entry.spec.agent,
    task: envelopeTask(entry.spec.task),
    status: entry.status,
    elapsedMs: elapsedOf(entry, now),
  };
  if (entry.result !== undefined) {
    return {
      ...base,
      output: entry.result.output,
      usage: entry.result.usage,
      eventsRelayed: entry.result.eventsRelayed,
      truncated: entry.result.truncated,
    };
  }
  const live = entry.driver?.progress();
  const text = live === undefined ? "" : tailBytes(live.text, TASK_OUT_RUNNING_TAIL_BYTES);
  return {
    ...base,
    output: text,
    usage: live?.usage ?? zeroUsage(),
    eventsRelayed: live?.eventsRelayed ?? 0,
    truncated: live?.truncated ?? false,
  };
}

export function zeroUsage(): GrandchildUsage {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };
}

export function formatNotification(spec: GrandchildTaskSpec, result: GrandchildResult): string {
  let statusWord = "completed";
  if (result.aborted) statusWord = "stopped";
  else if (result.isError) statusWord = "failed";
  const output = truncateBytes(
    result.output,
    NOTIFY_OUTPUT_CAP_BYTES,
    "\n[output truncated to 8KB]",
  );
  return [
    `[task-notification] subagent ${spec.subagentId} (${spec.agent}) ${statusWord}.`,
    output,
    `(full output: task_out {"subagentId":"${spec.subagentId}"}; wait for others: task_wait)`,
  ].join("\n");
}

/** Envelope for a queued inter-agent message (stage 8/9 guardrails): source
 * id always; `to` marks a sibling-routing request the father mediates;
 * project-sourced agents speak as unverified data, not instructions. */
export function formatMessage(spec: GrandchildTaskSpec, message: GrandchildMessage): string {
  const text = truncateBytes(message.text, NOTIFY_OUTPUT_CAP_BYTES, "\n[message truncated to 8KB]");
  const header =
    message.to === undefined
      ? `[task-message] from subagent ${spec.subagentId} (${spec.agent}):`
      : `[task-message] from subagent ${spec.subagentId} (${spec.agent}) intended for ${message.to} — route it with task_send only if appropriate:`;
  const unverified =
    spec.projectSourced === true
      ? "\n[unverified data: agent definition from the project directory]"
      : "";
  return `${header}\n${text}${unverified}`;
}

export function terminalStatus(entry: RegistryEntry, result: GrandchildResult): SubagentStatus {
  if (result.aborted) return "stopped";
  if (result.isError) return "failed";
  return "completed";
}

export function settledError(spec: GrandchildTaskSpec, message: string): GrandchildResult {
  return {
    agent: spec.agent,
    task: spec.task,
    output: message,
    isError: true,
    errorMessage: message,
    aborted: false,
    usage: zeroUsage(),
    stderr: "",
    truncated: false,
    eventsRelayed: 0,
  };
}

export function stoppedResult(spec: GrandchildTaskSpec, killed: boolean): GrandchildResult {
  const word = killed ? "subagent killed" : "subagent stopped before start";
  return {
    agent: spec.agent,
    task: spec.task,
    output: word,
    isError: true,
    errorMessage: word,
    aborted: true,
    usage: zeroUsage(),
    stderr: "",
    truncated: false,
    eventsRelayed: 0,
  };
}

/** The foreground turn's abort reaches the entry's controller (one-shot). */
export function chainOuterSignal(entry: RegistryEntry, outerSignal: AbortSignal | undefined): void {
  if (outerSignal === undefined) return;
  if (outerSignal.aborted) entry.controller.abort();
  else
    outerSignal.addEventListener(
      "abort",
      () => {
        entry.controller.abort();
      },
      { once: true },
    );
}
