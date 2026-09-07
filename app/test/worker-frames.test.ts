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
  };
}

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
