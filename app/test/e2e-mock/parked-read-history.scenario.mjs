// Scenario: parked read history (v0.12, docs/plans/2026-09-10-parked-read-history.md).
// After the idle retire moves a thread to parked, get_entries/get_state are
// answered host-locally from the session file — zero worker processes — and
// an ordinary write command still wakes the thread transparently. Cursor
// errors on a readable snapshot keep the worker-path failure wording.
// The cold-start leg reproduces the Electron symptom "every historical
// conversation fails to load": a session file the empty-table host has never
// admitted must be registered (thread/register, no worker) before reads.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, startHost, writeAgentFiles } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "parked-read-history";
export const timeoutMs = 120_000;

const IDLE_RETIRE_MS = 3_000;

async function waitParked(host, tid, assert) {
  let parked = false;
  let pollSeq = 0;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !parked) {
    pollSeq += 1;
    const pollId = `ls_${pollSeq}`;
    host.send({ id: pollId, type: "thread/list" });
    const list = await host.waitResponse(pollId, { ms: 15_000 });
    parked = list.data.threads.some((t) => t.threadId === tid && t.state === "parked");
    if (!parked) {
      await new Promise((done) => {
        setTimeout(done, 500);
      });
    }
  }
  assert(parked, "thread parks within the shrunken retire window");
  return parked;
}

