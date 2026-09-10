// Scenario: the idle-retire/wake loop under a shrunken knob (3s) — the
// memory-shape contract of v0.4 (migration/design.md §6): parked = zero
// resident workers, wake transparent, threadId stable across cycles, and no
// worker accumulation. RSS boundedness of the HOST is sampled via ps.
// Plan 2026-09-09-production-hardening.md §7.8.

import { spawnSync } from "node:child_process";
import { makeWorld, startHost, writeAgentFiles } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "retire-wake-cycle";
export const timeoutMs = 180_000;

const CYCLES = 3;
const IDLE_RETIRE_MS = 3_000;

function hostRssKb(pid) {
  const out = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  const value = Number((out.stdout ?? "").trim());
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export async function run({ assert }) {
  const world = makeWorld(name);
  const mock = startMockModel({
    models: {
      "mock-main": [
        { kind: "text", text: "cycle-round-one persists the session" },
        { kind: "text", text: "wake round works" },
        { kind: "text", text: "wake round works" },
        { kind: "text", text: "wake round works" },
      ],
    },
  });
  writeAgentFiles(world.agentDir, { mockUrl: mock.url });
  const host = startHost({
    agentDir: world.agentDir,
    env: { PAI_IDLE_RETIRE_MS: String(IDLE_RETIRE_MS) },
  });
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

    // Round 1 persists the session (retire requires a persisted path).
    const w0 = host.frames.length;
    host.send({ id: "p0", type: "prompt", threadId: tid, message: "persisting round" });
    assert((await host.waitResponse("p0", { ms: 15_000 })).success, "round 1 accepted");
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: "round 1 settled",
      ms: 30_000,
      since: w0,
    });
    const rssBaseline = hostRssKb(host.proc.pid);
    assert(rssBaseline > 0, "host RSS baseline sampled");

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      // Frame window for this cycle's retirement assertions (frames accumulate
      // across cycles; each cycle parks exactly once).
      const cycleStart = host.frames.length;
      // Park: poll thread/list (host-local, never wakes the worker) until the
      // idle retire moves the thread to parked.
      let parked = false;
      let pollSeq = 0;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !parked) {
        pollSeq += 1; // unique id per poll: a repeated id would match its own stale response
        const pollId = `ls${cycle}_${pollSeq}`;
        host.send({ id: pollId, type: "thread/list" });
        const list = await host.waitResponse(pollId, { ms: 15_000 });
        parked = list.data.threads.some((t) => t.threadId === tid && t.state === "parked");
        if (!parked) {
          await new Promise((done) => {
            setTimeout(done, 500);
          });
        }
      }
      assert(parked, `cycle ${cycle}: thread parks within ${IDLE_RETIRE_MS}ms + margin`);
      assert(host.workerPids().length === 0, `cycle ${cycle}: parked means zero worker processes`);
      // v0.13: the retirement is observable — exactly one thread_parked frame
      // with the idle origin, and the parked row carries the zeroed facts.
      const parkedFrames = host.frames
        .slice(cycleStart)
        .filter((f) => f.type === "thread_parked" && f.threadId === tid);
      assert(
        parkedFrames.length === 1 && parkedFrames[0].reason === "idle",
        `cycle ${cycle}: exactly one thread_parked(reason idle)`,
      );
      {
        const row = host.frames.length; // marker: facts asserted via a fresh list below
        host.send({ id: `lf${cycle}_${row}`, type: "thread/list" });
        const facts = await host.waitResponse(`lf${cycle}_${row}`, { ms: 15_000 });
        const entry = facts.data.threads.find((t) => t.threadId === tid);
        assert(entry?.state === "parked", `cycle ${cycle}: list row parked`);
        assert(
          entry?.idleMs === 0 && entry?.subagents === 0,
          `cycle ${cycle}: parked facts zeroed`,
        );
        assert(entry?.rssBytes === null, `cycle ${cycle}: parked rssBytes null`);
        assert(entry?.keepalive === false, `cycle ${cycle}: parked keepalive false`);
      }

      // Wake: an ordinary command transparently revives the same threadId.
      const ww = host.frames.length;
      host.send({ id: `p${cycle}`, type: "prompt", threadId: tid, message: `wake round ${cycle}` });
      const wakeResp = await host.waitResponse(`p${cycle}`, { ms: 30_000 });
      assert(wakeResp.success, `cycle ${cycle}: wake prompt accepted`);
      await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
        label: `cycle ${cycle} wake settled`,
        ms: 30_000,
        since: ww,
      });
      const endMsg = host.frames
        .slice(ww)
        .filter(
          (f) =>
            f.type === "event" &&
            f.event?.type === "message_end" &&
            f.event.message?.role === "assistant",
        )
        .at(-1);
      assert(
        endMsg?.event?.message?.content?.find((b) => b.type === "text")?.text ===
          "wake round works",
        `cycle ${cycle}: wake round served the scripted reply`,
      );
      const listAfter = await (async () => {
        host.send({ id: `la${cycle}`, type: "thread/list" });
        return host.waitResponse(`la${cycle}`, { ms: 15_000 });
      })();
      const entry = listAfter.data.threads.find((t) => t.threadId === tid);
      assert(entry?.state === "live", `cycle ${cycle}: thread is live again after wake`);
      assert(
        !host.frames.some((f) => f.type === "thread_died"),
        `cycle ${cycle}: no thread_died in a clean cycle`,
      );
    }

    assert(host.workerPids().length === 1, "exactly one worker alive after the final wake");
    const rssFinal = hostRssKb(host.proc.pid);
    assert(
      rssFinal <= rssBaseline + 80_000,
      `host RSS bounded across cycles (baseline ${rssBaseline}KB -> ${rssFinal}KB)`,
    );

    const exitCode = await host.endGracefully();
    assert(exitCode === 0, `stdin EOF graceful exit 0 (got ${exitCode})`);
  } finally {
    host.killTree();
    mock.stop();
    world.cleanup();
  }
}
