import { describe, expect, test } from "bun:test";
import {
  handleGetInflight,
  handleGetPendingDialogs,
  handleGetSubagents,
} from "../src/inflight-read-commands.ts";
import { createInflightState } from "../src/inflight-state.ts";
import type { PaiThread } from "../src/backend/ports/session.ts";
import type { PendingSubagentDialog } from "../src/subagent-registry.ts";
import type { WorkerContext } from "../src/worker-context.ts";

/**
 * v0.14 convergence read handlers (design.md v0.14): shape of the three
 * payloads, the empty form, and the unknown-thread failure — exactly one
 * response either way.
 */

interface Frame {
  type: "success" | "failure";
  command: string;
  data?: unknown;
  error?: string;
}

function makeContext(overrides: {
  inflight?: ReturnType<typeof createInflightState>;
  streamingMessage?: unknown;
  subagents?: ReadonlyArray<unknown>;
  dialogs?: ReadonlyArray<{
    requestId: string;
    threadId?: string;
    request: { method: string; [key: string]: unknown };
  }>;
  subagentDialogs?: ReadonlyArray<PendingSubagentDialog>;
}): { ctx: WorkerContext; frames: Frame[] } {
  const frames: Frame[] = [];
  const inflight = overrides.inflight ?? createInflightState();
  const session = {
    sessionId: "t1",
    agent: {
      state:
        overrides.streamingMessage === undefined
          ? {}
          : { streamingMessage: overrides.streamingMessage },
    },
  };
  const thread: PaiThread = {
    session: session as never,
    cwd: "/w",
    sessionPath: undefined,
    inflight,
  };
  const ctx = {
    requireThread: (threadId: string, command: string) => {
      if (threadId !== "t1") {
        frames.push({ type: "failure", command, error: `Unknown threadId: ${threadId}` });
        return;
      }
      return thread;
    },
    success: (id: string | undefined, command: string, data?: unknown) => {
      if (id !== undefined) frames.push({ type: "success", command, data });
    },
    subagentSnapshot: () => overrides.subagents ?? [],
    subagentPendingDialogs: () => [...(overrides.subagentDialogs ?? [])],
    broker: { pendingAll: () => overrides.dialogs ?? [] },
  } as unknown as WorkerContext;
  return { ctx, frames };
}

const cmd = (type: string, threadId = "t1"): never => ({ type, threadId }) as never;

describe("get_inflight (v0.14)", () => {
  test("empty form when nothing is in flight (success, never an error)", async () => {
    const { ctx, frames } = makeContext({});
    await handleGetInflight(ctx, cmd("get_inflight"), "1");
    expect(frames).toEqual([
      {
        type: "success",
        command: "get_inflight",
        data: {
          turnStartEntryId: null,
          turnStartedAt: null,
          message: null,
          toolOutputs: [],
          bash: null,
        },
      },
    ]);
  });

  test("serves the turn boundary, the streaming message and the running tails", async () => {
    const inflight = createInflightState(64 * 1024, () => 7_000);
    inflight.beginTurn("e7", 7_000);
    inflight.noteToolStart("c1");
    inflight.noteToolUpdate("c1", { content: "half" });
    inflight.beginBash("r1", "ls");
    inflight.noteBashOutput("r1", "out");
    const { ctx, frames } = makeContext({
      inflight,
      streamingMessage: { role: "assistant", timestamp: 42 },
    });

    await handleGetInflight(ctx, cmd("get_inflight"), "2");

    expect(frames[0]?.data).toEqual({
      turnStartEntryId: "e7",
      turnStartedAt: 7_000,
      message: { role: "assistant", timestamp: 42 },
      toolOutputs: [{ callId: "c1", output: "half", truncated: false, startedAt: 7_000 }],
      bash: { command: "ls", output: "out", truncated: false, startedAt: 7_000 },
    });
  });

  test("unknown thread → one failure, no success", async () => {
    const { ctx, frames } = makeContext({});
    await handleGetInflight(ctx, cmd("get_inflight", "nope"), "3");
    expect(frames).toEqual([
      { type: "failure", command: "get_inflight", error: "Unknown threadId: nope" },
    ]);
  });
});

