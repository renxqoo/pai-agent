/**
 * Parked read-history command shortcut (v0.12): get_entries/get_state on a
 * non-live thread are answered host-locally from the session file — no
 * worker spawn. Every unavailability (live thread, no session path,
 * unsupported backend, unreadable file, IO error) returns false so the
 * caller falls through to the wake path — fail-open to the previous
 * behavior. Cursor/limit errors inside a readable snapshot are genuine
 * command failures (same wording as the worker path) and are answered.
 */

import { resolve as resolvePath } from "node:path";
import type { HostDeps } from "./host-commands.ts";
import { resolveModel } from "./host-commands.ts";
import type { HubCommand } from "./protocol.ts";
import { responseFailure, responseSuccess } from "./frames.ts";
import type { HistorySnapshot } from "./read-history.ts";
import { historySnapshotOf, readHistoryEntries, readHistoryState } from "./read-history.ts";

const READ_HISTORY_COMMANDS: ReadonlySet<string> = new Set(["get_entries", "get_state"]);

/**
 * v0.14 convergence reads: on a non-live thread there is nothing in flight by
 * definition (parked/dead have no worker), so the empty form is the truth —
 * answered host-locally without reading the session file and without waking
 * anything. Failure to reach a thread entry falls through (fail-open), same
 * as the file-backed reads below.
 */
/** Shared constants must be structurally immutable: a downstream mutation
 * would pollute every later response (structural guard, not a copy tax). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

const EMPTY_INFLIGHT_READS: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  [
    "get_inflight",
    deepFreeze({
      turnStartEntryId: null,
      turnStartedAt: null,
      message: null,
      toolOutputs: [],
      bash: null,
    }),
  ],
  ["get_subagents", deepFreeze({ subagents: [] })],
  ["get_pending_dialogs", deepFreeze({ dialogs: [] })],
]);

/** Non-live convergence read: empty form, host-local, no wake. Returns true
 * when answered (unknown thread / live thread fall through to the wake path). */
function answerEmptyInflightRead(deps: HostDeps, cmd: HubCommand, id: string | undefined): boolean {
  const name = String(cmd.type ?? "unknown");
  const empty = EMPTY_INFLIGHT_READS.get(name);
  if (empty === undefined) return false;
  const { threadId } = cmd as { threadId?: unknown };
  if (typeof threadId !== "string") return false;
  const facts = deps.pool.entryFacts(threadId);
  if (facts === undefined || facts.state === "live") return false;
  deps.emit(responseSuccess(id, name, empty));
  return true;
}

/** Returns true when the command has been answered; false = not handled. */
export async function tryHandleReadHistory(
  deps: HostDeps,
  cmd: HubCommand,
  id: string | undefined,
): Promise<boolean> {
  const name = String(cmd.type ?? "unknown");
  if (answerEmptyInflightRead(deps, cmd, id)) return true;
  if (!READ_HISTORY_COMMANDS.has(name)) return false;
  const { threadId } = cmd as { threadId?: unknown };
  if (typeof threadId !== "string") return false;
  const target = deps.pool.entryFacts(threadId);
  if (target === undefined || target.state === "live" || target.sessionPath === null) {
    return false;
  }
  // A read racing a wake sees a consistent append-only prefix (plan §4);
  // the stale response is eventually superseded by the live path.
  const sessionPath = resolvePath(target.sessionPath);
  let history;
  try {
    history = await deps.backend.resources.readHistory(sessionPath);
  } catch {
    return false;
  }
  if (!history.ok) return false;
  const snapshot = historySnapshotOf(history.fileEntries);
  if (snapshot === null) return false;
  if (name === "get_entries") {
    answerEntries({ host: deps, cmd, id, snapshot });
  } else {
    // null = unusable entry graph (e.g. cyclic parentId) — fail-open to wake
    const state = readHistoryState(snapshot, {
      sessionPath,
      resolveModel: (provider, modelId) =>
        resolveModel(deps.backend.modelRuntime, provider, modelId),
    });
    if (state === null) return false;
    deps.emit(responseSuccess(id, name, state));
  }
  return true;
}

/** Cursor/limit errors on a readable snapshot are genuine command failures
 * (same wording as the worker path), not a reason to fall back. */
function answerEntries(deps: {
  host: HostDeps;
  cmd: HubCommand;
  id: string | undefined;
  snapshot: HistorySnapshot;
}): void {
  const query = deps.cmd as { since?: string; before?: string; limit?: number };
  const result = readHistoryEntries(deps.snapshot, {
    ...(query.since !== undefined ? { since: query.since } : {}),
    ...(query.before !== undefined ? { before: query.before } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
  });
  if (!result.ok) {
    deps.host.emit(responseFailure(deps.id, "get_entries", result.error));
    return;
  }
  deps.host.emit(responseSuccess(deps.id, "get_entries", result.data));
}
