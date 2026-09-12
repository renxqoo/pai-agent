// Scenario: the pi-agent-core probe backend end to end (capability-packs W3):
// boot with PAI_BACKEND=pi-agent-core against the scripted mock model, one
// chat round trip with the streaming contract, get_state/get_host_info shape
// (backend id + capabilities), honest capability failures for fork/steer/
// bash/resume, and clean teardown.

import { makeWorld, startHost, writeAgentFiles } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "agent-core-probe";
export const timeoutMs = 90_000;

const REPLY = "probe reply from the minimal backend";

export async function run({ assert }) {
  const world = makeWorld(name);
  const mock = startMockModel({
    models: { "mock-main": [{ kind: "text", text: REPLY, dripMs: 20 }] },
  });
  writeAgentFiles(world.agentDir, { mockUrl: mock.url });
  const host = startHost({ agentDir: world.agentDir, env: { PAI_BACKEND: "pi-agent-core" } });
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
    assert(start.success, "thread/start succeeds on the probe backend");
    const tid = start.data.threadId;
    assert(typeof tid === "string" && tid.length > 0, "thread/start returns threadId");

    host.send({ id: "p1", type: "prompt", threadId: tid, message: "say the probe marker" });
    const promptResp = await host.waitResponse("p1", { ms: 15_000 });
    assert(promptResp.success, "prompt accepted");
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: "settled",
      ms: 30_000,
    });

    const events = host.frames.filter((f) => f.type === "event").map((f) => f.event);
    const settledCount = events.filter((e) => e.type === "agent_settled").length;
    assert(settledCount === 1, `agent_settled exactly once (got ${settledCount})`);

    const updates = events.filter(
      (e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta",
    );
    const stitched = updates.map((e) => e.assistantMessageEvent.delta).join("");
    assert(
      stitched === REPLY,
      `delta stitching reproduces the reply (got ${stitched.slice(0, 40)}…)`,
    );
    assert(
      !updates.some(
        (e) => e.assistantMessageEvent.partial !== undefined || e.message !== undefined,
      ),
      "message_update frames carry no cumulative snapshot",
    );
    const endFrame = events.find(
      (e) => e.type === "message_end" && e.message?.role === "assistant",
    );
    const endText = endFrame?.message?.content?.find((b) => b.type === "text")?.text;
    assert(endText === REPLY, "message_end is authoritative");

    host.send({ id: "g1", type: "get_state", threadId: tid });
    const state = await host.waitResponse("g1");
    assert(state.success, "get_state succeeds (core command)");
    assert(state.data.isStreaming === false, "get_state.isStreaming false after settle");

    host.send({ id: "h1", type: "get_host_info" });
    const info = await host.waitResponse("h1");
    assert(
      info.success && info.data.backend?.id === "pi-agent-core",
      "get_host_info reports the backend id",
    );
    assert(
      Array.isArray(info.data.backend?.capabilities) &&
        info.data.backend.capabilities.includes("model.list"),
      "get_host_info.backend.capabilities includes model.list",
    );
    assert(
      !info.data.backend.capabilities.includes("session.fork"),
      "probe capabilities honestly exclude session.fork",
    );

    // Capability-gated commands fail with the v0.8 contract error shape.
    const gated = [
      { id: "f1", type: "fork", threadId: tid, entryId: "none" },
      { id: "st1", type: "steer", threadId: tid, message: "x" },
      { id: "b1", type: "bash", threadId: tid, command: "echo hi" },
      { id: "r1", type: "thread/resume", sessionPath: "/tmp/nope.jsonl" },
      { id: "gi1", type: "get_inflight", threadId: tid },
    ];
    for (const cmd of gated) {
      host.send(cmd);
      const resp = await host.waitResponse(cmd.id);
      assert(
        !resp.success && resp.error.startsWith("Unsupported capability:"),
        `${cmd.type} fails with the unsupported-capability error (got ${resp.error})`,
      );
    }

    host.send({ id: "l1", type: "thread/list" });
    const list = await host.waitResponse("l1");
    assert(list.success && list.data.threads.length === 1, "thread/list sees the probe thread");

    host.send({ id: "t1", type: "thread/stop", threadId: tid });
    const stop = await host.waitResponse("t1");
    assert(stop.success, "thread/stop succeeds (core command)");

    // Capability gate precedes the non-live short-circuit (design.md v0.14):
    // a dead thread on a backend without session.inflight must still get the
    // capability error, never the empty form.
    host.send({ id: "gi2", type: "get_inflight", threadId: tid });
    const gatedDead = await host.waitResponse("gi2");
    assert(
      !gatedDead.success && gatedDead.error.startsWith("Unsupported capability:"),
      `dead-thread get_inflight is capability-gated, not empty-form (got ${gatedDead.error})`,
    );

    const exitCode = await host.endGracefully();
    assert(exitCode === 0, `stdin EOF graceful exit 0 (got ${exitCode})`);
  } finally {
    host.killTree();
    mock.stop();
    world.cleanup();
  }
}
