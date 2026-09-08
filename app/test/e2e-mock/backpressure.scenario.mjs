// Scenario: stdout backpressure — a client that stops reading while the host
// emits megabyte-scale frames. The stdout guard must block/retry (ENOBUFS
// path) without dropping frames or dying; once the client resumes, every
// pending response arrives and the heartbeat is current again. Plan
// 2026-09-09-production-hardening.md §7.9.

import { makeWorld, startHost, writeAgentFiles, writeRules } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "backpressure";
export const timeoutMs = 120_000;

// 12 direct-bash rounds x 100KB of output (pi truncates what it records
// per result) => a large get_messages frame, well past pipe-buffer scale.
const ROUNDS = 12;
const PAD_COMMAND = "head -c 100000 /dev/zero | tr '\\0' 'x'";

export async function run({ assert }) {
  const world = makeWorld(name);
  const mock = startMockModel({});
  writeAgentFiles(world.agentDir, { mockUrl: mock.url });
  writeRules(world.agentDir, { bash: { allowPatterns: ["head *", "tr *", "echo *"] } });
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

    for (let i = 1; i <= ROUNDS; i++) {
      host.send({ id: `b${i}`, type: "bash", threadId: tid, command: PAD_COMMAND });
      const r = await host.waitResponse(`b${i}`, { ms: 60_000 });
      // pi truncates what it records per bash result; only success + material
      // size matter here (the goal is a large get_messages frame).
      assert(r.success && (r.data.output?.length ?? 0) >= 10_000, `padding bash ${i}/${ROUNDS}`);
    }

    // Stop reading. While frozen, queue a megabyte-scale read plus a burst of
    // cheap commands; the host must survive the blocked pipe.
    const framesBefore = host.frames.length;
    host.proc.stdout.pause();
    const pendingIds = ["big", "h1", "h2", "h3", "h4", "h5"];
    host.send({ id: "big", type: "get_messages", threadId: tid });
    for (const id of pendingIds.slice(1)) {
      host.send({ id, type: "get_state", threadId: tid });
    }
    await new Promise((done) => {
      setTimeout(done, 1_500);
    });
    assert(host.alive(), "host alive while the client stops reading stdout");
    assert(host.frames.length === framesBefore, "no frames observed while paused");

    // Resume reading: everything queued must drain, exactly one response per id.
    host.proc.stdout.resume();
    const big = await host.waitResponse("big", { ms: 60_000 });
    const bigBytes = JSON.stringify(big.data ?? "").length;
    assert(
      bigBytes > 500_000,
      `megabyte-scale frame drained intact (${Math.round(bigBytes / 1000)}KB)`,
    );
    for (const id of pendingIds.slice(1)) {
      const r = await host.waitResponse(id, { ms: 30_000 });
      assert(r.success, `queued command ${id} answered after drain`);
    }
    const drainIdx = host.frames.indexOf(big);
    await host.waitFrame((f) => f.type === "heartbeat", {
      label: "heartbeat current after drain",
      ms: 15_000,
      since: drainIdx,
    });
    assert(host.alive(), "host alive after the drain");

    // The thread still works after the episode.
    host.send({ id: "b-after", type: "bash", threadId: tid, command: "echo after-backpressure" });
    const after = await host.waitResponse("b-after", { ms: 30_000 });
    assert(
      after.success && /after-backpressure/.test(after.data.output ?? ""),
      "thread fully usable after backpressure",
    );

    const exitCode = await host.endGracefully();
    assert(exitCode === 0, `stdin EOF graceful exit 0 (got ${exitCode})`);
  } finally {
    host.killTree();
    mock.stop();
    world.cleanup();
  }
}
