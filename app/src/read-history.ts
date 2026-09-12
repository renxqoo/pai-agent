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
 * session header with a string id, otherwise the file is not a pi session.
 * parseSessionEntries admits any JSON value per line (header included), so
 * corrupted lines (null, numbers, wrong shapes) are skipped here rather than
 * thrown on — the direct read serves the well-formed entries and degrades
 * field-by-field (garbage session_info.name → null, id-less tail → previous
 * valid leaf). */
export function historySnapshotOf(fileEntries: FileEntry[]): HistorySnapshot | null {
  const [header] = fileEntries;
  if (header === undefined || header.type !== "session" || typeof header.id !== "string") {
    return null;
  }
  const entries = fileEntries.filter(
    (entry): entry is SessionEntry =>
      typeof entry === "object" && entry !== null && entry.type !== "session",
  );
  let leafId: string | null = null;
  let sessionName: string | null = null;
  for (const entry of entries) {
    if (typeof entry.id === "string") leafId = entry.id;
    // name:null/missing legitimately CLEARS the name (last info wins); a
    // non-string garbage shape degrades to no-name instead of throwing.
    if (entry.type === "session_info") {
      sessionName = typeof entry.name === "string" ? entry.name.trim() || null : null;
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

/** get_state over a snapshot; null when the entry graph is unusable for the
 * context walk (a cyclic parentId chain would loop the SDK's unguarded
 * parent walk forever INSIDE the host process — the wake path's 30s
 * stale-kill bounds the same file to a single worker instead).
 * isStreaming/isCompacting are false by definition: the thread has no
 * worker while the host answers directly. model/thinkingLevel follow
 * buildSessionContext: the last model_change or assistant message on the
 * leaf path wins (path order, either kind).
 *
 * Declared divergences from the live get_state (design.md v0.12): the
 * direct read reports the session-recorded model as a rich SessionModel or
 * null — it does not replicate the worker restore chain (auth check,
 * initial-model fallback), does not apply the settings default thinking
 * level or model clamping (no change entry means "off"), and a wake
 * materializes a default-level entry that shifts leafId once. */
export function readHistoryState(
  snapshot: HistorySnapshot,
  options: {
    sessionPath: string;
    resolveModel: (provider: string, modelId: string) => SessionModel | undefined;
  },
): {
  model: SessionModel | null;
  thinkingLevel: string;
  isStreaming: false;
  isCompacting: false;
  sessionId: string;
  sessionName: string | null;
  sessionFile: string;
  messageCount: number;
  /** v0.14: parked threads have no worker and therefore no queue — the field
   * is present with the empty arrays so the live/parked shapes stay closed. */
  queue: { steering: string[]; followUp: string[] };
} | null {
  if (!parentChainAcyclic(snapshot.entries, snapshot.leafId)) return null;
  let context;
  try {
    context = buildSessionContext(snapshot.entries, snapshot.leafId);
  } catch {
    // Shape damage the SDK's context walk does not guard (e.g. a message
    // entry without its body): unusable entry graph → null → the caller's
    // fail-open wake path owns the file.
    return null;
  }
  const model: SessionModel | null =
    context.model !== null && context.messages.length > 0
      ? (options.resolveModel(context.model.provider, context.model.modelId) ?? null)
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
    queue: { steering: [], followUp: [] },
  };
}

/** Guard for the SDK's unguarded parent walk: a hand-crafted or corrupted
 * file with a cyclic parentId chain must degrade to fail-open (null), not
 * loop the host. Walks exactly the leaf path the context walk would take. */
/** parentId chain walk: only string ids are indexable and only string
 * parentIds are followed — a missing/null/non-string parentId is a root.
 * Without the string guards, a garbage no-id entry lands under the key
 * `undefined` and a valid entry whose parentId FIELD is missing matches it,
 * self-looping the walk into a false "cyclic" verdict. */
function parentChainAcyclic(entries: readonly SessionEntry[], leafId: string | null): boolean {
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }
  const seen = new Set<string>();
  let current = leafId === null ? undefined : byId.get(leafId);
  while (current !== undefined) {
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
  }
  return true;
}
