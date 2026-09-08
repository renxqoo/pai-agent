// Scenario: one prompt round-trip against the scripted mock model — the
// streaming contract in miniature (acceptance response ordering, delta
// stitching, snapshot stripping, settle exactly once, entries cursor, thread
// reuse). Plan 2026-09-09-production-hardening.md §7.1.

import { makeWorld, startHost, writeAgentFiles } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "stream-basic";
export const timeoutMs = 90_000;

const FIRST_REPLY = "mock reply one with several pieces";
const SECOND_REPLY = "second reply";

export async function run({ assert }) {
  const world = makeWorld(name);
  const mock = startMockModel({
    models: {
      "mock-main": [
        { kind: "text", text: FIRST_REPLY, dripMs: 20 },
        { kind: "text", text: SECOND_REPLY },
      ],
    },
  });
  writeAgentFiles(world.agentDir, { mockUrl: mock.url });
  const host = startHost({ agentDir: world.agentDir });
  try {
    await host.waitFrame((f) => f.type === "heartbeat", { label: "first heartbeat", ms: 15_000 });

    host.send({
      id: "s1",
      type: "thread/start",
      provider: "mock",
      modelId: "mock-main",
      cwd: world.projectDir,
    });
    const start = await host.waitResponse("s1", { ms: 20_000 });
    assert(start.success, "thread/start succeeds");
    const tid = start.data.threadId;
    assert(typeof tid === "string" && tid.length > 0, "thread/start returns threadId");

    const beforePrompt = host.frames.length;
    const baseEntries = await (async () => {
      host.send({ id: "e0", type: "get_entries", threadId: tid });
      const r = await host.waitResponse("e0");
      assert(r.success, "get_entries on fresh thread succeeds");
      return r.data.entries;
    })();
    const baselineLeaf = baseEntries.length > 0 ? baseEntries.at(-1).id : undefined;

    // Round 1: acceptance response must arrive before any streaming event.
    host.send({
      id: "p1",
      type: "prompt",
      threadId: tid,
      message: "say the stream-basic-one marker",
    });
    const promptResp = await host.waitResponse("p1", { ms: 15_000 });
    assert(promptResp.success, "prompt accepted");
    const respIdx = host.frames.indexOf(promptResp);
    const earlyStream = host.frames
      .slice(beforePrompt, respIdx)
      .filter((f) => f.type === "event" && f.event?.type === "message_start");
    assert(earlyStream.length === 0, "no streaming events before the acceptance response");

    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: "round 1 settled",
      ms: 30_000,
    });

    const round1 = host.frames.slice(respIdx);
    const events = round1.filter((f) => f.type === "event").map((f) => f.event);
    const settledCount = events.filter((e) => e.type === "agent_settled").length;
    assert(settledCount === 1, `agent_settled exactly once (got ${settledCount})`);

    const firstDeltaIdx = events.findIndex(
      (e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta",
    );
    // pi also emits message_start/end for the user message; the ordering
    // contract is about the assistant's own stream.
    const startIdx = events.findIndex(
      (e) => e.type === "message_start" && e.message?.role === "assistant",
    );
    assert(
      startIdx !== -1 && firstDeltaIdx !== -1 && startIdx < firstDeltaIdx,
      "assistant message_start precedes the first text_delta",
    );

    const updates = events.filter(
      (e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta",
    );
    const stitched = updates.map((e) => e.assistantMessageEvent.delta).join("");
    assert(
      stitched === FIRST_REPLY,
      `delta stitching reproduces the reply (got ${stitched.slice(0, 40)}…)`,
    );

    const snapshotLeak = updates.some(
      (e) => e.assistantMessageEvent.partial !== undefined || e.message !== undefined,
    );
    assert(!snapshotLeak, "message_update frames carry no cumulative snapshot");

    const endFrame = events.find(
      (e) => e.type === "message_end" && e.message?.role === "assistant",
    );
    const endText = endFrame?.message?.content?.find((b) => b.type === "text")?.text;
    assert(endText === FIRST_REPLY, "message_end is authoritative");
    assert(
      typeof endFrame?.message?.usage?.totalTokens === "number" &&
        endFrame.message.usage.totalTokens > 0,
      "usage survives on message_end",
    );

    // Entries cursor: the turn appended entries after the baseline leaf.
    host.send({
      id: "e1",
      type: "get_entries",
      threadId: tid,
      ...(baselineLeaf !== undefined ? { since: baselineLeaf } : {}),
    });
    const after = await host.waitResponse("e1");
    const afterJson = JSON.stringify(after.data.entries);
    assert(
      after.success && after.data.entries.length > 0 && afterJson.includes("stream-basic-one"),
      "get_entries(since) returns the new turn including the user marker",
    );

    // Round 2: same thread, queue-exhausted default must NOT kick in (second
    // scripted step serves this request). Window from the send index: a fast
    // mock can finish streaming before the response poll wakes up.
    const round2Since = host.frames.length;
    host.send({ id: "p2", type: "prompt", threadId: tid, message: "say the second marker" });
    await host.waitResponse("p2", { ms: 15_000 });
    // since: without it this wait matches ROUND 1's settled frame instantly.
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: "round 2 settled",
      ms: 30_000,
      since: round2Since,
    });
    const round2End = host.frames
      .slice(round2Since)
      .find(
        (f) =>
          f.type === "event" &&
          f.event?.type === "message_end" &&
          f.event.message?.role === "assistant",
      );
    const round2Text = round2End?.event?.message?.content?.find((b) => b.type === "text")?.text;
    assert(round2Text === SECOND_REPLY, "second prompt consumes the second scripted step");

    const exitCode = await host.endGracefully();
    assert(exitCode === 0, `stdin EOF graceful exit 0 (got ${exitCode})`);
  } finally {
    host.killTree();
    mock.stop();
    world.cleanup();
  }
}
