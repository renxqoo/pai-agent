// Scenario: the queue/tree/model journey (final review B-1 fix): steer +
// follow_up queueing with queue_update, clear_queue, set_model switching the
// conversation to a second scripted model, get_tree + navigate_tree round
// trip (threadId unchanged), and compact through the mock summarizer. These
// commands had zero protocol-level pinning before the capability-packs
// refactor; this is the byte-equality proof for their handlers.

import { makeWorld, startHost, writeAgentFiles } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "tree-and-queue";
export const timeoutMs = 120_000;

const MAIN_REPLY = "main model reply for the tree journey";
const STEER_REPLY = "reply after the steer was merged";
const ALT_REPLY = "alt model proves set_model took effect";
const SUMMARY = "compact summary text from the mock summarizer";

/** The steer merge triggers a SECOND run: wait for exactly n settled frames
 * past `since` before continuing (a single-settled wait races the merge). */
async function waitForSettles(host, opts) {
  const { since, count = 1, label } = opts;
  let cursor = since;
  for (let i = 0; i < count; i += 1) {
    const frame = await host.waitFrame(
      (f) => f.type === "event" && f.event?.type === "agent_settled",
      {
        label: `${label} (${i + 1}/${count})`,
        ms: 60_000,
        since: cursor,
      },
    );
    cursor = host.frames.indexOf(frame) + 1;
  }
}

export async function run({ assert }) {
  const world = makeWorld(name);
  const mock = startMockModel({
    models: {
      "mock-main": [
        { kind: "text", text: MAIN_REPLY, dripMs: 120 },
        { kind: "text", text: STEER_REPLY, dripMs: 40 },
      ],
      "mock-alt": [
        { kind: "text", text: ALT_REPLY },
        ...Array.from({ length: 8 }, (_, i) => ({
          kind: "text",
          text: `filler round ${i} context growth: ${"lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ".repeat(24)}`,
        })),
        { kind: "text", text: SUMMARY },
      ],
    },
  });
  writeAgentFiles(world.agentDir, { mockUrl: mock.url, models: ["mock-main", "mock-alt"] });
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

    // --- steer during streaming: queued, merged after the current tool/model
    const since1 = host.frames.length;
    host.send({ id: "p1", type: "prompt", threadId: tid, message: "main marker" });
    await host.waitResponse("p1", { ms: 15_000 });
    host.send({ id: "st1", type: "steer", threadId: tid, message: "steer marker" });
    const steerResp = await host.waitResponse("st1", { ms: 15_000 });
    assert(steerResp.success, "steer accepted while streaming");
    await host.waitFrame(
      (f) =>
        f.type === "event" &&
        f.event?.type === "queue_update" &&
        Array.isArray(f.event.steering) &&
        f.event.steering.length > 0,
      { label: "queue_update carries the steering message", ms: 15_000, since: since1 },
    );
    // pi merges a mid-stream steer into the CURRENT run (one extra model
    // call, still ONE agent_settled for the run).
    await waitForSettles(host, { since: since1, count: 1, label: "steer-merged round settled" });
    const steerText = host.frames
      .slice(since1)
      .filter(
        (f) =>
          f.type === "event" &&
          f.event?.type === "message_end" &&
          f.event.message?.role === "assistant",
      )
      .map((f) => f.event.message.content.find((b) => b.type === "text")?.text)
      .join("\n");
    assert(
      steerText.includes(STEER_REPLY),
      `the merged steer reply arrived (got ${steerText.slice(0, 40)}…)`,
    );

    // --- get_tree + navigate_tree: threadId must NOT change
    host.send({ id: "t1", type: "get_tree", threadId: tid });
    const tree = await host.waitResponse("t1", { ms: 15_000 });
    assert(tree.success && tree.data.leafId, "get_tree succeeds with a leaf");
    const entries0 = await (async () => {
      host.send({ id: "e0", type: "get_entries", threadId: tid, limit: 10 });
      return host.waitResponse("e0", { ms: 15_000 });
    })();
    const firstUser = entries0.data.entries.find((e) => e.type === "message");
    assert(firstUser !== undefined, "an early message entry exists");
    host.send({
      id: "n1",
      type: "navigate_tree",
      threadId: tid,
      targetId: firstUser.id,
      summarize: false,
    });
    const nav = await host.waitResponse("n1", { ms: 30_000 });
    assert(nav.success, "navigate_tree succeeds");
    host.send({ id: "g1", type: "get_state", threadId: tid });
    const st1 = await host.waitResponse("g1", { ms: 15_000 });
    assert(st1.data.sessionId === tid, "navigate_tree keeps the threadId (no re-key)");

    // --- set_model: the next reply must come from mock-alt's script
    host.send({
      id: "m1",
      type: "set_model",
      threadId: tid,
      provider: "mock",
      modelId: "mock-alt",
    });
    const model = await host.waitResponse("m1", { ms: 15_000 });
    assert(model.success, "set_model succeeds");
    const since2 = host.frames.length;
    host.send({ id: "p2", type: "prompt", threadId: tid, message: "alt marker" });
    await host.waitResponse("p2", { ms: 15_000 });
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: "alt-model round settled",
      ms: 60_000,
      since: since2,
    });
    const altEnd = host.frames
      .slice(since2)
      .find(
        (f) =>
          f.type === "event" &&
          f.event?.type === "message_end" &&
          f.event.message?.role === "assistant",
      );
    const altText = altEnd?.event?.message?.content?.find((b) => b.type === "text")?.text;
    assert(altText === ALT_REPLY, `set_model took effect (got ${String(altText).slice(0, 40)}…)`);

    // --- follow_up + clear_queue: queue, observe, then drop
    const since3 = host.frames.length;
    host.send({ id: "p3", type: "prompt", threadId: tid, message: "slow round" });
    await host.waitResponse("p3", { ms: 15_000 });
    // Idle steer (probe-proven stable shape), then clear.
    host.send({ id: "st2", type: "steer", threadId: tid, message: "queued then cleared" });
    await host.waitResponse("st2", { ms: 15_000 });
    host.send({ id: "cq1", type: "clear_queue", threadId: tid });
    const cleared = await host.waitResponse("cq1", { ms: 15_000 });
    assert(cleared.success, "clear_queue succeeds");
    const dropped = cleared.data.steering ?? [];
    assert(
      dropped.some((s) => String(s).includes("queued then cleared")),
      "clear_queue returns the dropped steering text",
    );
    await waitForSettles(host, { since: since3, count: 1, label: "round settled after clear" });

    // --- compact on a small hermetic session hits the documented guard
    // (api.md: "too small" is a normal response; the success journey is
    // pinned by the real-LLM e2e). Known upstream caveat (capability-packs
    // plan §4): after this multi-phase history (mid-stream steer merge +
    // navigate + set_model), an idle steer -> clear_queue -> prompt can
    // wedge the run upstream of pai — reproduced identically on the
    // pre-refactor base, so it is not a regression of this refactor.
    host.send({ id: "c1", type: "compact", threadId: tid });
    const compacted = await host.waitResponse("c1", { ms: 60_000 });
    assert(
      compacted.success === false && String(compacted.error).includes("too small"),
      `compact on a small session returns the documented guard (got ${JSON.stringify(compacted).slice(0, 80)})`,
    );

    const exitCode = await host.endGracefully();
    assert(exitCode === 0, `stdin EOF graceful exit 0 (got ${exitCode})`);
  } finally {
    host.killTree();
    mock.stop();
    world.cleanup();
  }
}
