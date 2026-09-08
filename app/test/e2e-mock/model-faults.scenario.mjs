// Scenario: provider fault injection through the scripted mock — the three
// failure classes a real LLM endpoint produces, each with a pinned observable
// outcome: (a) HTTP 400 → the round recovers via session auto-retry (fast
// backoff configured); (b) stall → the turn hangs until the client aborts,
// thread stays usable (proven via direct bash: aborting a stalled request can
// trigger provider-level retries that consume queued mock steps, so a
// follow-up prompt here would couple the fault classes); (c) stream-cut (no
// finish_reason) → retry recovers. The thread must survive all three. Plan
// 2026-09-09-production-hardening.md §7.7.

import { makeWorld, startHost, writeAgentFiles, writeRules } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "model-faults";
export const timeoutMs = 120_000;

function makeRoundDriver(host, tid) {
  return async ({ id, label }) => {
    const window = host.frames.length;
    host.send({ id, type: "prompt", threadId: tid, message: label });
    const resp = await host.waitResponse(id, { ms: 15_000 });
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: `${label} settled`,
      ms: 45_000,
      since: window,
    });
    return { window, resp };
  };
}

function assistantEnd(host, since) {
  const ends = host.frames
    .slice(since)
    .filter(
      (f) =>
        f.type === "event" &&
        f.event?.type === "message_end" &&
        f.event.message?.role === "assistant",
    );
  return ends.at(-1)?.event?.message;
}

export async function run({ assert }) {
  const world = makeWorld(name);
  const mock = startMockModel({
    models: {
      "mock-main": [
        // (a) pinned behavior: a 400 is NOT retried (non-retryable class) and
        // consumes exactly one request; the next round serves the next step.
        { kind: "error", status: 400, message: "mock bad request" },
        { kind: "text", text: "round-after-400" },
        // (b) stall, aborted by the client; nothing queued behind it.
        { kind: "stall" },
        // (c) stream cut, then the recovery text.
        { kind: "cut", text: "cut-partial" },
        { kind: "text", text: "ok-after-cut" },
      ],
    },
  });
  writeAgentFiles(world.agentDir, {
    mockUrl: mock.url,
    // Session auto-retry with a fast backoff: keeps the scenario seconds-scale
    // while still exercising the real retry path (defaults: 3 retries, 2s+).
    settings: {
      enableInstallTelemetry: false,
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 },
    },
  });
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

    // (a) HTTP 400: pinned — surfaces immediately as an error end message,
    // no auto-retry (non-retryable class), thread usable on the next round.
    const driveRound = makeRoundDriver(host, tid);
    const a = await driveRound({ id: "p1", label: "the 400 round" });
    assert(a.resp.success, "prompt(400 round) accepted");
    const aMsg = assistantEnd(host, a.window);
    assert(
      aMsg !== undefined && (aMsg.stopReason === "error" || typeof aMsg.errorMessage === "string"),
      "400 round ends with an error message",
    );
    assert(
      !host.frames
        .slice(a.window)
        .some((f) => f.type === "event" && f.event?.type === "auto_retry_start"),
      "400 round is not auto-retried",
    );
    const a2 = await driveRound({ id: "p1b", label: "round after 400" });
    const a2Msg = assistantEnd(host, a2.window);
    assert(
      a2Msg?.content?.find((x) => x.type === "text")?.text === "round-after-400",
      "next round serves normally after a 400",
    );

    // (b) stall: nothing arrives; the client aborts; the thread stays usable.
    const bWindow = host.frames.length;
    host.send({ id: "p2", type: "prompt", threadId: tid, message: "the stalled round" });
    assert((await host.waitResponse("p2", { ms: 15_000 })).success, "stalled prompt accepted");
    const quiet = !(await host.sawFrame(
      (f) =>
        f.type === "event" &&
        f.event?.type === "message_update" &&
        f.event.assistantMessageEvent?.type === "text_delta",
      { label: "no deltas while stalled", ms: 1_500, since: bWindow },
    ));
    assert(quiet, "stalled model produces no deltas");
    host.send({ id: "ab1", type: "abort", threadId: tid });
    assert((await host.waitResponse("ab1", { ms: 15_000 })).success, "abort accepted");
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: "aborted round settled",
      ms: 20_000,
      since: bWindow,
    });
    writeRules(world.agentDir, { bash: { allowPatterns: ["echo *"] } });
    host.send({ id: "bash1", type: "bash", threadId: tid, command: "echo usable-after-abort" });
    const bash1 = await host.waitResponse("bash1", { ms: 30_000 });
    assert(
      bash1.success && /usable-after-abort/.test(bash1.data.output ?? ""),
      "thread fully usable after a stalled+aborted round (direct bash)",
    );

    // (c) stream-cut: connection-class fault. One observation run pins the
    // branch (retry-recovers vs immediate error surface) before this assert
    // is tightened to a single outcome.
    const c = await driveRound({ id: "p4", label: "the cut round" });
    assert(c.resp.success, "prompt(cut round) accepted");
    const cMsg = assistantEnd(host, c.window);
    assert(
      host.frames
        .slice(c.window)
        .some((f) => f.type === "event" && f.event?.type === "auto_retry_start"),
      "cut round emits auto_retry_start (connection-class fault is retried)",
    );
    assert(
      cMsg?.content?.find((x) => x.type === "text")?.text === "ok-after-cut",
      "cut round recovers via auto-retry",
    );

    host.send({ id: "ls", type: "thread/list" });
    const list = await host.waitResponse("ls", { ms: 15_000 });
    assert(
      list.data.threads.some((t) => t.threadId === tid && t.state === "live"),
      "thread still live after all fault classes",
    );
    assert(!host.frames.some((f) => f.type === "hub_error"), "no hub_error frames across faults");

    const exitCode = await host.endGracefully();
    assert(exitCode === 0, `stdin EOF graceful exit 0 (got ${exitCode})`);
  } finally {
    host.killTree();
    mock.stop();
    world.cleanup();
  }
}
