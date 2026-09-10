import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionContext,
  SessionManager,
  type FileEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  historySnapshotOf,
  readHistoryEntries,
  readHistoryState,
  type HistorySnapshot,
} from "../src/read-history.ts";
import { tryHandleReadHistory } from "../src/read-history-command.ts";
import type { HostDeps } from "../src/host-commands.ts";
import type { HubCommand, HubFrame, SessionModel } from "../src/protocol.ts";
import type { WorkerPool } from "../src/worker-pool.ts";
import type { ReadHistoryResult } from "../src/backend/ports/resources.ts";
import type { PaiModelRuntime } from "../src/backend/ports/model-auth.ts";

/** Append-order entry factory with an explicit parent chain. */
function entry(id: string, parentId: string | null, fields: Record<string, unknown>): FileEntry {
  return { id, parentId, timestamp: "2026-09-10T00:00:00Z", ...fields } as FileEntry;
}

function header(id: string): FileEntry {
  return { type: "session", version: 3, id, timestamp: "t", cwd: "/w" };
}

const USER = (id: string, parentId: string | null, text: string) =>
  entry(id, parentId, {
    type: "message",
    message: { role: "user", content: [{ type: "text", text }] },
  });
const ASSISTANT = (
  id: string,
  parentId: string | null,
  asModel: { provider: string; model: string },
) =>
  entry(id, parentId, {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `reply-${id}` }],
      provider: asModel.provider,
      model: asModel.model,
    },
  });

/** Fixture guard: historySnapshotOf over a valid fixture never yields null. */
function snapshotOf(fileEntries: FileEntry[]): HistorySnapshot {
  const snapshot = historySnapshotOf(fileEntries);
  if (snapshot === null) throw new Error("invalid test fixture: missing session header");
  return snapshot;
}

/** A resolveModel stub that never resolves (thin-shape fallback path). */
function noModel(): SessionModel | undefined {
  return undefined;
}

