// Scenario: convergence reads (v0.14, docs/plans/2026-09-11-convergence-read-surface.md).
// A client that missed the event stream (renderer reload / reconnect) must be
// able to converge from read-only snapshots alone. This journey drives the
// three new commands on a real host + worker:
//   - get_inflight during a streamed turn carries the turn boundary, the
//     partial assistant message and (after settle) the empty form;
//   - get_pending_dialogs serves an unanswered permission dialog with its
//     payload, and drops it once answered;
//   - get_state carries the queue face;
//   - on a parked thread all three answer the empty form host-locally with
//     zero worker processes (read must never wake).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, startHost, writeAgentFiles } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "convergence-reads";
export const timeoutMs = 120_000;

const IDLE_RETIRE_MS = 3_000;
const AGENT_DEF = `---
name: worker
description: convergence test worker
---
You are a test worker; reply with the requested marker.
`;

export async function run({ assert }) {
  const world = makeWorld(name);
  const mock = startMockModel({
    models: {
      "mock-main": [
        // Round 1: a slow stream, so the turn stays in flight while we read.
        { kind: "text", text: "inflight-marker", dripMs: 120 },
        // Round 2: an ask-mode bash call raises a dialog we read before answering.
        { kind: "tool", name: "bash", args: { command: "echo convergence-marker" } },
        { kind: "text", text: "after dialog" },
        // Round 3: a slow tool so the running toolOutputs and queued-steer
        // read paths are both live inside one deterministic window.
        { kind: "tool", name: "bash", args: { command: "sleep 3; echo toolout-marker" } },
        { kind: "text", text: "tool done" },
      ],
    },
  });
  mkdirSync(join(world.agentDir, "agents"), { recursive: true });
  writeFileSync(join(world.agentDir, "agents", "worker.md"), AGENT_DEF);
  writeAgentFiles(world.agentDir, { mockUrl: mock.url, rules: { mode: "ask", bash: {} } });
  const host = startHost({
    agentDir: world.agentDir,
    env: { PAI_IDLE_RETIRE_MS: String(IDLE_RETIRE_MS) },
  });

  const start = async (id) => {
    host.send({ id, type: "thread/start", cwd: world.projectDir });
    const r = await host.waitResponse(id, { ms: 20_000 });
    assert(r.success === true, "thread/start succeeds");
    return r.data.threadId;
  };

  const read = async (type, tid, extra = {}) => {
    const id = `${type}_${Math.random().toString(36).slice(2, 8)}`;
    host.send({ id, type, threadId: tid, ...extra });
    const r = await host.waitResponse(id, { ms: 20_000 });
    assert(r.success === true, `${type} answers (got ${JSON.stringify(r.error ?? null)})`);
    return r.data;
  };

  try {
    await host.waitFrame((f) => f.type === "heartbeat", { label: "first heartbeat", ms: 20_000 });
    const tid = await start("start1");

    // A fresh thread has nothing in flight: every read answers the empty form.
    const idleInflight = await read("get_inflight", tid);
    assert(idleInflight.turnStartEntryId === null, "idle get_inflight: null turn boundary");
    assert(idleInflight.message === null, "idle get_inflight: null message");
    assert(
      Array.isArray(idleInflight.toolOutputs) && idleInflight.toolOutputs.length === 0,
      "idle get_inflight: no tool outputs",
    );
    assert(idleInflight.bash === null, "idle get_inflight: no bash");
    const idleSubs = await read("get_subagents", tid);
    assert(
      Array.isArray(idleSubs.subagents) && idleSubs.subagents.length === 0,
      "idle get_subagents: empty list (registry untouched)",
    );
    const idleDialogs = await read("get_pending_dialogs", tid);
    assert(
      Array.isArray(idleDialogs.dialogs) && idleDialogs.dialogs.length === 0,
      "idle get_pending_dialogs: empty list",
    );
    const idleState = await read("get_state", tid);
    assert(
      Array.isArray(idleState.queue?.steering) && Array.isArray(idleState.queue?.followUp),
      "get_state carries the queue face",
    );

    // Round 1: read the in-flight face while the stream is still running.
    host.send({ id: "p1", type: "prompt", threadId: tid, message: "stream please" });
    await host.waitResponse("p1", { ms: 20_000 });
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "message_update", {
      label: "first stream delta",
      ms: 30_000,
    });
    const midInflight = await read("get_inflight", tid);
    assert(
      typeof midInflight.turnStartEntryId === "string",
      "in-flight boundary is the agent_start entry id",
    );
    const partial = midInflight.message;
    assert(partial !== null && typeof partial === "object", "in-flight message present");
    const partialText = (Array.isArray(partial.content) ? partial.content : [])
      .map((block) => (typeof block?.text === "string" ? block.text : ""))
      .join("");
    assert(partialText.length > 0, "in-flight message carries the streamed prefix");
    assert("inflight-marker".startsWith(partialText), "the partial is a prefix of the full text");
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: "round one settles",
      ms: 30_000,
    });
    const afterSettle = await read("get_inflight", tid);
    assert(
      afterSettle.turnStartEntryId === null && afterSettle.message === null,
      "settled turn: get_inflight back to the empty form",
    );

    // Round 2: an unanswered permission dialog is readable, then disappears.
    // All frame waits anchor past the frames of earlier rounds (waitFrame
    // replays history from `since`; an unanchored settle wait would be
    // satisfied instantly by round one's frame).
    const round2Start = host.frames.length;
    host.send({ id: "p3", type: "prompt", threadId: tid, message: "ask permission" });
    await host.waitResponse("p3", { ms: 20_000 });
    const dialogFrame = await host.waitFrame((f) => f.type === "ui_request", {
      label: "permission dialog",
      ms: 30_000,
      since: round2Start,
    });
    const pending = await read("get_pending_dialogs", tid);
    const target = pending.dialogs.find((entry) => entry.requestId === dialogFrame.requestId);
    assert(target !== undefined, "get_pending_dialogs serves the unanswered dialog");
    assert(
      typeof target.method === "string" && target.method.length > 0,
      "pending dialog carries its method",
    );
    assert(
      target.payload !== null && typeof target.payload === "object",
      "pending dialog carries its payload",
    );
    host.send({
      id: "answer",
      type: "ui_response",
      requestId: dialogFrame.requestId,
      payload: { cancelled: true },
    });
    await host.waitResponse("answer", { ms: 20_000 });
    const settled = await read("get_pending_dialogs", tid);
    assert(
      settled.dialogs.every((entry) => entry.requestId !== dialogFrame.requestId),
      "answered dialog leaves the pending set",
    );
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: "dialog round settles",
      ms: 40_000,
      since: round2Start,
    });

    // Round 3: while a tool runs, get_inflight.toolOutputs carries the live call.
    // Frame waits anchor past the rounds already run — waitFrame replays
    // history from `since`, and an unanchored match would answer the WRONG
    // round's dialog (the symptom: the real dialog never settles, the turn
    // wedges at the permission gate and the thread never parks).
    const roundStart = host.frames.length;
    host.send({ id: "p4", type: "prompt", threadId: tid, message: "run slow tool" });
    await host.waitResponse("p4", { ms: 20_000 });
    const toolDialog = await host.waitFrame((f) => f.type === "ui_request", {
      label: "tool permission dialog",
      ms: 30_000,
      since: roundStart,
    });
    host.send({
      id: "answer2",
      type: "ui_response",
      requestId: toolDialog.requestId,
      payload: { confirmed: true },
    });
    await host.waitResponse("answer2", { ms: 20_000 });
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "tool_execution_start", {
      label: "tool starts",
      ms: 30_000,
      since: roundStart,
    });
    const toolInflight = await read("get_inflight", tid);
    assert(
      toolInflight.toolOutputs.length > 0 && typeof toolInflight.toolOutputs[0].callId === "string",
      "running tool is readable through get_inflight.toolOutputs",
    );
    // A steer queued while the tool sleeps is readable through get_state.queue;
    // clearing it inside the same window keeps the turn deterministic (the
    // boundary injection of a queued steer would otherwise spawn a turn the
    // mock script has not planned for).
    host.send({ id: "steer1", type: "steer", threadId: tid, message: "mid-stream steer marker" });
    await host.waitResponse("steer1", { ms: 20_000 });
    const queuedState = await read("get_state", tid);
    assert(
      queuedState.queue?.steering?.includes("mid-stream steer marker") === true,
      "queued steer text is readable through get_state.queue",
    );
    host.send({ id: "cq1", type: "clear_queue", threadId: tid });
    await host.waitResponse("cq1", { ms: 20_000 });
    const clearedState = await read("get_state", tid);
    assert(
      clearedState.queue?.steering?.includes("mid-stream steer marker") !== true,
      "cleared steer leaves the queue face",
    );
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: "tool round settles",
      ms: 40_000,
      since: roundStart,
    });

    // Parked leg: all three reads answer the empty form host-locally, with no
    // worker alive (read must never wake — the v0.12 rule, extended here).
    let parked = false;
    let pollSeq = 0;
    const parkedDeadline = Date.now() + 40_000;
    while (!parked && Date.now() < parkedDeadline) {
      pollSeq += 1;
      const pollId = `list_${pollSeq}`;
      host.send({ id: pollId, type: "thread/list" });
      const list = await host.waitResponse(pollId, { ms: 15_000 });
      const entry = list.data.threads.find((t) => t.threadId === tid);
      parked = entry?.state === "parked";
      if (!parked) {
        await new Promise((done) => {
          setTimeout(done, 500);
        });
      }
    }
    assert(parked, "thread parks after the retire window");

    const parkedInflight = await read("get_inflight", tid);
    assert(
      parkedInflight.turnStartEntryId === null && parkedInflight.message === null,
      "parked get_inflight: empty form",
    );
    const parkedSubs = await read("get_subagents", tid);
    assert(parkedSubs.subagents.length === 0, "parked get_subagents: empty list");
    const parkedDialogs = await read("get_pending_dialogs", tid);
    assert(parkedDialogs.dialogs.length === 0, "parked get_pending_dialogs: empty list");
    host.send({ id: "hostinfo", type: "get_host_info" });
    const info = await host.waitResponse("hostinfo", { ms: 15_000 });
    assert(info.data.threads.live === 0, "parked reads woke nothing (live workers = 0)");

    host.send({ id: "stop", type: "thread/stop", threadId: tid });
    await host.waitResponse("stop", { ms: 20_000 });

    const exitCode = await host.endGracefully();
    assert(exitCode === 0, `stdin EOF graceful exit 0 (got ${exitCode})`);
  } finally {
    host.killTree();
    mock.stop();
    world.cleanup();
  }
}