describe("get_subagents (v0.14)", () => {
  test("empty list when no subagent ran", async () => {
    const { ctx, frames } = makeContext({});
    await handleGetSubagents(ctx, cmd("get_subagents"), "4");
    expect(frames).toEqual([
      { type: "success", command: "get_subagents", data: { subagents: [] } },
    ]);
  });

  test("serves the registry snapshot verbatim", async () => {
    const entry = { subagentId: "s1", agent: "explore", status: "running", output: "" };
    const { ctx, frames } = makeContext({ subagents: [entry] });
    await handleGetSubagents(ctx, cmd("get_subagents"), "5");
    expect(frames[0]?.data).toEqual({ subagents: [entry] });
  });
});

describe("get_pending_dialogs (v0.14)", () => {
  test("empty list when nothing awaits an answer", async () => {
    const { ctx, frames } = makeContext({});
    await handleGetPendingDialogs(ctx, cmd("get_pending_dialogs"), "6");
    expect(frames).toEqual([
      { type: "success", command: "get_pending_dialogs", data: { dialogs: [] } },
    ]);
  });

  test("serves requestId + threadId + method + payload (the ui_request frame fields)", async () => {
    const { ctx, frames } = makeContext({
      dialogs: [
        { requestId: "r1", threadId: "t1", request: { method: "confirm", title: "Allow?" } },
      ],
    });
    await handleGetPendingDialogs(ctx, cmd("get_pending_dialogs"), "7");
    expect(frames[0]?.data).toEqual({
      dialogs: [
        {
          requestId: "r1",
          threadId: "t1",
          method: "confirm",
          payload: { method: "confirm", title: "Allow?" },
        },
      ],
    });
  });

  test("症状回归「子代理在途弹窗重载后丢失」：grandchild 保留帧并入读口（与实时 relay 同口径）", async () => {
    const { ctx, frames } = makeContext({
      subagentDialogs: [
        {
          requestId: "req-s1",
          subagentId: "sub_1",
          agent: "explore",
          frame: {
            type: "ui_request",
            requestId: "req-s1",
            threadId: "g-sess-1",
            method: "select",
            options: ["Allow once", "Deny"],
          },
        },
      ],
    });
    await handleGetPendingDialogs(ctx, cmd("get_pending_dialogs"), "4");
    expect(frames).toEqual([
      {
        type: "success",
        command: "get_pending_dialogs",
        data: {
          dialogs: [
            {
              requestId: "req-s1",
              threadId: "t1",
              method: "select",
              payload: {
                method: "select",
                options: ["Allow once", "Deny"],
                subagentId: "sub_1",
                agent: "explore",
              },
            },
          ],
        },
      },
    ]);
  });

  test("症状防护「rebind 后旧会话弹窗泄漏进读口」：broker 条目按服务线程过滤", async () => {
    const { ctx, frames } = makeContext({
      dialogs: [
        { requestId: "mine", threadId: "t1", request: { method: "confirm", title: "current" } },
        {
          requestId: "stale",
          threadId: "old-session",
          request: { method: "confirm", title: "stale" },
        },
      ],
    });
    await handleGetPendingDialogs(ctx, cmd("get_pending_dialogs"), "6");
    const data = frames[0]?.data as { dialogs: PendingDialogEntryLike[] };
    expect(data.dialogs.map((entry) => entry.requestId)).toEqual(["mine"]);
  });

  test("broker 与 grandchild 帧合并成一个队列；无 method 的垃圾帧跳过", async () => {
    const { ctx, frames } = makeContext({
      dialogs: [{ requestId: "b1", threadId: "t1", request: { method: "confirm", title: "Run?" } }],
      subagentDialogs: [
        {
          requestId: "req-s2",
          subagentId: "sub_2",
          agent: "general-purpose",
          frame: { type: "ui_request", requestId: "req-s2", method: "input", placeholder: "path" },
        },
        {
          requestId: "req-x",
          subagentId: "sub_3",
          agent: "x",
          frame: { type: "ui_request", requestId: "req-x" },
        },
      ],
    });
    await handleGetPendingDialogs(ctx, cmd("get_pending_dialogs"), "5");
    const data = frames[0]?.data as { dialogs: PendingDialogEntryLike[] };
    expect(data.dialogs).toHaveLength(2);
    expect(data.dialogs.map((entry) => entry.requestId)).toEqual(["b1", "req-s2"]);
  });
});

interface PendingDialogEntryLike {
  requestId: string;
  threadId: string;
  method: string;
  payload: Record<string, unknown>;
}