describe("historySnapshotOf (direct-read projection)", () => {
  test("header-only session: empty entries, null leaf", () => {
    const snapshot = snapshotOf([header("s1")]);
    expect(snapshot).toEqual({ sessionId: "s1", entries: [], leafId: null, sessionName: null });
  });

  test("leafId is the last appended entry id (not a tree walk); session_info reverse walk", () => {
    const snapshot = snapshotOf([
      header("s1"),
      USER("e1", null, "hi"),
      entry("e2", "e1", { type: "session_info", name: "first" }),
      entry("e3", "e2", { type: "session_info", name: "  second  " }),
      entry("e4", "e3", { type: "session_info", name: "" }),
      USER("e5", "e4", "again"),
    ]);
    expect(snapshot?.leafId).toBe("e5");
    expect(snapshot?.sessionId).toBe("s1");
    // latest session_info with an empty name clears the title
    expect(snapshot?.sessionName).toBeNull();
    expect(snapshot?.entries.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });

  test("non-session first entry, no entries, or a header without a string id is invalid", () => {
    expect(historySnapshotOf([])).toBeNull();
    expect(historySnapshotOf([USER("e1", null, "no header")])).toBeNull();
    expect(historySnapshotOf([{ type: "session", timestamp: "t", cwd: "/w" }])).toBeNull();
  });
});

describe("readHistoryEntries (window over the snapshot)", () => {
  const snapshot = snapshotOf([
    header("s1"),
    USER("e1", null, "a"),
    USER("e2", "e1", "b"),
    USER("e3", "e2", "c"),
  ]);

  test("tail limit keeps most recent, echoes snapshot leafId", () => {
    const result = readHistoryEntries(snapshot, { limit: 2 });
    expect(result.ok && result.data.entries.map((e) => e.id)).toEqual(["e2", "e3"]);
    expect(result.ok && result.data.leafId).toBe("e3");
    expect(result.ok && result.data.hasMore).toBe(true);
  });

  test("unknown cursor fails with the worker-path wording", () => {
    expect(readHistoryEntries(snapshot, { since: "nope" })).toEqual({
      ok: false,
      error: "Entry not found: nope",
    });
  });
});

describe("readHistoryState (derivation)", () => {
  test("model fallback chain: last model_change, else last assistant, else null; thinkingLevel default off", () => {
    const bare = snapshotOf([header("s1"), USER("e1", null, "hi")]);
    const bareState = readHistoryState(bare, {
      sessionPath: "/sessions/s1.jsonl",
      resolveModel: noModel,
    });
    expect(bareState.model).toBeNull();
    expect(bareState.thinkingLevel).toBe("off");
    expect(bareState.isStreaming).toBe(false);
    expect(bareState.isCompacting).toBe(false);
    expect(bareState.sessionId).toBe("s1");
    expect(bareState.sessionFile).toBe("/sessions/s1.jsonl");
    expect(bareState.messageCount).toBe(1);

    const withModel = snapshotOf([
      header("s1"),
      ASSISTANT("e1", null, "old", "p1", "m1"),
      entry("e2", "e1", { type: "model_change", provider: "p2", modelId: "m2" }),
      ASSISTANT("e3", "e2", { provider: "p1", model: "m1" }),
      entry("e4", "e3", { type: "thinking_level_change", thinkingLevel: "high" }),
    ]);
    // Path-order last wins: the assistant e3 comes after the model_change e2.
    expect(buildSessionContext(withModel.entries, withModel.leafId).model).toEqual({
      provider: "p1",
      modelId: "m1",
    });
    const state = readHistoryState(withModel, {
      sessionPath: "/sessions/s1.jsonl",
      resolveModel: noModel,
    });
    expect(state.model).toEqual({ provider: "p1", modelId: "m1" });
    expect(state.thinkingLevel).toBe("high");

    const changeLast = snapshotOf([
      header("s1"),
      ASSISTANT("e1", null, "old", "p1", "m1"),
      entry("e2", "e1", { type: "model_change", provider: "p2", modelId: "m2" }),
    ]);
    expect(
      readHistoryState(changeLast, { sessionPath: "/s", resolveModel: noModel }).model,
    ).toEqual({ provider: "p2", modelId: "m2" });
  });

  test("resolveModel lifts the thin shape to the host snapshot model", () => {
    const rich = { provider: "p2", modelId: "m2", contextWindow: 128_000 };
    const snapshot = snapshotOf([
      header("s1"),
      entry("e1", null, { type: "model_change", provider: "p2", modelId: "m2" }),
    ]);
    const state = readHistoryState(snapshot, {
      sessionPath: "/s.jsonl",
      resolveModel: (p, m) => (p === "p2" && m === "m2" ? rich : undefined),
    });
    expect(state.model).toBe(rich);
  });

  test("compaction-aware messageCount: summary + kept tail (linear chain e1..e6, firstKept e3)", () => {
    const snapshot = snapshotOf([
      header("s1"),
      USER("e1", null, "q1"),
      ASSISTANT("e2", "e1", { provider: "p", model: "m" }),
      USER("e3", "e2", "q2"),
      ASSISTANT("e4", "e3", { provider: "p", model: "m" }),
      entry("e5", "e4", {
        type: "compaction",
        summary: "summarized q1..a2",
        firstKeptEntryId: "e3",
        tokensBefore: 1234,
      }),
      USER("e6", "e5", "q3"),
    ]);
    const state = readHistoryState(snapshot, {
      sessionPath: "/s.jsonl",
      resolveModel: noModel,
    });
    // Context = compaction summary + kept entries e3,e4 + post-compaction e6.
    expect(state.messageCount).toBe(4);
  });
});

function makeDeps(deps: {
  target?: { state: "live" | "parked" | "dead"; sessionPath: string | null };
  history: ReadHistoryResult;
  models?: Array<{ provider: string; modelId: string }>;
}): { host: HostDeps; frames: HubFrame[] } {
  const frames: HubFrame[] = [];
  // Minimal stub: the shortcut only calls historyTarget on the pool and
  // getAvailableSnapshot on the model runtime.
  const pool = { historyTarget: () => deps.target } as unknown as WorkerPool;
  const modelRuntime = {
    getAvailableSnapshot: () => deps.models ?? [],
  } as unknown as PaiModelRuntime;
  return {
    host: {
      pool,
      backend: {
        modelRuntime,
        resources: { readHistory: () => Promise.resolve(deps.history) },
      },
      emit: (frame: HubFrame) => frames.push(frame),
    } as unknown as HostDeps,
    frames,
  };
}

const noId = undefined;

describe("tryHandleReadHistory (host shortcut routing)", () => {
  const GOOD: ReadHistoryResult = {
    ok: true,
    fileEntries: [header("s1"), USER("e1", null, "hi")],
  };

  test("parked get_entries: answered locally, exactly one response, no wake", async () => {
    const { host, frames } = makeDeps({
      target: { state: "parked", sessionPath: "/sessions/s1.jsonl" },
      history: GOOD,
    });
    const handled = await tryHandleReadHistory(
      host,
      { type: "get_entries", threadId: "t1", id: "7" } as HubCommand,
      "7",
    );
    expect(handled).toBe(true);
    expect(frames).toEqual([
      {
        type: "response",
        id: "7",
        command: "get_entries",
        success: true,
        data: { entries: [GOOD.fileEntries[1] as SessionEntry], leafId: "e1", hasMore: false },
      },
    ]);
  });

  test("dead get_state: answered with derivation (isStreaming false by definition)", async () => {
    const rich = { provider: "p", id: "m", contextWindow: 8 };
    const { host, frames } = makeDeps({
      target: { state: "dead", sessionPath: "/sessions/s1.jsonl" },
      history: {
        ok: true,
        fileEntries: [
          header("s1"),
          entry("e1", null, { type: "model_change", provider: "p", modelId: "m" }),
        ],
      },
      models: [rich],
    });
    const handled = await tryHandleReadHistory(
      host,
      { type: "get_state", threadId: "t1", id: "8" } as HubCommand,
      "8",
    );
    expect(handled).toBe(true);
    const response = frames[0] as { data?: { model?: unknown; messageCount?: number } };
    expect(response.data?.model).toBe(rich);
    expect(response.data?.messageCount).toBe(0);
  });

  test("live / unknown / no path / unsupported / invalid / missing file: not handled (wake path)", async () => {
    const cases: Array<Parameters<typeof makeDeps>[0]> = [
      { target: { state: "live", sessionPath: "/sessions/s1.jsonl" }, history: GOOD },
      { target: undefined, history: GOOD },
      { target: { state: "parked", sessionPath: null }, history: GOOD },
      {
        target: { state: "parked", sessionPath: "/sessions/s1.jsonl" },
        history: { ok: false, reason: "unsupported" },
      },
      {
        target: { state: "parked", sessionPath: "/sessions/s1.jsonl" },
        history: { ok: false, reason: "invalid_file" },
      },
      {
        target: { state: "parked", sessionPath: "/sessions/s1.jsonl" },
        history: { ok: false, reason: "not_found" },
      },
    ];
    for (const scenario of cases) {
      const { host, frames } = makeDeps(scenario);
      const handled = await tryHandleReadHistory(
        host,
        { type: "get_state", threadId: "t1" } as HubCommand,
        noId,
      );
      expect(handled).toBe(false);
      expect(frames).toEqual([]);
    }
  });

  test("readHistory throwing (IO error): not handled", async () => {
    const frames: HubFrame[] = [];
    const host = {
      pool: { historyTarget: () => ({ state: "parked", sessionPath: "/s.jsonl" }) },
      backend: { resources: { readHistory: () => Promise.reject(new Error("EACCES")) } },
      emit: (frame: HubFrame) => frames.push(frame),
    } as unknown as HostDeps;
    expect(
      await tryHandleReadHistory(host, { type: "get_entries", threadId: "t1" } as HubCommand, noId),
    ).toBe(false);
    expect(frames).toEqual([]);
  });

  test("non-read command or missing threadId: not handled", async () => {
    const { host } = makeDeps({ target: { state: "parked", sessionPath: "/s" }, history: GOOD });
    expect(
      await tryHandleReadHistory(host, { type: "prompt", threadId: "t1" } as HubCommand, "1"),
    ).toBe(false);
    expect(await tryHandleReadHistory(host, { type: "get_entries" } as HubCommand, "2")).toBe(
      false,
    );
  });

  test("cursor error on a readable snapshot is a genuine failure response", async () => {
    const { host, frames } = makeDeps({
      target: { state: "parked", sessionPath: "/sessions/s1.jsonl" },
      history: GOOD,
    });
    const handled = await tryHandleReadHistory(
      host,
      { type: "get_entries", threadId: "t1", since: "gone", id: "9" } as HubCommand,
      "9",
    );
    expect(handled).toBe(true);
    expect(frames).toEqual([
      {
        type: "response",
        id: "9",
        command: "get_entries",
        success: false,
        error: "Entry not found: gone",
      },
    ]);
  });
});

describe("golden alignment: direct read equals SessionManager replay", () => {
  test("leafId / entries / context settings agree on a branched, compacted file", () => {
    // Linear chain e1..e4 with a sibling branch: e5 (parent e1) appended
    // after e4, then a compaction whose kept tail starts at e5.
    const fileEntries: FileEntry[] = [
      header("s1"),
      USER("e1", null, "root"),
      ASSISTANT("e2", "e1", { provider: "p", model: "m" }),
      USER("e3", "e2", "branch-a-2"),
      entry("e4", "e3", { type: "model_change", provider: "q", modelId: "n" }),
      { ...USER("e5", "e1", "branch-b"), id: "e5" },
      entry("e6", "e5", {
        type: "compaction",
        summary: "s",
        firstKeptEntryId: "e5",
        tokensBefore: 10,
      }),
    ];
    const dir = mkdtempSync(join(tmpdir(), "pai-read-history-"));
    try {
      const path = join(dir, "session.jsonl");
      writeFileSync(path, `${fileEntries.map((e) => JSON.stringify(e)).join("\n")}\n`);
      expect(existsSync(path)).toBe(true);

      const replay = SessionManager.open(path);
      const snapshot = snapshotOf(fileEntries);

      expect(snapshot.leafId).toBe(replay.getLeafId());
      expect(snapshot.entries).toEqual(replay.getEntries());

      const direct = buildSessionContext(snapshot.entries, snapshot.leafId);
      const replayed = replay.buildSessionContext();
      expect(direct.model).toEqual(replayed.model);
      expect(direct.thinkingLevel).toEqual(replayed.thinkingLevel);
      expect(direct.messages).toEqual(replayed.messages);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
