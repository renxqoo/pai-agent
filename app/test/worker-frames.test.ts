import { describe, expect, test } from "bun:test";
import { onWorkerLine, type FrameRelayDeps } from "../src/worker-frames.ts";
import type { WorkerHandle } from "../src/worker-process.ts";

/**
 * Frame classification closure (plan §6 vocabulary): subagent_event forwards
 * verbatim by prefix AND by parse fallback (key order not guaranteed from
 * third-party serializers), heartbeats are consumed locally.
 */

function makeDeps() {
  const raw: string[] = [];
  const deps: FrameRelayDeps = {
    table: { reoccupy: () => {} } as FrameRelayDeps["table"],
    internalIds: new Map(),
    emitFrame: () => {},
    emitRaw: (line) => {
      raw.push(line);
    },
    writeStderr: () => {},
    killWorker: async () => {},
    onGrant: () => {},
    renewGrants: () => {},
    internalKey: (worker, id) => `${worker.uid}:${id}`,
    expectedBackendId: "pi-coding-agent",
  };
  return { deps, raw };
}

function makeWorker(): WorkerHandle {
  return {
    child: {} as WorkerHandle["child"],
    stdin: { end: () => {}, write: () => true },
    threadId: "t1",
    trusted: true,
    writeLine: async () => {},
    closed: Promise.resolve(),
    retireIntent: "none",
    retiring: false,
    awaitingStart: false,
    spawnDeadline: 0,
    spawnError: undefined,
    lastHeartbeatAt: 0,
    idleMs: 0,
    streaming: false,
    sessionPath: null,
    subagents: 0,
    pendingIds: new Map(),
    internalIds: new Set(),
    greeted: true,
  };
}

describe("worker contract v1 hello handshake", () => {
  test("valid hello greets the worker; a duplicate is ignored", () => {
    const { deps } = makeDeps();
    const worker = makeWorker();
    worker.greeted = false;
    onWorkerLine(
      deps,
      worker,
      '{"type":"hello","protocolVersion":1,"backendId":"pi-coding-agent","capabilities":[]}',
    );
    expect(worker.greeted).toBeTrue();
    // Duplicate hello: noted on stderr, not fatal.
    onWorkerLine(
      deps,
      worker,
      '{"type":"hello","protocolVersion":1,"backendId":"pi-coding-agent","capabilities":[]}',
    );
    expect(worker.greeted).toBeTrue();
  });

  test("protocol version mismatch rejects through the spawn-failure path", async () => {
    const { deps } = makeDeps();
    const worker = makeWorker();
    worker.greeted = false;
    let killed = false;
    deps.killWorker = async () => {
      killed = true;
    };
    onWorkerLine(
      deps,
      worker,
      '{"type":"hello","protocolVersion":99,"backendId":"pi-coding-agent","capabilities":[]}',
    );
    expect(killed).toBeTrue();
    expect(worker.spawnError).toContain("protocol version mismatch");
  });

  test("backend id mismatch rejects through the spawn-failure path", async () => {
    const { deps } = makeDeps();
    const worker = makeWorker();
    worker.greeted = false;
    let killed = false;
    deps.killWorker = async () => {
      killed = true;
    };
    onWorkerLine(
      deps,
      worker,
      '{"type":"hello","protocolVersion":1,"backendId":"other","capabilities":[]}',
    );
    expect(killed).toBeTrue();
    expect(worker.spawnError).toContain("backend mismatch");
  });

  test("any frame before hello is rejected", async () => {
    const { deps } = makeDeps();
    const worker = makeWorker();
    worker.greeted = false;
    let killed = false;
    deps.killWorker = async () => {
      killed = true;
    };
    onWorkerLine(
      deps,
      worker,
      '{"type":"heartbeat","idleMs":0,"streaming":false,"sessionPath":null}',
    );
    expect(killed).toBeTrue();
    expect(worker.spawnError).toContain("hello frame first");
  });
});

describe("worker frame classification (v0.5 subagent_event)", () => {
  test("subagent_event forwards verbatim by prefix", () => {
    const { deps, raw } = makeDeps();
    const line =
      '{"type":"subagent_event","threadId":"t1","subagentId":"sub_ab12","agent":"echoer","task":"x","event":{"type":"agent_start"}}';
    onWorkerLine(deps, makeWorker(), line);
    expect(raw).toEqual([line]);
  });

  test("subagent_event forwards by parse fallback (type not first key)", () => {
    const { deps, raw } = makeDeps();
    const line =
      '{"threadId":"t1","subagentId":"sub_cd34","type":"subagent_event","event":{"type":"agent_end"}}';
    onWorkerLine(deps, makeWorker(), line);
    expect(raw).toEqual([line]);
  });

  test("subagent_message forwards verbatim by prefix and parse fallback (stage 8)", () => {
    const { deps, raw } = makeDeps();
    const byPrefix =
      '{"type":"subagent_message","threadId":"t1","subagentId":"sub_ab12","agent":"echoer","text":"hi"}';
    onWorkerLine(deps, makeWorker(), byPrefix);
    const byFallback =
      '{"text":"hi","subagentId":"sub_ef56","type":"subagent_message","threadId":"t1","to":"sub_gh78"}';
    onWorkerLine(deps, makeWorker(), byFallback);
    expect(raw).toEqual([byPrefix, byFallback]);
  });

  test("event and ui_request still forward by prefix", () => {
    const { deps, raw } = makeDeps();
    onWorkerLine(
      deps,
      makeWorker(),
      '{"type":"event","threadId":"t1","event":{"type":"message_end"}}',
    );
    onWorkerLine(deps, makeWorker(), '{"type":"ui_request","requestId":"r1","threadId":"t1"}');
    expect(raw.length).toBe(2);
  });

  test("heartbeats are consumed locally and update the worker state", () => {
    const { deps, raw } = makeDeps();
    const worker = makeWorker();
    onWorkerLine(
      deps,
      worker,
      '{"type":"heartbeat","idleMs":42,"streaming":true,"sessionPath":null,"subagents":2}',
    );
    expect(raw.length).toBe(0);
    expect(worker.idleMs).toBe(42);
    expect(worker.streaming).toBe(true);
    expect(worker.subagents).toBe(2);
  });
});
