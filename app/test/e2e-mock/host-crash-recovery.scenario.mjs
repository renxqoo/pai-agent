// Scenario: the full client-recovery drill from the README reliability
// contract, automated: conversations with known content -> host SIGKILL ->
// workers self-exit -> a NEW host on the same agentDir -> resume both
// sessions -> content identical verbatim -> conversations continue working.
// Plan 2026-09-09-production-hardening.md §7.4.

import { makeWorld, startHost, writeAgentFiles } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "host-crash-recovery";
export const timeoutMs = 120_000;

const ALPHA = "alpha-content-known-verbatim-7f3a";
const BETA = "beta-content-known-verbatim-c91d";

export async function run({ assert }) {
  const world = makeWorld(name);
  const mock = startMockModel({
    models: {
      "mock-main": [
        { kind: "text", text: ALPHA },
        { kind: "text", text: BETA },
        { kind: "text", text: "post-recovery round works" },
        { kind: "text", text: "post-recovery second thread works" },
      ],
    },
  });
  writeAgentFiles(world.agentDir, { mockUrl: mock.url });

  const host1 = startHost({ agentDir: world.agentDir });
  let sessionA = "";
  let sessionB = "";
  try {
    await host1.waitFrame((f) => f.type === "heartbeat", { label: "host1 heartbeat", ms: 15_000 });
    const threads = [];
    for (const id of ["s1", "s2"]) {
      host1.send({
        id,
        type: "thread/start",
        provider: "mock",
        modelId: "mock-main",
        cwd: world.projectDir,
      });
      const r = await host1.waitResponse(id, { ms: 20_000 });
      assert(r.success, `${id} thread/start succeeds`);
      threads.push(r.data.threadId);
    }
    sessionA = (await host1.waitResponse("s1")).data.sessionPath;
    sessionB = (await host1.waitResponse("s2")).data.sessionPath;

    for (const [pid, tid, label] of [
      ["p1", threads[0], "thread one round"],
      ["p2", threads[1], "thread two round"],
    ]) {
      host1.send({ id: pid, type: "prompt", threadId: tid, message: label });
      const window = host1.frames.length;
      assert((await host1.waitResponse(pid, { ms: 15_000 })).success, `${pid} accepted`);
      await host1.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
        label: `${pid} settled`,
        ms: 30_000,
        since: window,
      });
    }
    assert(
      typeof sessionA === "string" && sessionA !== sessionB,
      "two distinct session paths recorded",
    );

    const workers = host1.workerPids();
    assert(workers.length === 2, `two live workers before the crash (got ${workers.length})`);

    // SIGKILL the host; workers must self-exit via stdin EOF (no orphans).
    host1.proc.kill("SIGKILL");
    const deadline = Date.now() + 20_000;
    let gone = false;
    while (Date.now() < deadline && !gone) {
      gone = host1.workerPids().length === 0;
      if (!gone) {
        await new Promise((done) => {
          setTimeout(done, 250);
        });
      }
    }
    assert(gone, "workers self-exit within 20s of host SIGKILL (stdin EOF)");

    await host1.waitExit(10_000);
    assert(host1.exited, "host1 process is gone after SIGKILL");
  } finally {
    host1.killTree();
  }

  // New host on the same agentDir; resume both sessions by recorded path.
  const host2 = startHost({ agentDir: world.agentDir });
  try {
    await host2.waitFrame((f) => f.type === "heartbeat", { label: "host2 heartbeat", ms: 15_000 });
    const resumed = [];
    for (const [id, path] of [
      ["r1", sessionA],
      ["r2", sessionB],
    ]) {
      host2.send({ id, type: "thread/resume", sessionPath: path });
      const r = await host2.waitResponse(id, { ms: 30_000 });
      assert(r.success, `${id} resume succeeds on the fresh host (${r.error ?? "ok"})`);
      resumed.push(r.success ? r.data.threadId : "");
    }

    for (const [id, tid, marker] of [
      ["m1", resumed[0], ALPHA],
      ["m2", resumed[1], BETA],
    ]) {
      host2.send({ id, type: "get_messages", threadId: tid });
      const msgs = (await host2.waitResponse(id, { ms: 30_000 })).data.messages;
      assert(
        JSON.stringify(msgs).includes(marker),
        `resumed content preserved verbatim (${marker.slice(0, 5)}…)`,
      );
    }

    // The recovered conversations keep working (post-recovery model rounds).
    for (const [pid, tid] of [
      ["p3", resumed[0]],
      ["p4", resumed[1]],
    ]) {
      const window = host2.frames.length;
      host2.send({ id: pid, type: "prompt", threadId: tid, message: "post-crash round" });
      assert(
        (await host2.waitResponse(pid, { ms: 15_000 })).success,
        `${pid} accepted after recovery`,
      );
      await host2.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
        label: `${pid} settled after recovery`,
        ms: 30_000,
        since: window,
      });
    }
    host2.send({ id: "ls", type: "thread/list" });
    const list = await host2.waitResponse("ls", { ms: 15_000 });
    assert(
      list.data.threads.length === 2 && list.data.threads.every((t) => t.state === "live"),
      "thread/list shows both recovered threads live",
    );

    const exitCode = await host2.endGracefully();
    assert(exitCode === 0, `host2 graceful exit 0 (got ${exitCode})`);
  } finally {
    host2.killTree();
    mock.stop();
    world.cleanup();
  }
}
