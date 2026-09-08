import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubFrame } from "../src/protocol.ts";
import { createJsonlSplitter, MAX_LINE_BYTES, WORKER_LINE_BYTES } from "../src/jsonl.ts";
import { matchResponseHead } from "../src/frame-classify.ts";
import type { SpawnWorkerDeps, SpawnWorkerFn, WorkerHandle } from "../src/worker-process.ts";
import { workerSpawnArgs } from "../src/worker-process.ts";
import { WorkerPool } from "../src/worker-pool.ts";
import { responseFailure, responseSuccess } from "../src/frames.ts";

/**
 * Locks the wire key order assumption (design.md migration §3): the worker
 * serializes response frames with `type`/`id` first, which is what the
 * host's strict head match relies on. These use the worker's REAL builders —
 * a literal-shape drift in worker.ts must fail here.
 */
describe("response head classification", () => {
  test("classifies the worker's real success frames (with id)", () => {
    const frame = JSON.stringify(responseSuccess("cmd-1", "get_messages", { messages: [] }));
    expect(matchResponseHead(frame)).toEqual({ id: "cmd-1", command: "get_messages" });
  });

  test("classifies the worker's real failure frames (with id)", () => {
    const frame = JSON.stringify(responseFailure("cmd-2", "prompt", "nope"));
    expect(matchResponseHead(frame)).toEqual({ id: "cmd-2", command: "prompt" });
  });

  test("classifies the worker's real id-less frames (undefined omitted by stringify)", () => {
    const frame = JSON.stringify(responseSuccess(undefined, "ui_response"));
    expect(matchResponseHead(frame)).toEqual({ id: undefined, command: "ui_response" });
  });

  test("numeric ids serialize outside the strict prefixes (parse-fallback path)", () => {
    // JSON.stringify keeps numeric ids unquoted: {"id":1,...}. The strict
    // prefixes must NOT match (undefined), so the pool's parse fallback
    // classifies them instead of dropping a healthy worker's response.
    const frame = JSON.stringify(responseSuccess(1 as unknown as string, "thread/list"));
    expect(frame.startsWith('{"id":1,')).toBe(true);
    expect(matchResponseHead(frame)).toBeUndefined();
  });

  test("returns null for a string id containing escapes (full-parse fallback)", () => {
    const frame = JSON.stringify(responseSuccess('we"ird\\id', "prompt"));
    expect(matchResponseHead(frame)).toBeNull();
  });

  test("returns undefined for non-response frames", () => {
    expect(matchResponseHead('{"type":"event","threadId":"t"}')).toBeUndefined();
    expect(matchResponseHead('{"type":"heartbeat","idleMs":0}')).toBeUndefined();
    expect(matchResponseHead('{"type":"ui_request","requestId":"r"}')).toBeUndefined();
  });
});

