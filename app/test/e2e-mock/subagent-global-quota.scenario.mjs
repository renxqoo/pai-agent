// Scenario: the v0.6 global running-grandchild cap (PAI_MAX_SUBAGGENTS),
// host-arbitrated via grant leases. With the cap at 1, a parallel batch of
// two tasks runs exactly one grandchild; the denied task fails immediately
// with the retryable "global subagent limit" error; the heartbeat in-flight
// count stays at 1; every lease is released after the batch settles.
// Plan 2026-09-09-production-hardening.md §7.10.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, startHost, writeAgentFiles } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "subagent-global-quota";
export const timeoutMs = 120_000;

const AGENT_DEF = `---
name: worker
description: quota test worker
---
You are a test worker; reply with the requested marker.
`;

export async function run({ assert }) {
  const world = makeWorld(name);
  // The grandchild reuses the parent's model id, so the queue is strictly
  // ordered: lead delegates (#1), the single granted grandchild streams its
  // marker slowly enough to span heartbeat ticks (#2, drip), lead wraps up
  // (#3). The denied task never reaches the mock (denied before spawn).
  const mock = startMockModel({
    models: {
      "mock-main": [
        {
          kind: "tool",
          name: "task",
          args: {
            tasks: [
              { agent: "worker", task: "say quota-marker-one" },
              { agent: "worker", task: "say quota-marker-two" },
            ],
          },
        },
        { kind: "text", text: "quota-marker-one", dripMs: 300 },
        { kind: "text", text: "batch settled" },
      ],
    },
  });
  writeAgentFiles(world.agentDir, { mockUrl: mock.url });
  const agentsDir = join(world.agentDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "worker.md"), AGENT_DEF);

  const host = startHost({ agentDir: world.agentDir, env: { PAI_MAX_SUBAGENTS: "1" } });
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

    host.send({ id: "q1", type: "get_host_info" });
    const info0 = await host.waitResponse("q1", { ms: 15_000 });
    assert(
      info0.success && info0.data.limits.maxSubagents === 1,
      "get_host_info echoes PAI_MAX_SUBAGENTS=1",
    );

    const window = host.frames.length;
    host.send({ id: "p1", type: "prompt", threadId: tid, message: "run the parallel pair" });
    assert((await host.waitResponse("p1", { ms: 15_000 })).success, "delegation prompt accepted");
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: "delegation round settled",
      ms: 60_000,
      since: window,
    });

    // Exactly one grandchild ever ran: subagent_event frames group under a
    // single subagentId and the mock served exactly one wildcard step.
    const subIds = new Set(
      host.frames
        .slice(window)
        .filter((f) => f.type === "subagent_event")
        .map((f) => f.subagentId),
    );
    assert(subIds.size === 1, `exactly one grandchild ran (got ${subIds.size})`);
    assert(
      mock.requests.length === 3,
      `exactly three model requests: lead, grandchild, wrap-up (got ${mock.requests.length})`,
    );

    // The denied task surfaces the retryable limit error in the tool result.
    const deniedSeen = host.frames
      .slice(window)
      .some(
        (f) =>
          f.type === "event" &&
          JSON.stringify(f.event ?? {}).includes("global subagent limit reached"),
      );
    assert(deniedSeen, "denied task reports the global limit error");

    // In-flight heartbeat peaked at exactly one running task.
    const peak = Math.max(
      0,
      ...host.frames.slice(window).map((f) => (f.type === "heartbeat" ? (f.subagents ?? 0) : 0)),
    );
    assert(peak === 1, `heartbeat subagents peaked at 1 (got ${peak})`);

    // The lead wrapped up normally after the batch.
    const endMsg = host.frames
      .slice(window)
      .filter(
        (f) =>
          f.type === "event" &&
          f.event?.type === "message_end" &&
          f.event.message?.role === "assistant",
      )
      .at(-1);
    assert(
      endMsg?.event?.message?.content?.find((b) => b.type === "text")?.text === "batch settled",
      "lead conversation settles normally after the mixed batch",
    );

    // Every lease was released: the ledger is back to zero.
    host.send({ id: "q2", type: "get_host_info" });
    const info1 = await host.waitResponse("q2", { ms: 15_000 });
    assert(
      info1.success && info1.data.subagents.running === 0,
      "grant ledger fully released after settle",
    );

    const exitCode = await host.endGracefully();
    assert(exitCode === 0, `stdin EOF graceful exit 0 (got ${exitCode})`);
  } finally {
    host.killTree();
    mock.stop();
    world.cleanup();
  }
}
