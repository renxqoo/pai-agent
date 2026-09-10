// Scenario: the v0.11 /compact hub interception journey (T26): the builtin
// get_commands entry, the line-start lexing (hits vs misses), compact-timing
// responses (the response settles after the compaction events, not at
// acceptance), error passthrough on the documented "too small" guard, and
// the capability matrix — the pi-agent-core probe backend lists no builtin
// entry and does not intercept (the message goes to the model verbatim).

import { makeWorld, startHost, writeAgentFiles } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "compact-intercept";
export const timeoutMs = 120_000;

const REPLY = "plain reply for the compact-intercept journey";

const isEvent = (type) => (f) => f.type === "event" && f.event?.type === type;

export async function run({ assert }) {
  // --- leg 1: default pi-coding-agent backend (session.compact supported)
  const world = makeWorld(name);
  const mock = startMockModel({
    models: {
      "mock-main": [
        { kind: "text", text: REPLY },
        { kind: "text", text: REPLY },
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

    // Directory: the builtin compact entry is listed (fourth source).
    host.send({ id: "gc1", type: "get_commands", threadId: tid });
    const commands = await host.waitResponse("gc1", { ms: 15_000 });
    const builtin = commands.data.commands.filter((c) => c.source === "builtin");
    assert(
      builtin.length === 1 &&
        builtin[0].name === "compact" &&
        builtin[0].description === "Manually compact the session context",
      `builtin compact entry listed (${JSON.stringify(builtin)})`,
    );

    // Intercepted bare /compact on an empty session: the documented guard
    // fails through the compact machinery — compaction_start/end flow and
    // the response settles AFTER compaction_end (compact timing, not
    // fire-and-accept; a pass-through would ack success at acceptance).
    const since1 = host.frames.length;
    host.send({ id: "p1", type: "prompt", threadId: tid, message: "/compact" });
    const resp1 = await host.waitResponse("p1", { ms: 60_000 });
    assert(
      resp1.success === false && String(resp1.error).includes("too small"),
      `intercepted /compact returns the documented guard (got ${JSON.stringify(resp1).slice(0, 100)})`,
    );
    const compactionEnd = host.frames.slice(since1).find(isEvent("compaction_end"));
    assert(compactionEnd !== undefined, "compaction_end flowed for the manual compaction");
    assert(
      host.frames.indexOf(compactionEnd) < host.frames.indexOf(resp1),
      "the response settled after compaction_end (compact timing)",
    );
    assert(host.frames.slice(since1).some(isEvent("compaction_start")), "compaction_start flowed");

    // The instructions variant hits the same path (customInstructions is
    // trailing text; the session is still too small to compact).
    host.send({ id: "p2", type: "prompt", threadId: tid, message: "/compact  focus on tests " });
    const resp2 = await host.waitResponse("p2", { ms: 60_000 });
    assert(
      resp2.success === false && String(resp2.error).includes("too small"),
      `/compact with instructions is intercepted the same way (got ${JSON.stringify(resp2).slice(0, 100)})`,
    );

    // Lexical misses pass through as ordinary messages: the model answers.
    const since3 = host.frames.length;
    host.send({ id: "p3", type: "prompt", threadId: tid, message: "/compactfoo" });
    const resp3 = await host.waitResponse("p3", { ms: 15_000 });
    assert(resp3.success, "lexically missed /compactfoo is accepted as an ordinary prompt");
    await host.waitFrame(isEvent("agent_settled"), {
      label: "model round settled for /compactfoo",
      ms: 60_000,
      since: since3,
    });
    const since4 = host.frames.length;
    host.send({ id: "p4", type: "prompt", threadId: tid, message: " /compact" });
    const resp4 = await host.waitResponse("p4", { ms: 15_000 });
    assert(resp4.success, "leading whitespace defeats the line-start lexing (ordinary prompt)");
    await host.waitFrame(isEvent("agent_settled"), {
      label: "model round settled for leading-space /compact",
      ms: 60_000,
      since: since4,
    });

    const exitCode = await host.endGracefully();
    assert(exitCode === 0, `stdin EOF graceful exit 0 (got ${exitCode})`);
  } finally {
    host.killTree();
    mock.stop();
    world.cleanup();
  }

  // --- leg 2: pi-agent-core probe backend (no session.compact bit)
  const world2 = makeWorld(`${name}-core`);
  const mock2 = startMockModel({
    models: { "mock-core": [{ kind: "text", text: REPLY, dripMs: 20 }] },
  });
  writeAgentFiles(world2.agentDir, { mockUrl: mock2.url, models: ["mock-core"] });
  const host2 = startHost({ agentDir: world2.agentDir, env: { PAI_BACKEND: "pi-agent-core" } });
  try {
    await host2.waitFrame((f) => f.type === "heartbeat", { label: "probe heartbeat", ms: 15_000 });
    host2.send({
      id: "s2",
      type: "thread/start",
      provider: "mock",
      modelId: "mock-core",
      cwd: world2.projectDir,
    });
    const start2 = await host2.waitResponse("s2", { ms: 20_000 });
    assert(start2.success, "thread/start succeeds on the probe backend");
    const tid2 = start2.data.threadId;

    host2.send({ id: "gc2", type: "get_commands", threadId: tid2 });
    const commands2 = await host2.waitResponse("gc2", { ms: 15_000 });
    assert(
      !commands2.data.commands.some((c) => c.source === "builtin"),
      "probe backend lists no builtin entry (capability-gated)",
    );

    // No interception without the capability bit: /compact is accepted as an
    // ordinary prompt (fire-and-accept ack) and the model answers it.
    host2.send({ id: "p5", type: "prompt", threadId: tid2, message: "/compact" });
    const resp5 = await host2.waitResponse("p5", { ms: 15_000 });
    assert(resp5.success, "probe backend does not intercept /compact (accepted as a message)");
    await host2.waitFrame(isEvent("agent_settled"), {
      label: "probe model round settled",
      ms: 30_000,
    });
  } finally {
    host2.killTree();
    mock2.stop();
    world2.cleanup();
  }
}
