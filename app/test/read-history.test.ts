import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      ASSISTANT("e1", null, { provider: "p1", model: "m1" }),
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
    // Declared divergence (v0.12 review): unresolved session-data models are
    // null — no thin shape, no initial-model/auth fallback replication.
    expect(state.model).toBeNull();
    expect(state.thinkingLevel).toBe("high");

    const changeLast = snapshotOf([
      header("s1"),
      ASSISTANT("e1", null, { provider: "p1", model: "m1" }),
      entry("e2", "e1", { type: "model_change", provider: "p2", modelId: "m2" }),
    ]);
    expect(
      readHistoryState(changeLast, { sessionPath: "/s", resolveModel: noModel }).model,
    ).toBeNull();
  });

  test("resolveModel lifts the session-recorded model to the host snapshot shape", () => {
    const rich = { provider: "p2", id: "m2", contextWindow: 128_000 };
    const snapshot = snapshotOf([
      header("s1"),
      ASSISTANT("e1", null, { provider: "p2", model: "m2" }),
    ]);
    const state = readHistoryState(snapshot, {
      sessionPath: "/s.jsonl",
      resolveModel: (p, m) => (p === "p2" && m === "m2" ? rich : undefined),
    });
    expect(state.model).toBe(rich);
  });

  test("messages gate: a model_change on an empty context is null (worker restore-chain parity)", () => {
    const snapshot = snapshotOf([
      header("s1"),
      entry("e1", null, { type: "model_change", provider: "p", modelId: "m" }),
      entry("e2", "e1", { type: "label", targetId: "e1", label: "x" }),
    ]);
    expect(
      readHistoryState(snapshot, {
        sessionPath: "/s",
        resolveModel: (p, m) => ({ provider: p, id: m }),
      }).model,
    ).toBeNull();
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
  // Minimal stub: the shortcut only calls entryFacts on the pool and
  // getAvailableSnapshot on the model runtime.
  const pool = { entryFacts: () => deps.target } as unknown as WorkerPool;
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
        fileEntries: [header("s1"), ASSISTANT("e1", null, { provider: "p", model: "m" })],
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
    expect(response.data?.messageCount).toBe(1);
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
      pool: { entryFacts: () => ({ state: "parked", sessionPath: "/s.jsonl" }) },
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

describe("parser alignment: direct read equals SessionManager replay", () => {
  // Scope note (v0.12 review): this locks the parse-layer identity only —
  // the direct read and SessionManager.open run the same SDK pure functions.
  // Worker-restore-chain parity (auth fallback, default level) is covered by
  // the declared-divergence tests above and the e2e-mock field-by-field
  // comparison; it cannot be asserted here without circular validation.
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

describe("readHistory admission (fence / legacy / ceiling / share cache)", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "pai-read-history-admission-"));
  const sessionsDir = join(agentDir, "sessions");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(sessionsDir, { recursive: true });
  afterAll(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  test("a v3 session inside the fence parses", async () => {
    const path = join(sessionsDir, "ok.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify(header("s1"))}\n${JSON.stringify(USER("e1", null, "hi"))}\n`,
    );
    const { readHistory } = await import("../src/backend/pi-coding-agent/index.ts");
    expect(await readHistory(path)).toEqual({
      ok: true,
      fileEntries: [header("s1"), USER("e1", null, "hi")],
    });
  });

  test("symptom regression: a literal-null first line is invalid_file, not a sync throw", async () => {
    const { readHistory } = await import("../src/backend/pi-coding-agent/index.ts");
    const nullLine = join(sessionsDir, "nullhead.jsonl");
    writeFileSync(nullLine, "null\n");
    expect(await readHistory(nullLine)).toEqual({ ok: false, reason: "invalid_file" });
  });

  test("share window: same-mtime burst reuses one parse (same entries reference)", async () => {
    const { readHistory } = await import("../src/backend/pi-coding-agent/index.ts");
    const path = join(sessionsDir, "share.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify(header("sh"))}\n${JSON.stringify(USER("e1", null, "hi"))}\n`,
    );
    const first = await readHistory(path);
    const second = await readHistory(path);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.fileEntries).toBe(first.fileEntries);
    }
    // a different file rotates the single slot (no stale hit)
    const other = join(sessionsDir, "share2.jsonl");
    writeFileSync(
      other,
      `${JSON.stringify(header("sh2"))}\n${JSON.stringify(USER("e1", null, "hi"))}\n`,
    );
    const rotated = await readHistory(other);
    expect(rotated.ok).toBe(true);
  });

  test("legacy pre-v3 files are invalid (wake path owns the migration rewrite)", async () => {
    const { readHistory } = await import("../src/backend/pi-coding-agent/index.ts");
    const legacy = join(sessionsDir, "legacy.jsonl");
    writeFileSync(
      legacy,
      `${JSON.stringify({ type: "session", version: 2, id: "s2", timestamp: "t", cwd: "/w" })}\n`,
    );
    expect(await readHistory(legacy)).toEqual({ ok: false, reason: "invalid_file" });
    const headerless = join(sessionsDir, "v1.jsonl");
    writeFileSync(
      headerless,
      `${JSON.stringify({ type: "session", id: "s3", timestamp: "t", cwd: "/w" })}\n`,
    );
    expect(await readHistory(headerless)).toEqual({ ok: false, reason: "invalid_file" });
  });

  test("outside-the-fence paths report not_found", async () => {
    const { readHistory } = await import("../src/backend/pi-coding-agent/index.ts");
    const outside = join(agentDir, "outside.jsonl");
    writeFileSync(outside, `${JSON.stringify(header("s1"))}\n`);
    expect(await readHistory(outside)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("readHistoryState cyclic-parent guard (host loop safety)", () => {
  test("symptom regression: a cyclic parentId file degrades to null instead of looping the host", () => {
    const cyclic = snapshotOf([
      header("s1"),
      { ...USER("e1", "e2", "loop"), parentId: "e2" },
      { ...USER("e2", "e1", "loop"), parentId: "e1" },
    ]);
    expect(readHistoryState(cyclic, { sessionPath: "/s", resolveModel: noModel })).toBeNull();
    // get_entries never walks the chain — the window still serves
    expect(readHistoryEntries(cyclic, {}).ok).toBe(true);
  });

  test("self-referencing leaf also degrades; an acyclic file is unaffected", () => {
    const selfRef = snapshotOf([header("s1"), { ...USER("e1", null, "x"), parentId: "e1" }]);
    expect(readHistoryState(selfRef, { sessionPath: "/s", resolveModel: noModel })).toBeNull();
    const fine = snapshotOf([header("s1"), USER("e1", null, "ok")]);
    expect(readHistoryState(fine, { sessionPath: "/s", resolveModel: noModel })).not.toBeNull();
  });
});

/** 短路路径不得读会话文件：读到即失败（hostWith 的 readHistory 特意抛错）。 */
function nonLiveHost(target: unknown, frames: HubFrame[]): HostDeps {
  return {
    pool: { entryFacts: () => target },
    backend: {
      resources: {
        readHistory: () => {
          throw new Error("short-circuit must not read the session file");
        },
      },
    },
    emit: (frame: HubFrame) => frames.push(frame),
  } as unknown as HostDeps;
}

describe("v0.14 non-live convergence reads (empty-form short-circuit)", () => {
  test("parked/dead 三读口回空形态（不读文件、不唤醒、恒 success）", async () => {
    for (const state of ["parked", "dead"] as const) {
      const frames: HubFrame[] = [];
      const host = nonLiveHost({ state, sessionPath: "/sessions/s1.jsonl" }, frames);
      expect(
        await tryHandleReadHistory(
          host,
          { type: "get_inflight", threadId: "t1" } as HubCommand,
          "1",
        ),
      ).toBe(true);
      expect(
        await tryHandleReadHistory(
          host,
          { type: "get_subagents", threadId: "t1" } as HubCommand,
          "2",
        ),
      ).toBe(true);
      expect(
        await tryHandleReadHistory(
          host,
          { type: "get_pending_dialogs", threadId: "t1" } as HubCommand,
          "3",
        ),
      ).toBe(true);
      expect(frames).toEqual([
        {
          type: "response",
          id: "1",
          command: "get_inflight",
          success: true,
          data: {
            turnStartEntryId: null,
            turnStartedAt: null,
            message: null,
            toolOutputs: [],
            bash: null,
          },
        },
        {
          type: "response",
          id: "2",
          command: "get_subagents",
          success: true,
          data: { subagents: [] },
        },
        {
          type: "response",
          id: "3",
          command: "get_pending_dialogs",
          success: true,
          data: { dialogs: [] },
        },
      ]);
    }
  });

  test("live 线程 / 未知线程 / 缺 threadId / 非收敛命令：不接手（走唤醒透传路径）", async () => {
    for (const target of [{ state: "live", sessionPath: "/s" }, undefined]) {
      const frames: HubFrame[] = [];
      const host = nonLiveHost(target, frames);
      for (const type of ["get_inflight", "get_subagents", "get_pending_dialogs"]) {
        expect(await tryHandleReadHistory(host, { type, threadId: "t1" } as HubCommand, "1")).toBe(
          false,
        );
      }
      expect(frames).toEqual([]);
    }
    const frames: HubFrame[] = [];
    const host = nonLiveHost({ state: "parked", sessionPath: "/s" }, frames);
    expect(await tryHandleReadHistory(host, { type: "get_inflight" } as HubCommand, "1")).toBe(
      false,
    );
    expect(
      await tryHandleReadHistory(host, { type: "get_inflight", threadId: 7 } as never, "2"),
    ).toBe(false);
    expect(
      await tryHandleReadHistory(host, { type: "prompt", threadId: "t1" } as HubCommand, "3"),
    ).toBe(false);
    expect(frames).toEqual([]);
  });

  test("空形态常量被冻结（下游改动不得污染后续应答）", async () => {
    const frames: HubFrame[] = [];
    const host = nonLiveHost({ state: "parked", sessionPath: "/s" }, frames);
    await tryHandleReadHistory(host, { type: "get_subagents", threadId: "t1" } as HubCommand, "1");
    const { data } = frames[0] as { data: { subagents: unknown[] } };
    expect(() => {
      (data.subagents as unknown[]).push("pollution");
    }).toThrow();
  });
});

/**
 * 对抗处置（adv-fuzz F3/F4/F8/F7）：parseSessionEntries 按设计接受任意 JSON
 * 值（含 null/数字行），头部校验只查第一行——损坏文件可达。直读路径对非对象
 * 条目、非 string 的 session_info.name、缺 body 的 message 条目抛 TypeError，
 * 越过模块「不可用 → null → fail-open 唤醒」的自有契约变成 internal error。
 */
describe("corrupted session files degrade, never throw (adversarial)", () => {
  test("症状回归 F3「非对象条目抛 TypeError」：垃圾行被跳过，合法条目照常服务", () => {
    const snapshot = historySnapshotOf([
      header("s1"),
      null as never,
      42 as never,
      "garbage" as never,
      entry("e1", null, { type: "session_info", name: "kept" }),
    ]);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.entries.map((e) => e.id)).toEqual(["e1"]);
    expect(snapshot?.leafId).toBe("e1");
    expect(snapshot?.sessionName).toBe("kept");
  });

  test("症状回归 F8「非 string 的 session_info.name 抛 TypeError」：名字降级为 null", () => {
    const snapshot = historySnapshotOf([
      header("s1"),
      entry("e1", null, { type: "session_info", name: 42 as never }),
    ]);
    expect(snapshot?.sessionName).toBeNull();
    expect(snapshot?.leafId).toBe("e1");
  });

  test("症状回归 F7「无 id 末条目产出 undefined leafId」：类型恒为 string | null", () => {
    const snapshot = historySnapshotOf([
      header("s1"),
      entry("e1", null, { type: "session_info" }),
      { type: "session_info", parentId: "e1", name: "tail" } as never,
    ]);
    expect(snapshot?.leafId === null || typeof snapshot?.leafId === "string").toBe(true);
    expect(JSON.parse(JSON.stringify({ leafId: snapshot?.leafId })).leafId).toBeDefined();
  });

  test("症状回归 F4「缺 body 的 message 条目让 readHistoryState 抛出」：回 null 走 fail-open", () => {
    const snapshot = historySnapshotOf([
      header("s1"),
      { type: "message", id: "e1", parentId: null } as never,
    ]);
    expect(snapshot).not.toBeNull();
    const state = readHistoryState(
      snapshotOf([header("s1"), { type: "message", id: "e1", parentId: null } as never]),
      { sessionPath: "/tmp/anywhere.jsonl", resolveModel: noModel },
    );
    expect(state).toBeNull(); // 不可用条目图 → null（fail-open 唤醒路径）
  });
});

/**
 * 处置遗留②：双重损坏文件（无 id 垃圾对象行 + 合法条目缺 parentId 字段）
 * 下，byId 以 undefined 为键收录垃圾条目，缺字段的 parentId(=undefined)
 * 命中它并自环 → 误判循环 → 放弃直读。修法：只收录 string id；parentId
 * 仅在为 string 时跟随（缺失/null/异型一律视为根）。
 */
describe("parentChainAcyclic tolerates doubly-corrupt files (disposition leftover 2)", () => {
  test("症状回归「undefined 键误判循环」：垃圾行 + 缺 parentId 的合法条目不再放弃直读", () => {
    const entries = [
      header("s1"),
      { type: "session_info", name: "garbage-no-id" } as never, // 无 id 垃圾对象行
      {
        type: "message",
        id: "e1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          provider: "p",
          model: "m",
        },
      } as never, // parentId 字段缺失（undefined ≠ null）
    ];
    // 先证伪旧症状：快照可用（垃圾行被跳过、e1 是叶子）
    const snapshot = historySnapshotOf(entries);
    expect(snapshot?.leafId).toBe("e1");
    // 直读不再因误判循环回 null（旧代码在此返回 null）
    const state = readHistoryState(snapshotOf(entries), {
      sessionPath: "/tmp/x.jsonl",
      resolveModel: noModel,
    });
    expect(state).not.toBeNull();
    expect(state?.messageCount).toBe(1);
  });
});
