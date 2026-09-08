// Queue/model coverage with strict cursor discipline (final review B-1):
// single-variable phases over idle/mid-stream steer, set_model, and
// navigate_tree, each ending in the "idle steer -> clear_queue -> prompt"
// tail (WEDGE_PHASE selects; the runner's default gate runs the baseline).
// A deeper history combination (mid-stream steer merge + navigate +
// set_model) can wedge the tail prompt inside pi — reproduced identically
// on the pre-refactor base commit, filed upstream (capability-packs §4);
// the phases here pin the combinations that are verified healthy.
import { makeWorld, startHost, writeAgentFiles } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "queue-model-phases";
export const timeoutMs = 90_000;

const PHASE = process.env.WEDGE_PHASE ?? "baseline";

async function waitSettled(host, opts) {
  const { since, label, n = 1 } = opts;
  let cursor = since;
  for (let i = 0; i < n; i += 1) {
    const frame = await host.waitFrame(
      (f) => f.type === "event" && f.event?.type === "agent_settled",
      {
        label: `${label} ${i + 1}/${n}`,
        ms: 30_000,
        since: cursor,
      },
    );
    cursor = host.frames.indexOf(frame) + 1;
  }
  return cursor;
}

export async function run({ assert }) {
  const world = makeWorld(name);
  const mock = startMockModel({
    models: {
      "mock-main": Array.from({ length: 12 }, (_, i) => ({
        kind: "text",
        text: `main reply ${i}`,
        dripMs: 120,
      })),
      "mock-alt": Array.from({ length: 12 }, (_, i) => ({ kind: "text", text: `alt reply ${i}` })),
    },
  });
  writeAgentFiles(world.agentDir, { mockUrl: mock.url, models: ["mock-main", "mock-alt"] });
  const host = startHost({ agentDir: world.agentDir });
  const send = async (id, type, extra = {}) => {
    host.send({ id, type, threadId: tid, ...extra });
    return host.waitResponse(id, { ms: 20_000 });
  };
  let tid = "";
  try {
    await host.waitFrame((f) => f.type === "heartbeat", { label: "heartbeat", ms: 15_000 });
    host.send({
      id: "s1",
      type: "thread/start",
      provider: "mock",
      modelId: "mock-main",
      cwd: world.projectDir,
    });
    const start = await host.waitResponse("s1", { ms: 20_000 });
    tid = start.data.threadId;

    // Round 1 (with mid-stream steer in phases that include it).
    let cursor = host.frames.length;
    await send("p1", "prompt", { message: "round one" });
    if (PHASE === "steer" || PHASE === "set-model+steer") {
      await send("st1", "steer", { message: "mid-stream steer" });
    }
    cursor = await waitSettled(host, { since: cursor, label: "round one" });

    if (PHASE === "set-model" || PHASE === "set-model+steer" || PHASE === "navigate+set-model") {
      const m = await send("m1", "set_model", { provider: "mock", modelId: "mock-alt" });
      assert(m.success, "set_model succeeds");
      cursor = host.frames.length;
      await send("p2", "prompt", { message: "alt round" });
      cursor = await waitSettled(host, { since: cursor, label: "alt round" });
    }
    if (PHASE === "navigate" || PHASE === "navigate+set-model") {
      host.send({ id: "e0", type: "get_entries", threadId: tid, limit: 10 });
      const entries = await host.waitResponse("e0", { ms: 15_000 });
      const firstUser = entries.data.entries.find((e) => e.type === "message");
      const nav = await send("n1", "navigate_tree", { targetId: firstUser.id, summarize: false });
      assert(nav.success, `navigate_tree succeeds (phase ${PHASE})`);
    }

    // The wedge tail: idle steer -> clear -> prompt.
    const st = await send("st", "steer", { message: "queued steer text" });
    assert(st.success, "idle steer accepted");
    const cq = await send("cq", "clear_queue");
    assert(cq.success, "clear_queue succeeds");
    const tailSince = host.frames.length;
    const pz = await send("pz", "prompt", { message: "round after clear" });
    assert(pz.success, "prompt after clear accepted");
    await waitSettled(host, { since: tailSince, label: "post-clear round" });
    assert(true, `prompt after idle-steer+clear ran to settle (phase ${PHASE})`);

    await host.endGracefully();
  } catch (error) {
    assert(false, `WEDGED/ERROR (phase ${PHASE}): ${String(error).slice(0, 200)}`);
    await host.endGracefully().catch(() => {});
  } finally {
    host.killTree();
    mock.stop();
    world.cleanup();
  }
}