export async function run({ assert }) {
  const world = makeWorld(name);
  const mock = startMockModel({
    models: {
      "mock-main": [
        { kind: "text", text: "first round persists the session" },
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

    // Cold-start leg (symptom regression "every historical conversation
    // fails to load"): a session file on disk that the empty-table host has
    // never admitted. Unregistered reads fail with Unknown threadId; after
    // thread/register (host-local, no worker) the read shortcut serves it.
    const sessionsDir = join(world.agentDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const coldPath = join(sessionsDir, "20260910_cold.jsonl");
    const coldLines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "cold-id",
        timestamp: "t",
        cwd: world.projectDir,
      }),
      JSON.stringify({
        id: "ce1",
        parentId: null,
        timestamp: "t",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "cold history" }] },
      }),
    ].join("\n");
    writeFileSync(coldPath, `${coldLines}\n`);
    host.send({ id: "cold1", type: "get_entries", threadId: "cold-id" });
    const unknown = await host.waitResponse("cold1", { ms: 15_000 });
    assert(
      !unknown.success && /Unknown threadId/.test(unknown.error ?? ""),
      "cold-start read without register fails with Unknown threadId",
    );
    host.send({ id: "cold2", type: "thread/register", sessionPath: coldPath });
    const registered = await host.waitResponse("cold2", { ms: 15_000 });
    assert(registered.success, "thread/register admits the file without a worker");
    assert(
      registered.data.threadId === "cold-id",
      "register derives the thread id from the session header",
    );
    assert(host.workerPids().length === 0, "cold-start register spawned no worker");
    host.send({ id: "cold3", type: "get_entries", threadId: "cold-id" });
    const coldEntries = await host.waitResponse("cold3", { ms: 15_000 });
    assert(coldEntries.success, "registered cold session reads via the shortcut");
    assert(
      (coldEntries.data.entries ?? []).some((e) => e.type === "message"),
      "cold-start read replays the persisted history",
    );
    assert(host.workerPids().length === 0, "cold-start read spawned no worker");
    host.send({ id: "cold4", type: "thread/register", sessionPath: coldPath });
    const again = await host.waitResponse("cold4", { ms: 15_000 });
    assert(again.success && again.data.threadId === "cold-id", "register is idempotent");

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

    // Persist the session (retire requires a persisted path) and settle.
    host.send({ id: "p0", type: "prompt", threadId: tid, message: "persisting round" });
    assert((await host.waitResponse("p0", { ms: 15_000 })).success, "round 1 accepted");

    // Live passthrough sanity before parking: get_entries works on live too.
    host.send({ id: "ge_live", type: "get_entries", threadId: tid });
    const liveEntries = await host.waitResponse("ge_live", { ms: 15_000 });
    assert(liveEntries.success, "get_entries on live thread succeeds (worker passthrough)");

    if (!(await waitParked(host, tid, assert))) return;
    assert(host.workerPids().length === 0, "parked means zero worker processes");

    // Parked get_entries: answered from the file, still zero workers.
    host.send({ id: "ge1", type: "get_entries", threadId: tid });
    const entries = await host.waitResponse("ge1", { ms: 15_000 });
    assert(entries.success, "parked get_entries succeeds without waking");
    const messageEntries = (entries.data.entries ?? []).filter((e) => e.type === "message");
    assert(
      messageEntries.length >= 2,
      "parked get_entries replays the persisted conversation (user + assistant)",
    );
    assert(typeof entries.data.leafId === "string", "parked get_entries reports the leaf cursor");
    assert(host.workerPids().length === 0, "parked get_entries did not spawn a worker");

    // Parked get_state: derivation shape, still zero workers.
    host.send({ id: "gs1", type: "get_state", threadId: tid });
    const state = await host.waitResponse("gs1", { ms: 15_000 });
    assert(state.success, "parked get_state succeeds without waking");
    assert(state.data.isStreaming === false, "parked get_state reports isStreaming false");
    assert(state.data.isCompacting === false, "parked get_state reports isCompacting false");
    assert(state.data.sessionId === tid, "parked get_state derives the header session id");
    assert(state.data.messageCount >= 2, "parked get_state counts replayed messages");
    assert(host.workerPids().length === 0, "parked get_state did not spawn a worker");

    // Cursor error on a readable snapshot: genuine failure, no wake.
    host.send({ id: "ge2", type: "get_entries", threadId: tid, since: "gone-cursor" });
    const cursorError = await host.waitResponse("ge2", { ms: 15_000 });
    assert(!cursorError.success, "unknown cursor fails");
    assert(
      /Entry not found: gone-cursor/.test(cursorError.error ?? ""),
      "cursor error keeps the worker-path wording",
    );
    assert(host.workerPids().length === 0, "cursor error did not spawn a worker");

    // Write command: the transparent wake still works after the read shortcut.
    const w0 = host.frames.length;
    host.send({ id: "p1", type: "prompt", threadId: tid, message: "wake round" });
    const wakeResp = await host.waitResponse("p1", { ms: 30_000 });
    assert(wakeResp.success, "write command wakes the parked thread");
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: "wake round settled",
      ms: 30_000,
      since: w0,
    });
    assert(host.workerPids().length === 1, "thread is live again after the write command");

    // Field-by-field truth alignment (worker restore chain vs direct read):
    // the direct-read snapshot must be a prefix of the live transcript —
    // append-only parity; declared divergences (default-level materialization,
    // wake-round appends) only ever extend it.
    host.send({ id: "ge_live2", type: "get_entries", threadId: tid });
    const liveEntries2 = await host.waitResponse("ge_live2", { ms: 15_000 });
    assert(liveEntries2.success, "live get_entries after wake succeeds");
    const directIds = (entries.data.entries ?? []).map((e) => e.id);
    const liveIds = (liveEntries2.data.entries ?? []).map((e) => e.id);
    const directLeafIndex = liveIds.indexOf(entries.data.leafId);
    assert(
      directLeafIndex !== -1 && directIds.every((id, i) => liveIds[i] === id),
      "direct-read entries form a prefix of the live transcript",
    );
    assert(
      directIds.length <= directLeafIndex + 1 && directIds.at(-1) === liveIds[directLeafIndex],
      "direct-read leaf is the last direct-read entry",
    );
    host.send({ id: "gs_live2", type: "get_state", threadId: tid });
    const liveState2 = await host.waitResponse("gs_live2", { ms: 15_000 });
    assert(liveState2.success, "live get_state after wake succeeds");
    assert(liveState2.data.sessionId === state.data.sessionId, "session id agrees across paths");
    assert(
      liveState2.data.model?.provider === state.data.model?.provider &&
        liveState2.data.model?.id === state.data.model?.id,
      "model provider/modelId agree across paths (rich resolution parity)",
    );
    assert(
      liveState2.data.messageCount >= state.data.messageCount,
      "live message count only grows past the direct-read snapshot",
    );

    const exitCode = await host.endGracefully();
    assert(exitCode === 0, `stdin EOF graceful exit 0 (got ${exitCode})`);
  } finally {
    host.killTree();
    mock.stop();
    world.cleanup();
  }
}
