/**
 * get_entries window selection (pure, table-testable): forward `since` and
 * backward `before` durable cursors over the append-ordered entry list, then
 * a `limit` cap keeping the MOST RECENT window entries — one rule for both
 * primary flows (tail hydration without cursors, backward paging with
 * `before` = oldest id already shown). Bounded single frame (design.md);
 * unknown cursors and invalid limits fail explicitly.
 */

export interface EntryLike {
  id: string;
}

export const MAX_ENTRIES_LIMIT = 5_000;

export type EntriesWindow<T extends EntryLike> =
  | { ok: true; entries: T[]; hasMore: boolean }
  | { ok: false; error: string };

export function selectEntriesWindow<T extends EntryLike>(
  all: readonly T[],
  query: { since?: string; before?: string; limit?: number },
): EntriesWindow<T> {
  const { since, before, limit } = query;
  let start = 0;
  let end = all.length;
  if (since !== undefined) {
    const index = all.findIndex((entry) => entry.id === since);
    if (index === -1) return { ok: false, error: `Entry not found: ${since}` };
    start = index + 1;
  }
  if (before !== undefined) {
    const index = all.findIndex((entry) => entry.id === before);
    if (index === -1) return { ok: false, error: `Entry not found: ${before}` };
    end = index;
  }
  if (end < start) end = start; // since/cursor after before/cursor: empty window
  if (limit === undefined) {
    return { ok: true, entries: all.slice(start, end), hasMore: false };
  }
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_ENTRIES_LIMIT) {
    return { ok: false, error: `limit must be a positive integer <= ${MAX_ENTRIES_LIMIT}` };
  }
  const truncated = end - start > limit;
  return {
    ok: true,
    entries: truncated ? all.slice(end - limit, end) : all.slice(start, end),
    hasMore: truncated,
  };
}
