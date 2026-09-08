import { describe, expect, test } from "bun:test";
import { MAX_ENTRIES_LIMIT, selectEntriesWindow } from "../src/entries-window.ts";

/** e1..e5 in append order. */
const ALL = ["e1", "e2", "e3", "e4", "e5"].map((id) => ({ id }));

describe("selectEntriesWindow (get_entries cursors + limit)", () => {
  test("no params: full window, no hasMore", () => {
    expect(selectEntriesWindow(ALL, {})).toEqual({ ok: true, entries: ALL, hasMore: false });
  });

  test("since: entries strictly after the cursor", () => {
    const result = selectEntriesWindow(ALL, { since: "e2" });
    expect(result).toEqual({ ok: true, entries: [ALL[2], ALL[3], ALL[4]], hasMore: false });
  });

  test("before: entries strictly older than the cursor", () => {
    const result = selectEntriesWindow(ALL, { before: "e4" });
    expect(result).toEqual({ ok: true, entries: [ALL[0], ALL[1], ALL[2]], hasMore: false });
  });

  test("unknown since / before cursor fails with the documented message", () => {
    expect(selectEntriesWindow(ALL, { since: "nope" })).toEqual({
      ok: false,
      error: "Entry not found: nope",
    });
    expect(selectEntriesWindow(ALL, { before: "nope" })).toEqual({
      ok: false,
      error: "Entry not found: nope",
    });
  });

  test("limit alone: tail hydration keeps the most recent N", () => {
    expect(selectEntriesWindow(ALL, { limit: 2 })).toEqual({
      ok: true,
      entries: [ALL[3], ALL[4]],
      hasMore: true,
    });
    expect(selectEntriesWindow(ALL, { limit: 5 })).toEqual({
      ok: true,
      entries: ALL,
      hasMore: false,
    });
    expect(selectEntriesWindow(ALL, { limit: 9 })).toEqual({
      ok: true,
      entries: ALL,
      hasMore: false,
    });
  });

  test("before + limit: backward paging returns the N entries preceding the cursor", () => {
    // Page 1: tail of the whole session.
    const page1 = selectEntriesWindow(ALL, { limit: 2 });
    // Page 2: continue with before = oldest id shown.
    const oldest = page1.ok ? page1.entries[0]?.id : undefined;
    const page2 = selectEntriesWindow(ALL, { before: oldest, limit: 2 });
    expect(page2).toEqual({ ok: true, entries: [ALL[1], ALL[2]], hasMore: true });
    const page3 = selectEntriesWindow(ALL, { before: "e2", limit: 2 });
    expect(page3).toEqual({ ok: true, entries: [ALL[0]], hasMore: false });
  });

  test("since + before: window between the cursors", () => {
    const result = selectEntriesWindow(ALL, { since: "e1", before: "e4" });
    expect(result).toEqual({ ok: true, entries: [ALL[1], ALL[2]], hasMore: false });
  });

  test("since positioned after before: empty window, not an error", () => {
    const result = selectEntriesWindow(ALL, { since: "e4", before: "e2" });
    expect(result).toEqual({ ok: true, entries: [], hasMore: false });
  });

  test("limit truncation applies inside the cursor window", () => {
    const result = selectEntriesWindow(ALL, { since: "e1", limit: 2 });
    expect(result).toEqual({ ok: true, entries: [ALL[3], ALL[4]], hasMore: true });
  });

  test("invalid limits fail explicitly", () => {
    for (const limit of [0, -1, 1.5, NaN, MAX_ENTRIES_LIMIT + 1]) {
      expect(selectEntriesWindow(ALL, { limit })).toEqual({
        ok: false,
        error: `limit must be a positive integer <= ${MAX_ENTRIES_LIMIT}`,
      });
    }
    expect(selectEntriesWindow(ALL, { limit: MAX_ENTRIES_LIMIT }).ok).toBe(true);
  });

  test("empty session: every shape returns an empty window", () => {
    expect(selectEntriesWindow([], {})).toEqual({ ok: true, entries: [], hasMore: false });
    expect(selectEntriesWindow([], { limit: 10 })).toEqual({
      ok: true,
      entries: [],
      hasMore: false,
    });
  });
});
