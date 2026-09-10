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

/** Returns true when the command has been answered; false = not handled. */
export async function tryHandleReadHistory(
  deps: HostDeps,
  cmd: HubCommand,
  id: string | undefined,
): Promise<boolean> {
  const name = String(cmd.type ?? "unknown");
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
    deps.emit(
      responseSuccess(
        id,
        name,
        readHistoryState(snapshot, {
          sessionPath,
          resolveModel: (provider, modelId) =>
            resolveModel(deps.backend.modelRuntime, provider, modelId),
        }),
      ),
    );
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
