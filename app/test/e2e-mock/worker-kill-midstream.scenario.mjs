// Scenario: SIGKILL a worker at two load-bearing moments and verify the
// recovery contract (migration/design.md §6): exactly one synthesized
// failure for the in-flight command id, thread_died exactly once, and
// transparent revival on the next command. (a) kill while a long direct
// bash is pending — the exactly-one-response reconciliation; (b) kill
// mid-stream — history survives the crash. Plan 2026-09-09-production-hardening.md §7.3.

import { makeWorld, startHost, writeAgentFiles, writeRules } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "worker-kill-midstream";
export const timeoutMs = 120_000;

export async function run({ assert }) {
  const world = makeWorld(name);
  const mock = startMockModel({
    models: {
      "mock-main": [
        { kind: "text", text: "history round survives the later crash" },
        // Round 2 drips slowly so the kill lands deterministically mid-stream.
        { kind: "text", text: "streaming when the worker dies mid-delta", dripMs: 150 },
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

    // Round 1 completes and persists (the crash-history baseline).
    host.send({ id: "p1", type: "prompt", threadId: tid, message: "first marker" });
    assert((await host.waitResponse("p1", { ms: 15_000 })).success, "round 1 accepted");
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: "round 1 settled",
      ms: 30_000,
    });

    // (a) kill while a long direct bash holds the response pending.
    writeRules(world.agentDir, { bash: { allowPatterns: ["echo *", "sleep *"] } });
    host.send({ id: "b1", type: "bash", threadId: tid, command: "echo pai-tick && sleep 30" });
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "bash_execution_update", {
      label: "bash started",
      ms: 15_000,
    });
    const workersA = host.workerPids();
    assert(workersA.length === 1, `one worker before the kill (got ${workersA.length})`);
    process.kill(workersA[0], "SIGKILL");

    const synth = await host.waitResponse("b1", { label: "synthesized failure", ms: 20_000 });
    assert(
      !synth.success && /worker died/.test(synth.error ?? ""),
      "in-flight bash gets exactly its synthesized failure",
    );
    const diedFrames = host.frames.filter((f) => f.type === "thread_died" && f.threadId === tid);
    assert(diedFrames.length === 1, `thread_died exactly once (got ${diedFrames.length})`);
    host.send({ id: "ls1", type: "thread/list" });
    const list1 = await host.waitResponse("ls1", { ms: 15_000 });
    assert(
      list1.data.threads.some((t) => t.threadId === tid && t.state === "dead"),
      "thread/list shows state dead",
    );

    // Revival: the next command respawns + resumes transparently.
    writeRules(world.agentDir, { bash: { allowPatterns: ["echo *"] } });
    host.send({ id: "b2", type: "bash", threadId: tid, command: "echo revived" });
    const revived = await host.waitResponse("b2", { ms: 30_000 });
    assert(
      revived.success && /revived/.test(revived.data.output ?? ""),
      "next command transparently revives the dead thread",
    );
    const diedTotal = host.frames.filter(
      (f) => f.type === "thread_died" && f.threadId === tid,
    ).length;
    assert(diedTotal === 1, "no second thread_died after revival");

    // (b) kill mid-stream; the persisted history must survive the crash.
    const streamWindow = host.frames.length;
    host.send({ id: "p2", type: "prompt", threadId: tid, message: "second marker" });
    await host.waitFrame(
      (f) =>
        f.type === "event" &&
        f.event?.type === "message_update" &&
        f.event.assistantMessageEvent?.type === "text_delta",
      { label: "streaming started", ms: 30_000, since: streamWindow },
    );
    const workersB = host.workerPids();
    assert(workersB.length === 1, `one worker before the mid-stream kill (got ${workersB.length})`);
    const kill2Window = host.frames.length;
    process.kill(workersB[0], "SIGKILL");
    // Wait THIS kill's thread_died (since-scoped): death settlement must
    // complete before the next command, or it routes to the dying worker and
    // correctly comes back as a synthesized failure instead of a revival.
    const died2 = await host.waitFrame((f) => f.type === "thread_died" && f.threadId === tid, {
      label: "thread_died after mid-stream kill",
      ms: 20_000,
      since: kill2Window,
    });
    assert(died2 !== undefined, "mid-stream kill emits thread_died");
    assert(
      host.frames.filter((f) => f.type === "thread_died" && f.threadId === tid).length === 2,
      "exactly two thread_died frames across both kills",
    );

    host.send({ id: "b3", type: "bash", threadId: tid, command: "echo alive" });
    assert((await host.waitResponse("b3", { ms: 30_000 })).success, "thread revives again");
    host.send({ id: "m1", type: "get_messages", threadId: tid });
    const msgs = (await host.waitResponse("m1", { ms: 30_000 })).data.messages;
    assert(
      JSON.stringify(msgs).includes("history round survives the later crash"),
      "pre-crash history survived the mid-stream worker death",
    );

    const exitCode = await host.endGracefully();
    assert(exitCode === 0, `stdin EOF graceful exit 0 (got ${exitCode})`);
  } finally {
    host.killTree();
    mock.stop();
    world.cleanup();
  }
}
