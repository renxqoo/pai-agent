/**
 * Parked read-history derivation (v0.12, docs/plans/2026-09-10-parked-read-history.md):
 * pure projection of parsed session entries onto the get_entries / get_state
 * response shapes. The derivation must stay structurally identical to what a
 * resumed worker reports — every rule here mirrors a SessionManager behavior
 * (leaf = last appended non-header entry, reverse session_info walk for the
 * name, buildSessionContext for model/thinkingLevel/messages) so the direct
 * read and the live passthrough agree on the same file.
 */

import {
  buildSessionContext,
  type FileEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { SessionModel } from "./protocol.ts";
import { selectEntriesWindow } from "./entries-window.ts";

/** Parsed-session projection shared by both read commands. */
export interface HistorySnapshot {
  sessionId: string;
  /** Append-ordered entries without the header (SessionManager.getEntries shape). */
  entries: SessionEntry[];
  /** Last appended entry id (SessionManager._buildIndex assigns leaf in file
   * order — not a tree derivation); null for a header-only session. */
  leafId: string | null;
  /** Latest session_info name, reverse walk (empty name clears). */
  sessionName: string | null;
}

/** Header validation mirrors loadEntriesFromFile: first entry must be a
 * session header with a string id, otherwise the file is not a pi session. */
export function historySnapshotOf(fileEntries: FileEntry[]): HistorySnapshot | null {
  const [header] = fileEntries;
  if (header === undefined || header.type !== "session" || typeof header.id !== "string") {
    return null;
  }
  const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
  let leafId: string | null = null;
  let sessionName: string | null = null;
  for (const entry of entries) {
    leafId = entry.id;
    if (entry.type === "session_info") {
      sessionName = entry.name?.trim() || null;
    }
  }
  return { sessionId: header.id, entries, leafId, sessionName };
}

export type ReadHistoryEntriesResult =
  | { ok: true; data: { entries: SessionEntry[]; leafId: string | null; hasMore: boolean } }
  | { ok: false; error: string };

/** get_entries over a snapshot: the same window rule the worker applies
 * (selectEntriesWindow is the single truth for both paths). */
export function readHistoryEntries(
  snapshot: HistorySnapshot,
  query: { since?: string; before?: string; limit?: number },
): ReadHistoryEntriesResult {
  const window = selectEntriesWindow(snapshot.entries, query);
  if (!window.ok) return { ok: false, error: window.error };
  return {
    ok: true,
    data: { entries: window.entries, leafId: snapshot.leafId, hasMore: window.hasMore },
  };
}

/** A resolved model is the rich SessionModel (identical to the live
 * get_state via the host's fresh snapshot); unresolved session-data models
 * fall back to the thin shape rather than null — the client only keys on
 * provider/modelId. */
export type ReadHistoryModel = SessionModel | { provider: string; modelId: string };

/** get_state over a snapshot. isStreaming/isCompacting are false by
 * definition: the thread has no worker while the host answers directly.
 * model/thinkingLevel follow buildSessionContext: the last model_change or
 * assistant message on the leaf path wins (path order, either kind). */
export function readHistoryState(
  snapshot: HistorySnapshot,
  options: {
    sessionPath: string;
    resolveModel: (provider: string, modelId: string) => SessionModel | undefined;
  },
): {
  model: ReadHistoryModel | null;
  thinkingLevel: string;
  isStreaming: false;
  isCompacting: false;
  sessionId: string;
  sessionName: string | null;
  sessionFile: string;
  messageCount: number;
} {
  const context = buildSessionContext(snapshot.entries, snapshot.leafId);
  const model: ReadHistoryModel | null =
    context.model !== null
      ? (options.resolveModel(context.model.provider, context.model.modelId) ?? context.model)
      : null;
  return {
    model,
    thinkingLevel: context.thinkingLevel,
    isStreaming: false,
    isCompacting: false,
    sessionId: snapshot.sessionId,
    sessionName: snapshot.sessionName,
    sessionFile: options.sessionPath,
    messageCount: context.messages.length,
  };
}