describe("worker spawn args (three launch forms)", () => {
  test("script form: argv[1] exists on disk and differs from execPath", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-spawn-args-"));
    try {
      const script = join(dir, "cli.ts");
      writeFileSync(script, "");
      expect(workerSpawnArgs(script, "/usr/local/bin/bun")).toEqual({
        command: "/usr/local/bin/bun",
        args: [script, "--internal-worker"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("compiled form: argv[1] is a virtual path that does not exist", () => {
    expect(existsSync("/$bunfs/root/cli")).toBe(false);
    expect(workerSpawnArgs("/$bunfs/root/cli", "/tmp/pai-bin")).toEqual({
      command: "/tmp/pai-bin",
      args: ["--internal-worker"],
    });
  });

  test("compiled form without argv[1]", () => {
    expect(workerSpawnArgs(undefined, "/tmp/pai-bin")).toEqual({
      command: "/tmp/pai-bin",
      args: ["--internal-worker"],
    });
  });
});

describe("jsonl splitter maxLineBytes parameterization", () => {
  test("default limit stays 16MiB, worker channel uses 128MiB", () => {
    expect(MAX_LINE_BYTES).toBe(16 * 1024 * 1024);
    expect(WORKER_LINE_BYTES).toBe(128 * 1024 * 1024);
  });

  test("custom smaller limit drops oversized lines and reports the actual limit", () => {
    const lines: string[] = [];
    const overflows: number[] = [];
    const splitter = createJsonlSplitter(
      (line) => lines.push(line),
      (limit) => overflows.push(limit),
      8,
    );
    splitter.push("short\n");
    splitter.push("this-line-is-too-long\n");
    splitter.push("after\n");
    expect(lines).toEqual(["short", "after"]);
    expect(overflows).toEqual([8]);
  });
});

// --- bounded teardown (design.md migration §6): retire/thread-stop arm a
// force-kill deadline; a wedged-but-heartbeating worker must not leak.

interface FakeWorker {
  deps: SpawnWorkerDeps;
  kills: string[];
  lines: string[];
  ended: () => boolean;
  close: () => void;
}

function makeFakeSpawn(): { spawn: SpawnWorkerFn; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  return {
    spawn: (deps: SpawnWorkerDeps): WorkerHandle => {
      const kills: string[] = [];
      const lines: string[] = [];
      let ended = false;
      let closedSent = false;
      let resolveClosed: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const handle: WorkerHandle = {
        // Fake child: only kill() is exercised (killWorker path).
        child: {
          kill: (signal: string) => {
            kills.push(signal);
            return true;
          },
        } as unknown as WorkerHandle["child"],
        stdin: {
          end: () => {
            ended = true;
          },
          write: (_chunk: string, cb?: (error?: Error | null) => void) => {
            cb?.(null);
            return true;
          },
        },
        threadId: "",
        trusted: false,
        writeLine: (line: string) => {
          lines.push(line);
          return Promise.resolve();
        },
        closed,
        retireIntent: "none",
        retiring: false,
        awaitingStart: true,
        spawnDeadline: Number.MAX_SAFE_INTEGER,
        spawnError: undefined,
        lastHeartbeatAt: Date.now(),
        idleMs: 0,
        streaming: false,
        sessionPath: null,
        subagents: 0,
        pendingIds: new Map(),
        internalIds: new Set(),
        greeted: false,
      };
      workers.push({
        deps,
        kills,
        lines,
        ended: () => ended,
        close: () => {
          if (closedSent) return;
          closedSent = true;
          deps.onClosed(0, null);
          resolveClosed?.();
        },
      });
      return handle;
    },
    workers,
  };
}

interface PoolHarness {
  pool: WorkerPool;
  frames: HubFrame[];
  raw: string[];
}

function makePool(
  fake: { spawn: SpawnWorkerFn },
  overrides?: { idleRetireMs?: number },
): PoolHarness {
  const frames: HubFrame[] = [];
  const raw: string[] = [];
  const pool = new WorkerPool({
    emitFrame: (frame) => frames.push(frame),
    emitRaw: (line) => raw.push(line),
    writeStderr: () => {},
    maxThreads: 4,
    idleRetireMs: overrides?.idleRetireMs ?? 3_600_000,
    workerStaleMs: 60_000,
    workerExitTimeoutMs: 50,
    spawnWorker: fake.spawn,
  });
  return { pool, frames, raw };
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

function soleWorker(fakes: FakeWorker[]): FakeWorker {
  const [worker] = fakes;
  if (worker === undefined) throw new Error("no fake worker was spawned");
  return worker;
}

function parkedAs(pool: WorkerPool, threadId: string): boolean {
  return pool.listEntries().some((e) => e.threadId === threadId && e.state === "parked");
}

const START_OK =
  '{"id":"start-1","type":"response","command":"thread/start","success":true,' +
  '"data":{"threadId":"t1","cwd":"/tmp","sessionPath":"/tmp/t1.jsonl"}}';
const HEARTBEAT_IDLE =
  '{"type":"heartbeat","idleMs":5000,"streaming":false,"sessionPath":"/tmp/t1.jsonl"}';
const HELLO_OK =
  '{"type":"hello","protocolVersion":1,"backendId":"pi-coding-agent","capabilities":[]}';

/** Worker contract v1: every fake worker greets before any other frame. */
function greet(worker: { deps: WorkerHandle }): void {
  worker.deps.onLine(HELLO_OK);
}

describe("teardown deadline (wedged worker escalation)", () => {
  test("idle retire escalates to SIGTERM past the exit budget and settles parked", async () => {
    const fake = makeFakeSpawn();
    const { pool, frames } = makePool(fake, { idleRetireMs: 1 });
    try {
      await pool.startThread({ id: "start-1" });
      const worker = soleWorker(fake.workers);
      greet(worker);
      worker.deps.onLine(START_OK);
      worker.deps.onLine(HEARTBEAT_IDLE);
      await until(() => worker.ended(), 3_000); // retire EOF landed (1s sweep)
      worker.deps.onLine(HEARTBEAT_IDLE); // wedged: still heartbeating, ignores EOF
      await until(() => worker.kills.length > 0, 2_000); // deadline escalation
      expect(worker.kills[0]).toBe("SIGTERM");
      worker.close();
      await until(() => parkedAs(pool, "t1"), 2_000);
      expect(frames.some((f) => f.type === "thread_died")).toBe(false);
    } finally {
      for (const w of fake.workers) w.close();
      await pool.shutdownAll();
    }
  }, 8_000);

  test("thread/stop a worker never answers is force-closed; entry deleted, stop id fails once", async () => {
    const fake = makeFakeSpawn();
    const { pool, frames } = makePool(fake);
    try {
      await pool.startThread({ id: "start-1" });
      const worker = soleWorker(fake.workers);
      greet(worker);
      worker.deps.onLine(START_OK);
      await pool.stopThread("t1", "stop-1", "thread/stop");
      // The worker neither answers the stop nor closes (wedged).
      await until(() => worker.kills.length > 0, 2_000);
      expect(worker.kills[0]).toBe("SIGTERM");
      worker.close();
      await until(() => !pool.hasThread("t1"), 2_000);
      const responses = frames.filter(
        (f): f is Extract<HubFrame, { type: "response" }> => f.type === "response",
      );
      const stop = responses.find((f) => f.id === "stop-1");
      expect(stop?.success).toBe(false);
      expect(responses.filter((f) => f.id === "stop-1")).toHaveLength(1);
    } finally {
      for (const w of fake.workers) w.close();
      await pool.shutdownAll();
    }
  }, 8_000);
});

// --- wake settlement (design §6, red-team regression): stop racing a wake
// and lazy-persist id changes must never leave a phantom/zombie worker.

const G1_LINE = JSON.stringify({ type: "get_state", threadId: "t1", id: "g1" });

function workerAt(fakes: FakeWorker[], index: number): FakeWorker {
  const worker = fakes[index];
  if (worker === undefined) throw new Error(`no fake worker at index ${index}`);
  return worker;
}

function responsesOf(frames: HubFrame[]): Extract<HubFrame, { type: "response" }>[] {
  return frames.filter((f): f is Extract<HubFrame, { type: "response" }> => f.type === "response");
}

function settled(frames: HubFrame[], id: string): boolean {
  return responsesOf(frames).some((f) => f.id === id);
}

function delivered(worker: FakeWorker, id: string): boolean {
  return worker.lines.some((line) => line.includes(`"${id}"`));
}

function resumeIdOf(worker: FakeWorker): string {
  const parsed = JSON.parse(worker.lines[0] ?? "{}") as { id?: string; type?: string };
  if (typeof parsed.id !== "string" || parsed.type !== "thread/resume") {
    throw new Error(`expected internal resume line, got: ${worker.lines[0] ?? "<none>"}`);
  }
  return parsed.id;
}

function respondResume(worker: FakeWorker, id: string, threadId: string): void {
  greet(worker);
  worker.deps.onLine(
    JSON.stringify({
      id,
      type: "response",
      command: "thread/resume",
      success: true,
      data: { threadId, cwd: "/tmp", sessionPath: "/tmp/t1.jsonl" },
    }),
  );
}

/** Live t1 (start acked), then the worker dies: the entry settles as dead. */
async function deadThread(fake: { workers: FakeWorker[] }, pool: WorkerPool): Promise<void> {
  await pool.startThread({ id: "start-1" });
  const first = soleWorker(fake.workers);
  greet(first);
  first.deps.onLine(START_OK);
  first.close();
}

/** Fire a command at the dead thread; resolves once the respawned worker of
 * the wake has written its internal resume line. */
async function wakeInFlight(
  fake: { workers: FakeWorker[] },
  pool: WorkerPool,
): Promise<FakeWorker> {
  void pool.sendToThread({ type: "get_state", threadId: "t1", id: "g1" }, G1_LINE);
  await until(() => (fake.workers[1]?.lines.length ?? 0) > 0, 2_000);
  return workerAt(fake.workers, 1);
}

describe("wake settlement (stop race / id change)", () => {
  test("stop racing a wake (same id): closure kill, no phantom worker or entry", async () => {
    const fake = makeFakeSpawn();
    const { pool, frames } = makePool(fake);
    try {
      await deadThread(fake, pool);
      const second = await wakeInFlight(fake, pool);
      await pool.stopThread("t1", "s1", "thread/stop"); // entry dead: mark + ack
      respondResume(second, resumeIdOf(second), "t1");
      await until(() => second.kills.includes("SIGTERM"), 2_000);
      second.close();
      // g1's failure settles a few turns after the close reconciliation.
      await until(() => settled(frames, "g1"), 2_000);
      await until(() => !pool.hasThread("t1"), 2_000);
      const responses = responsesOf(frames);
      expect(responses.find((f) => f.id === "s1")?.success).toBe(true);
      expect(responses.find((f) => f.id === "g1")?.success).toBe(false);
      expect(pool.liveCount()).toBe(0);
    } finally {
      for (const w of fake.workers) w.close();
      await pool.shutdownAll();
    }
  }, 8_000);

  test("wake resuming under a fresh id re-keys the stale entry (no self-lock)", async () => {
    const fake = makeFakeSpawn();
    const { pool, frames } = makePool(fake);
    try {
      await deadThread(fake, pool);
      const second = await wakeInFlight(fake, pool);
      respondResume(second, resumeIdOf(second), "t2");
      // The re-key lands a few turns after registerLive: poll the outcome.
      await until(() => pool.hasThread("t2") && !pool.hasThread("t1"), 2_000);
      expect(pool.listEntries()).toHaveLength(1);
      expect(second.kills).toEqual([]); // the worker survives the re-key
      await until(() => settled(frames, "g1"), 2_000);
      expect(responsesOf(frames).find((f) => f.id === "g1")?.success).toBe(false);
      await pool.sendToThread(
        { type: "get_state", threadId: "t2", id: "g2" },
        JSON.stringify({ type: "get_state", threadId: "t2", id: "g2" }),
      );
      await until(() => delivered(second, "g2"), 2_000);
    } finally {
      for (const w of fake.workers) w.close();
      await pool.shutdownAll();
    }
  }, 8_000);

  test("stop racing a wake that re-keys: both ids dropped, worker still killed", async () => {
    const fake = makeFakeSpawn();
    const { pool, frames } = makePool(fake);
    try {
      await deadThread(fake, pool);
      const second = await wakeInFlight(fake, pool);
      await pool.stopThread("t1", "s1", "thread/stop");
      respondResume(second, resumeIdOf(second), "t2");
      await until(() => second.kills.includes("SIGTERM"), 2_000);
      second.close();
      await until(() => settled(frames, "g1"), 2_000);
      await until(() => !pool.hasThread("t1") && !pool.hasThread("t2"), 2_000);
      const responses = responsesOf(frames);
      expect(responses.find((f) => f.id === "s1")?.success).toBe(true);
      expect(responses.find((f) => f.id === "g1")?.success).toBe(false);
    } finally {
      for (const w of fake.workers) w.close();
      await pool.shutdownAll();
    }
  }, 8_000);
});
