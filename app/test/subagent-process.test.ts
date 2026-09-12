import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  type GrandchildHooks,
  type GrandchildResult,
  type GrandchildTaskSpec,
  RELAY_ALWAYS_MAX_BYTES,
  RELAY_BUFFER_CAP_BYTES,
  relayAlwaysFormOf,
  startGrandchildTask,
} from "../src/backend/pi-coding-agent/subagent-process.ts";
import {
  exceedsPendingUiCap,
  MAX_PENDING_UI_FRAMES,
  pendingUiFrameList,
  PENDING_DIALOG_TTL_MS,
  type RetainedUiFrame,
} from "../src/backend/pi-coding-agent/subagent-ui-frames.ts";
import {
  spawnWorkerProcess,
  type SpawnWorkerDeps,
  type SpawnWorkerFn,
  type WorkerHandle,
} from "../src/worker-process.ts";
import { WORKER_FLAG } from "../src/protocol-internal.ts";

/**
 * Two layers:
 * - a real-process integration run (keyless): the actual pai worker is
 *   spawned, the prompt fails cleanly at preflight, and the driver must
 *   still settle, leave no process behind, and persist no session file
 *   (ephemeral);
 * - seam-driven mechanics via an injected fake spawner: start deadline,
 *   ui_request relay + response routing, relay cap, abort kill, and the
 *   close-without-settled outcome. The fake mirrors the production
 *   contract: close() fires onClosed first, then resolves the closed
 *   promise (a real child's close is what settles the driver teardown).
 */

const agentDir = mkdtempSync(join(tmpdir(), "pai-cli-subagent-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

function fakeHandleFor(deps: SpawnWorkerDeps): WorkerHandle {
  const closed = new Promise<void>((resolve) => {
    fakeClosers.push(() => {
      deps.onClosed(1, null);
      resolve();
    });
  });
  return {
    child: { kill: () => true, exitCode: null, signalCode: null } as WorkerHandle["child"],
    stdin: {
      write: (_c: string, cb?: (e?: Error | null) => void) => {
        cb?.(null);
        return true;
      },
      end: () => {},
    },
    threadId: "",
    trusted: false,
    writeLine: () => Promise.resolve(),
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
  };
}

const fakeClosers: Array<() => void> = [];

function spec(): GrandchildTaskSpec {
  return {
    subagentId: "sub_test0001",
    agent: "echoer",
    task: "say hi",
    cwd: tmpdir(),
    systemPrompt: "You echo.",
    permissionThreadId: "tid-test",
  };
}

function hooks(log: {
  events: AgentSessionEvent[];
  uiRequests: Array<Record<string, unknown>>;
}): GrandchildHooks {
  return {
    onEvent: (event) => {
      log.events.push(event);
    },
    onUiRequest: (frame) => {
      log.uiRequests.push(frame);
    },
    writeStderr: () => {},
  };
}

function listSessionFiles(): string[] {
  try {
    return readdirSync(join(agentDir, "sessions"), { recursive: true }) as string[];
  } catch {
    return [];
  }
}

describe("real grandchild integration (keyless)", () => {
  test("prompt failure settles the driver and writes no session file (ephemeral)", async () => {
    const before = listSessionFiles();
    const log = { events: [], uiRequests: [] };
    const driver = startGrandchildTask({
      spec: spec(),
      hooks: hooks(log),
      spawnWorker: realWorkerSpawn,
    });
    const result: GrandchildResult = await driver.result;
    expect(result.isError).toBe(true);
    expect(result.aborted).toBe(false);
    expect(typeof result.errorMessage === "string" && result.errorMessage.length > 0).toBe(true);
    expect(listSessionFiles().length).toBe(before.length);
  }, 60_000);
});

/** Explicit real-worker spawn: `bun test <file>` puts the TEST FILE in
 * argv[1], which workerSpawnArgs' dynamic self-resolution would re-run as
 * the grandchild ("Cannot use test outside of the test runner" → instant
 * death). Pinning the entry makes the test invocation-independent. */
function realWorkerSpawn(deps: SpawnWorkerDeps): WorkerHandle {
  return spawnWorkerProcess({
    ...deps,
    spawnSpec: {
      command: process.execPath,
      args: [join(import.meta.dir, "../src/cli.ts"), WORKER_FLAG],
    },
  });
}

describe("real-process watchdogs", () => {
  test("start deadline fires on a real (slow-to-start) grandchild", async () => {
    process.env.PAI_SUBAGENT_START_MS = "50";
    try {
      const driver = startGrandchildTask({
        spec: spec(),
        hooks: hooks({ events: [], uiRequests: [] }),
        spawnWorker: realWorkerSpawn,
      });
      const result = await driver.result;
      expect(result.isError).toBe(true);
      expect(result.errorMessage ?? "").toContain("did not start within 50ms");
    } finally {
      delete process.env.PAI_SUBAGENT_START_MS;
    }
  }, 60_000);

  test("spawn failure (stdin unusable) reports death while starting", async () => {
    const broken = (deps: SpawnWorkerDeps): WorkerHandle => {
      const handle = fakeHandleFor(deps);
      handle.writeLine = () => Promise.reject(new Error("spawn failed: pipe closed"));
      return handle;
    };
    const driver = startGrandchildTask({
      spec: spec(),
      hooks: hooks({ events: [], uiRequests: [] }),
      spawnWorker: broken as SpawnWorkerFn,
    });
    // The teardown awaits the handle's close; fire the fake close so the
    // result promise can settle (a real child closes after the kill).
    setTimeout(() => {
      for (const close of fakeClosers) close();
    }, 200);
    const result = await driver.result;
    expect(result.isError).toBe(true);
    expect(result.errorMessage ?? "").toContain("died while starting");
  }, 15_000);
});

// --- seam-driven mechanics -------------------------------------------------------

interface FakeChild {
  feed: (line: string) => void;
  close: () => void;
  lines: string[];
  kills: string[];
}

function fakeSpawner(): { spawn: SpawnWorkerFn; child: FakeChild } {
  const kills: string[] = [];
  const lines: string[] = [];
  let feedLine: ((line: string) => void) | undefined;
  let fireClose: (() => void) | undefined;
  const spawn = (deps: SpawnWorkerDeps): WorkerHandle => {
    feedLine = (line: string) => {
      try {
        deps.onLine(line);
      } catch {
        deps.onViolation("malformed frame");
      }
    };
    const closed = new Promise<void>((resolve) => {
      fireClose = () => {
        // Mirror the production contract: a closed child reports an exit
        // code, which is what stops teardown's final killNow from re-killing.
        fakeChild.exitCode = 0;
        deps.onClosed(0, null);
        resolve();
      };
    });
    const fakeChild = {
      kill: (sig: string) => {
        kills.push(sig);
        return true;
      },
      exitCode: null as number | null,
      signalCode: null as string | null,
    };
    return {
      child: fakeChild as unknown as WorkerHandle["child"],
      stdin: {
        write: (_chunk: string, cb?: (error?: Error | null) => void) => {
          cb?.(null);
          return true;
        },
        end: () => {},
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
      pendingIds: new Map(),
      internalIds: new Set(),
    };
  };
  return {
    spawn: spawn as SpawnWorkerFn,
    child: {
      feed: (line: string) => {
        feedLine?.(line);
      },
      close: () => {
        fireClose?.();
      },
      get lines(): string[] {
        return lines;
      },
      get kills(): string[] {
        return kills;
      },
    },
  };
}

function lineStartsWith(lines: string[], prefix: string): boolean {
  return lines.some((l) => l.startsWith(prefix));
}

/** message_update 帧（delta 长度为唯一变量）：预算回归用例据其实测行字节数。 */
function updateLineOf(deltaLength: number): string {
  return `{"type":"event","threadId":"g-sess-1","event":{"type":"message_update","delta":"${"x".repeat(deltaLength)}"}}`;
}

function lineIncludes(lines: string[], needle: string): boolean {
  return lines.some((l) => l.includes(needle));
}

function uiResponseRouted(lines: string[], requestId: string): boolean {
  return lines.some((l) => l.includes('"type":"ui_response"') && l.includes(requestId));
}

function step(check: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > 5000) {
        clearInterval(timer);
        reject(new Error("step timeout"));
      }
    }, 10);
  });
}

const START_OK =
  '{"id":"g-start","type":"response","command":"thread/start","success":true,"data":{"threadId":"g-sess-1","cwd":"/tmp","sessionPath":null}}';
const PROMPT_OK = '{"id":"g-prompt","type":"response","command":"prompt","success":true}';

describe("start deadline (plan §3.3)", () => {
  test("heartbeating but never-ready grandchild is force-closed and reported", async () => {
    const fake = fakeSpawner();
    process.env.PAI_SUBAGENT_START_MS = "200";
    try {
      const driver = startGrandchildTask({
        spec: spec(),
        hooks: hooks({ events: [], uiRequests: [] }),
        spawnWorker: fake.spawn,
      });
      await step(() => fake.child.kills.includes("SIGTERM"));
      fake.child.close(); // the real child's close follows the kill
      const result = await driver.result;
      expect(result.isError).toBe(true);
      expect(result.errorMessage ?? "").toContain("did not start within");
    } finally {
      delete process.env.PAI_SUBAGENT_START_MS;
    }
  }, 15_000);
});

describe("relay mechanics", () => {
  test("full journey: start, prompt, ui relay + response routing, settle, stop", async () => {
    const fake = fakeSpawner();
    const log = { events: [], uiRequests: [] };
    const driver = startGrandchildTask({
      spec: spec(),
      hooks: hooks(log),
      spawnWorker: fake.spawn,
    });
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-start"'));
    fake.child.feed(START_OK);
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-prompt"'));
    fake.child.feed(PROMPT_OK);
    fake.child.feed(
      '{"type":"event","threadId":"g-sess-1","event":{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"sub says hi"}],"usage":{"input":10,"output":5,"cacheRead":3,"cacheWrite":0,"cost":{"total":0.01},"totalTokens":18}}}}',
    );
    fake.child.feed(
      '{"type":"ui_request","requestId":"req-1","threadId":"g-sess-1","method":"confirm","title":"Allow command execution?","message":"echo hi"}',
    );
    await step(() => log.uiRequests.length === 1);
    expect(log.uiRequests[0]?.["requestId"]).toBe("req-1");
    expect(driver.resolveUi("req-1", { confirmed: true })).toBe(true);
    await step(() => uiResponseRouted(fake.child.lines, "req-1"));
    // Reconstructed line carries no host internal id (review finding A9).
    const routed = fake.child.lines.find((l) => l.includes("req-1") && l.includes("ui_response"));
    expect(routed?.startsWith('{"type":"ui_response"')).toBe(true);
    expect(driver.resolveUi("req-1", { confirmed: true })).toBe(false); // consumed
    fake.child.feed('{"type":"event","threadId":"g-sess-1","event":{"type":"agent_settled"}}');
    await step(() => lineIncludes(fake.child.lines, '"type":"thread/stop"'));
    fake.child.close();
    const result = await driver.result;
    expect(result.isError).toBe(false);
    expect(result.output).toContain("sub says hi");
    expect(result.usage).toMatchObject({
      turns: 1,
      input: 10,
      output: 5,
      cacheRead: 3,
      cost: 0.01,
    });
    expect(result.eventsRelayed).toBe(2);
  }, 15_000);

  test("症状回归「grandchild 在途弹窗重载后不可恢复」：帧保留进读口源，应答即除名", async () => {
    const fake = fakeSpawner();
    const log = { events: [], uiRequests: [] };
    const driver = startGrandchildTask({
      spec: spec(),
      hooks: hooks(log),
      spawnWorker: fake.spawn,
    });
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-start"'));
    fake.child.feed(START_OK);
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-prompt"'));
    fake.child.feed(PROMPT_OK);
    fake.child.feed(
      '{"type":"ui_request","requestId":"req-9","threadId":"g-sess-1","method":"confirm","title":"Allow command execution?","message":"echo x"}',
    );
    await step(() => driver.pendingUiFrames().length === 1);
    expect(driver.pendingUiFrames()[0]?.["method"]).toBe("confirm");
    expect(driver.resolveUi("req-9", { confirmed: true })).toBe(true);
    expect(driver.pendingUiFrames()).toEqual([]);
    fake.child.feed('{"type":"event","threadId":"g-sess-1","event":{"type":"agent_settled"}}');
    await step(() => lineIncludes(fake.child.lines, '"type":"thread/stop"'));
    fake.child.close();
    await driver.result;
  }, 15_000);

  test("abort landing after settle keeps the completed output (P3-9)", async () => {
    const fake = fakeSpawner();
    const controller = new AbortController();
    const driver = await reachRunning(fake, hooks({ events: [], uiRequests: [] }));
    controller.abort(); // abort races in AFTER the grandchild settled
    fake.child.feed(
      '{"type":"event","threadId":"g-sess-1","event":{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final answer"}]}}}',
    );
    fake.child.feed('{"type":"event","threadId":"g-sess-1","event":{"type":"agent_settled"}}');
    fake.child.close();
    const result = await driver.result;
    expect(result.isError).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.output).toContain("final answer");
  }, 15_000);

  test("close without settling reports a dead grandchild", async () => {
    const fake = fakeSpawner();
    const driver = startGrandchildTask({
      spec: spec(),
      hooks: hooks({ events: [], uiRequests: [] }),
      spawnWorker: fake.spawn,
    });
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-start"'));
    fake.child.feed(START_OK);
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-prompt"'));
    fake.child.feed(PROMPT_OK);
    fake.child.close();
    const result = await driver.result;
    expect(result.isError).toBe(true);
    expect(result.errorMessage ?? "").toContain("exited before finishing");
  }, 15_000);

  test("abort kills the grandchild and reports aborted", async () => {
    const fake = fakeSpawner();
    const controller = new AbortController();
    const driver = startGrandchildTask({
      spec: spec(),
      hooks: hooks({ events: [], uiRequests: [] }),
      signal: controller.signal,
      spawnWorker: fake.spawn,
    });
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-start"'));
    fake.child.feed(START_OK);
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-prompt"'));
    fake.child.feed(PROMPT_OK);
    controller.abort();
    fake.child.close();
    const result = await driver.result;
    expect(result.aborted).toBe(true);
    expect(result.isError).toBe(true);
    expect(fake.child.kills).toContain("SIGTERM");
  }, 15_000);

  test("heartbeating grandchild is not stale-killed mid-task", async () => {
    const fake = fakeSpawner();
    process.env.PAI_SUBAGENT_STALE_MS = "300";
    const heartbeat = setInterval(() => {
      fake.child.feed('{"type":"heartbeat","idleMs":10,"streaming":true,"sessionPath":null}');
    }, 100);
    try {
      const driver = startGrandchildTask({
        spec: spec(),
        hooks: hooks({ events: [], uiRequests: [] }),
        spawnWorker: fake.spawn,
      });
      await step(() => lineStartsWith(fake.child.lines, '{"id":"g-start"'));
      fake.child.feed(START_OK);
      await step(() => lineStartsWith(fake.child.lines, '{"id":"g-prompt"'));
      fake.child.feed(PROMPT_OK);
      // The stale sweep runs every 1000ms: with heartbeats arriving every
      // 100ms a healthy grandchild must survive well past staleMs. Regression
      // guard: the runner must refresh lastHeartbeatAt on each heartbeat it
      // consumes, or the sweep kills long-running subagents mid-task.
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 1500);
      });
      fake.child.feed('{"type":"event","threadId":"g-sess-1","event":{"type":"agent_settled"}}');
      fake.child.close();
      const result = await driver.result;
      expect(fake.child.kills).not.toContain("SIGTERM");
      expect(result.isError).toBe(false);
      expect(result.errorMessage ?? "").not.toContain("stale");
    } finally {
      clearInterval(heartbeat);
      delete process.env.PAI_SUBAGENT_STALE_MS;
    }
  }, 15_000);

  test("relay buffer cap stops accumulation and marks truncation", async () => {
    const fake = fakeSpawner();
    const log = { events: [], uiRequests: [] };
    const driver = startGrandchildTask({
      spec: spec(),
      hooks: hooks(log),
      spawnWorker: fake.spawn,
    });
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-start"'));
    fake.child.feed(START_OK);
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-prompt"'));
    fake.child.feed(PROMPT_OK);
    const filler = "x".repeat(60 * 1024);
    for (let i = 0; i < 6; i++) {
      fake.child.feed(
        `{"type":"event","threadId":"g-sess-1","event":{"type":"message_update","delta":"${filler}"}}`,
      );
    }
    fake.child.feed(
      '{"type":"event","threadId":"g-sess-1","event":{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}}',
    );
    fake.child.feed('{"type":"event","threadId":"g-sess-1","event":{"type":"agent_settled"}}');
    fake.child.close();
    const result = await driver.result;
    expect(result.truncated).toBe(true);
    expect(log.events.length).toBeLessThan(8);
    expect(result.eventsRelayed).toBe(8); // counted even when not relayed
  }, 15_000);

  test("regression: exhausted relay budget still delivers agent_settled (client status would stick at working)", async () => {
    const fake = fakeSpawner();
    const log = { events: [], uiRequests: [] };
    const driver = startGrandchildTask({
      spec: spec(),
      hooks: hooks(log),
      spawnWorker: fake.spawn,
    });
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-start"'));
    fake.child.feed(START_OK);
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-prompt"'));
    fake.child.feed(PROMPT_OK);
    const relayed: string[] = [];
    const feed = (line: string, type: string): void => {
      fake.child.feed(line);
      relayed.push(type);
    };
    // Exhaust the budget EXACTLY: fill with 60KB deltas, then one final line
    // sized to the remaining budget. Sizing is derived from the line itself
    // (delta length is the only variable), so the test cannot drift from the
    // production accounting.
    const base = Buffer.byteLength(updateLineOf(0));
    let remaining = RELAY_BUFFER_CAP_BYTES;
    while (remaining > 60 * 1024) {
      const line = updateLineOf(60 * 1024);
      feed(line, "message_update");
      remaining -= Buffer.byteLength(line);
    }
    const final = updateLineOf(remaining - base);
    expect(Buffer.byteLength(final)).toBe(remaining);
    feed(final, "message_update");
    // Budget is now exactly full: a non-exempt event is dropped as before.
    feed(
      '{"type":"event","threadId":"g-sess-1","event":{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"dropped"}]}}}',
      "message_end",
    );
    feed(
      '{"type":"event","threadId":"g-sess-1","event":{"type":"agent_settled"}}',
      "agent_settled",
    );
    fake.child.close();
    const result = await driver.result;
    expect(result.truncated).toBe(true);
    // Received-but-not-relayed accounting stays exact: only the over-budget
    // message_end was dropped.
    expect(result.eventsRelayed).toBe(log.events.length + 1);
    // Exact relayed sequence (typo-proof): every budget-fitting delta plus the
    // terminal event, and nothing else — the over-budget message_end is gone.
    expect(log.events.map((e) => e.type)).toEqual(relayed.filter((type) => type !== "message_end"));
  }, 15_000);

  test("oversized agent_settled is normalized to the canonical payload-free form", async () => {
    const fake = fakeSpawner();
    const log = { events: [], uiRequests: [] };
    const driver = startGrandchildTask({
      spec: spec(),
      hooks: hooks(log),
      spawnWorker: fake.spawn,
    });
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-start"'));
    fake.child.feed(START_OK);
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-prompt"'));
    fake.child.feed(PROMPT_OK);
    const payload = "x".repeat(RELAY_ALWAYS_MAX_BYTES + 1);
    fake.child.feed(
      `{"type":"event","threadId":"g-sess-1","event":{"type":"agent_settled","payload":"${payload}"}}`,
    );
    // The normalized event must not eat the remaining budget: a following
    // non-exempt event is still relayed.
    fake.child.feed(
      '{"type":"event","threadId":"g-sess-1","event":{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"after"}]}}}',
    );
    fake.child.close();
    await driver.result;
    expect(log.events[0]).toEqual({ type: "agent_settled" });
    expect(log.events.map((e) => e.type)).toEqual(["agent_settled", "message_end"]);
  }, 15_000);

  test("relay exemption is the payload-free terminal set (contract pin)", () => {
    expect(relayAlwaysFormOf({ type: "agent_settled" })).toEqual({ type: "agent_settled" });
    expect(relayAlwaysFormOf({ type: "agent_end", messages: [] })).toBeUndefined();
    expect(relayAlwaysFormOf({ type: "message_end" })).toBeUndefined();
  });

  test("regression: crashed grandchild still gets a terminal event (client status would stick at working)", async () => {
    const fake = fakeSpawner();
    const log = { events: [], uiRequests: [] };
    const driver = await reachRunning(fake, hooks(log));
    fake.child.feed(
      '{"type":"event","threadId":"g-sess-1","event":{"type":"message_update","delta":"partial"}}',
    );
    await step(() => log.events.length === 1);
    // Dies without agent_settled: no terminal event from the grandchild.
    fake.child.close();
    const result = await driver.result;
    expect(result.isError).toBe(true);
    expect(log.events.map((e) => e.type)).toEqual(["message_update", "agent_settled"]);
  }, 15_000);

  test("aborted grandchild still gets a terminal event after partial output", async () => {
    const fake = fakeSpawner();
    const log = { events: [], uiRequests: [] };
    const controller = new AbortController();
    const driver = startGrandchildTask({
      spec: spec(),
      hooks: hooks(log),
      signal: controller.signal,
      spawnWorker: fake.spawn,
    });
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-start"'));
    fake.child.feed(START_OK);
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-prompt"'));
    fake.child.feed(PROMPT_OK);
    fake.child.feed(
      '{"type":"event","threadId":"g-sess-1","event":{"type":"message_update","delta":"partial"}}',
    );
    await step(() => log.events.length === 1);
    controller.abort();
    fake.child.close();
    const result = await driver.result;
    expect(result.aborted).toBe(true);
    expect(log.events.map((e) => e.type)).toEqual(["message_update", "agent_settled"]);
  }, 15_000);

  test("a grandchild that never produced an event gets no terminal event (no phantom client row)", async () => {
    const fake = fakeSpawner();
    const log = { events: [], uiRequests: [] };
    const driver = startGrandchildTask({
      spec: spec(),
      hooks: hooks(log),
      spawnWorker: fake.spawn,
    });
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-start"'));
    fake.child.close();
    const result = await driver.result;
    expect(result.isError).toBe(true);
    expect(log.events).toEqual([]);
  }, 15_000);

  test("a normal run emits exactly one terminal event (no duplicate synthesis)", async () => {
    const fake = fakeSpawner();
    const log = { events: [], uiRequests: [] };
    const driver = await reachRunning(fake, hooks(log));
    fake.child.feed(
      '{"type":"event","threadId":"g-sess-1","event":{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}}',
    );
    fake.child.feed('{"type":"event","threadId":"g-sess-1","event":{"type":"agent_settled"}}');
    fake.child.close();
    await driver.result;
    expect(log.events.filter((e) => e.type === "agent_settled")).toHaveLength(1);
  }, 15_000);

  test("a duplicate agent_settled from the child is dropped (exactly-once terminal)", async () => {
    const fake = fakeSpawner();
    const log = { events: [], uiRequests: [] };
    const driver = await reachRunning(fake, hooks(log));
    fake.child.feed('{"type":"event","threadId":"g-sess-1","event":{"type":"agent_settled"}}');
    fake.child.feed('{"type":"event","threadId":"g-sess-1","event":{"type":"agent_settled"}}');
    fake.child.close();
    await driver.result;
    expect(log.events.filter((e) => e.type === "agent_settled")).toHaveLength(1);
  }, 15_000);

  test("a throwing terminal hook does not reject the result or skip teardown", async () => {
    const fake = fakeSpawner();
    const log = { events: [], uiRequests: [] };
    let attempted = false;
    const throwing: GrandchildHooks = {
      ...hooks(log),
      onEvent: (event) => {
        if (event.type === "agent_settled") {
          attempted = true;
          throw new Error("hook boom");
        }
        log.events.push(event);
      },
    };
    const driver = await reachRunning(fake, throwing);
    fake.child.feed(
      '{"type":"event","threadId":"g-sess-1","event":{"type":"message_update","delta":"partial"}}',
    );
    await step(() => log.events.length === 1);
    fake.child.close();
    // The fallback terminal relay throws inside the hook; the result must still
    // resolve (registry settle accounting depends on it) and teardown must run.
    const result = await driver.result;
    expect(attempted).toBe(true);
    expect(result.isError).toBe(true);
  }, 15_000);
});

/** Bring one fake grandchild to the running state (start + prompt acked). */
async function reachRunning(
  fake: ReturnType<typeof fakeSpawner>,
  hooking: GrandchildHooks,
): Promise<ReturnType<typeof startGrandchildTask>> {
  const driver = startGrandchildTask({ spec: spec(), hooks: hooking, spawnWorker: fake.spawn });
  await step(() => lineStartsWith(fake.child.lines, '{"id":"g-start"'));
  fake.child.feed(START_OK);
  await step(() => lineStartsWith(fake.child.lines, '{"id":"g-prompt"'));
  fake.child.feed(PROMPT_OK);
  return driver;
}

describe("steer (stage 7)", () => {
  test("steer writes a uniquely-id'd line and resolves the ack verbatim", async () => {
    const fake = fakeSpawner();
    const driver = await reachRunning(fake, hooks({ events: [], uiRequests: [] }));
    const first = driver.steer("pivot to plan b");
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-steer-0"'));
    const line = fake.child.lines.find((l) => l.startsWith('{"id":"g-steer-0"'));
    expect(line).toContain('"type":"steer"');
    expect(line).toContain('"threadId":"g-sess-1"');
    expect(line).toContain("pivot to plan b");
    fake.child.feed('{"id":"g-steer-0","type":"response","command":"steer","success":true}');
    expect(await first).toBe(true);
    // A rejected steer surfaces the grandchild's own error string.
    const second = driver.steer("again");
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-steer-1"'));
    fake.child.feed(
      '{"id":"g-steer-1","type":"response","command":"steer","success":false,"error":"grandchild is not streaming"}',
    );
    expect(await second).toBe("grandchild is not streaming");
    fake.child.feed('{"type":"event","threadId":"g-sess-1","event":{"type":"agent_settled"}}');
    fake.child.close();
    await driver.result;
  }, 15_000);

  test("steer before start completes reports not-ready; after settle returns false", async () => {
    const fake = fakeSpawner();
    const driver = startGrandchildTask({
      spec: spec(),
      hooks: hooks({ events: [], uiRequests: [] }),
      spawnWorker: fake.spawn,
    });
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-start"'));
    // No START_OK yet: the grandchild session id is unknown.
    expect(await driver.steer("early")).toBe("grandchild not ready");
    fake.child.feed(START_OK);
    await step(() => lineStartsWith(fake.child.lines, '{"id":"g-prompt"'));
    fake.child.feed(PROMPT_OK);
    fake.child.feed('{"type":"event","threadId":"g-sess-1","event":{"type":"agent_settled"}}');
    fake.child.close();
    await driver.result;
    expect(await driver.steer("late")).toBe(false);
  }, 15_000);
});

describe("inter-agent message relay (stage 8)", () => {
  function messageHooks(log: { messages: Array<{ text: string; to?: string }> }): GrandchildHooks {
    return {
      ...hooks({ events: [], uiRequests: [] }),
      onMessage: (message) => {
        log.messages.push(message);
      },
    };
  }

  test("subagent_message frames reach onMessage with text (and to); no hook = ignored", async () => {
    const fake = fakeSpawner();
    const log = { messages: [] };
    const driver = await reachRunning(fake, messageHooks(log));
    fake.child.feed(
      '{"type":"subagent_message","threadId":"g-sess-1","subagentId":"sub_self","agent":"echoer","text":"found the flaky test"}',
    );
    fake.child.feed(
      '{"type":"subagent_message","threadId":"g-sess-1","subagentId":"sub_self","agent":"echoer","to":"sub_sibling","text":"handoff"}',
    );
    await step(() => log.messages.length === 2);
    expect(log.messages[0]).toEqual({ text: "found the flaky test" });
    expect(log.messages[1]).toEqual({ text: "handoff", to: "sub_sibling" });
    fake.child.feed('{"type":"event","threadId":"g-sess-1","event":{"type":"agent_settled"}}');
    fake.child.close();
    await driver.result;
  }, 15_000);

  test("malformed subagent_message (no text) is fatal, like malformed events", async () => {
    const fake = fakeSpawner();
    const driver = await reachRunning(fake, hooks({ events: [], uiRequests: [] }));
    fake.child.feed('{"type":"subagent_message","threadId":"g-sess-1","text":""}');
    fake.child.close();
    const result = await driver.result;
    expect(result.isError).toBe(true);
    expect(result.errorMessage ?? "").toContain("subagent_message");
  }, 15_000);
});

describe("pending ui frame retention (v0.14 read face)", () => {
  test("症状防护「无界保留」：超出待答帧上限按协议违例处死 grandchild", async () => {
    const fake = fakeSpawner();
    const driver = await reachRunning(fake, hooks({ events: [], uiRequests: [] }));
    for (let index = 0; index < 20; index += 1) {
      fake.child.feed(
        `{"type":"ui_request","requestId":"req-${index}","threadId":"g-sess-1","method":"confirm"}`,
      );
    }
    fake.child.close(); // the real child's close follows the fatal kill
    const result = await driver.result;
    expect(result.isError).toBe(true);
    expect(result.errorMessage ?? "").toContain("pending dialog cap");
  }, 15_000);

  test("症状回归「grandchild 弹窗超时后读口复活死弹窗」：路由表与读面的存活语义（TTL 过滤在实现层）", async () => {
    const fake = fakeSpawner();
    const driver = await reachRunning(fake, hooks({ events: [], uiRequests: [] }));
    fake.child.feed(
      '{"type":"ui_request","requestId":"req-old","threadId":"g-sess-1","method":"confirm"}',
    );
    fake.child.feed(
      '{"type":"ui_request","requestId":"req-new","threadId":"g-sess-1","method":"confirm"}',
    );
    await step(() => driver.pendingUiFrames().length === 2);
    expect(driver.pendingUiFrames().map((frame) => frame["requestId"])).toEqual([
      "req-old",
      "req-new",
    ]);
    // 应答即除名：路由表条目删除后读面同步消失（TTL 只隐藏超时未应答的帧）
    expect(driver.resolveUi("req-old", { confirmed: true })).toBe(true);
    expect(driver.pendingUiFrames().map((frame) => frame["requestId"])).toEqual(["req-new"]);
    fake.child.feed('{"type":"event","threadId":"g-sess-1","event":{"type":"agent_settled"}}');
    await step(() => lineIncludes(fake.child.lines, '"type":"thread/stop"'));
    fake.child.close();
    await driver.result;
  }, 15_000);
});

/**
 * 对抗处置（adv-lifecycle）：TTL 只在读面隐藏、从不清理条目，而 cap 按原始
 * map 大小计数——16 条早已超时（孙进程侧自行结算、不通知父进程）的弹窗会
 * 把第 17 条新弹窗判成协议违例处死健康任务，而此刻读面显示零弹窗。
 * 过期条目 = 死弹窗：插入路径清扫，cap 只计未过期条目。
 */
describe("pending ui frame retention: expired entries are pruned, cap counts live only", () => {
  test("纯层：16 条全过期后，第 17 条新 id 不再触发 cap（且过期条目被清扫）", () => {
    const frames = new Map<string, RetainedUiFrame>();
    for (let index = 0; index < MAX_PENDING_UI_FRAMES; index += 1) {
      frames.set(`r${index}`, { frame: { requestId: `r${index}` }, at: 0 });
    }
    expect(pendingUiFrameList(frames, PENDING_DIALOG_TTL_MS + 1)).toEqual([]); // 读面为空
    expect(exceedsPendingUiCap(frames, "r-new", PENDING_DIALOG_TTL_MS + 1)).toBe(false);
    expect(frames.size).toBe(0); // 过期即死：不只是隐藏
  });

  test("纯层：未过期条目仍计入 cap（清扫只针对过期）", () => {
    const now = 1_000_000;
    const frames = new Map<string, RetainedUiFrame>();
    for (let index = 0; index < MAX_PENDING_UI_FRAMES; index += 1) {
      frames.set(`r${index}`, { frame: { requestId: `r${index}` }, at: now });
    }
    expect(exceedsPendingUiCap(frames, "r-new", now)).toBe(true);
    expect(frames.size).toBe(MAX_PENDING_UI_FRAMES);
  });

  test("runner 层：16 条弹窗超时后第 17 条不再处死任务（症状回归）", async () => {
    const fake = fakeSpawner();
    const driver = await reachRunning(fake, hooks({ events: [], uiRequests: [] }));
    for (let index = 0; index < MAX_PENDING_UI_FRAMES; index += 1) {
      fake.child.feed(
        `{"type":"ui_request","requestId":"req-${index}","threadId":"g-sess-1","method":"confirm"}`,
      );
    }
    await step(() => driver.pendingUiFrames().length === MAX_PENDING_UI_FRAMES);
    const realNow = Date.now;
    Date.now = () => realNow() + PENDING_DIALOG_TTL_MS + 1; // 全部过期
    try {
      fake.child.feed(
        '{"type":"ui_request","requestId":"req-new","threadId":"g-sess-1","method":"confirm"}',
      );
      await step(() => driver.pendingUiFrames().length === 1);
      expect(driver.pendingUiFrames().map((frame) => frame["requestId"])).toEqual(["req-new"]);
    } finally {
      Date.now = realNow;
    }
    fake.child.feed('{"type":"event","threadId":"g-sess-1","event":{"type":"agent_settled"}}');
    await step(() => lineIncludes(fake.child.lines, '"type":"thread/stop"'));
    fake.child.close();
    const result = await driver.result;
    expect(result.isError).toBe(false); // 不再按协议违例处死
  }, 15_000);
});

/**
 * 对抗处置（adv-proto）：requestId 非字符串的孙进程 ui_request 帧此前「中继
 * 可见、读面不可见」——客户端收到一个永远无法应答（ui_response 需要
 * requestId）且重载后消失的弹窗。协议同口径：requestId 非非空字符串 =
 * malformed 帧，按既有 malformed 处置（fatal），不再中继。
 */
describe("grandchild ui_request frame requestId contract (adversarial)", () => {
  test("症状回归「非字符串 requestId 中继/读面分叉」：malformed 帧不中继、按协议违例处死", async () => {
    const fake = fakeSpawner();
    const log = { events: [], uiRequests: [] };
    const driver = await reachRunning(fake, hooks(log));
    fake.child.feed(
      '{"type":"ui_request","requestId":42,"threadId":"g-sess-1","method":"confirm"}',
    );
    await step(() => driver.result.isDone === true || lineIncludes(fake.child.lines, "stop"));
    expect(log.uiRequests).toEqual([]); // 不中继
    fake.child.close();
    const result = await driver.result;
    expect(result.isError).toBe(true);
    expect(result.errorMessage ?? "").toContain("malformed ui_request");
  }, 15_000);

  test("空串 requestId 同为 malformed", async () => {
    const fake = fakeSpawner();
    const log = { events: [], uiRequests: [] };
    const driver = await reachRunning(fake, hooks(log));
    fake.child.feed(
      '{"type":"ui_request","requestId":"","threadId":"g-sess-1","method":"confirm"}',
    );
    await step(() => driver.result.isDone === true || lineIncludes(fake.child.lines, "stop"));
    expect(log.uiRequests).toEqual([]);
    fake.child.close();
    const result = await driver.result;
    expect(result.isError).toBe(true);
    expect(result.errorMessage ?? "").toContain("malformed ui_request");
  }, 15_000);
});

/**
 * 处置遗留①：保留表只按条数（16）封顶，单帧字节只受管道行上限（128 MiB）
 * 约束——理论上每孙进程可钉住 ~2 GiB。弹窗是小载荷（title/message），单帧
 * 超出字节上限 = 协议违例处死；保留面字节上界 = 16 × 64 KiB = 1 MiB。
 */
describe("pending ui frame byte cap (disposition leftover 1)", () => {
  test("症状回归「单帧无字节上界」：100 KiB 的 ui_request 帧按协议违例处死", async () => {
    const fake = fakeSpawner();
    const log = { events: [], uiRequests: [] };
    const driver = await reachRunning(fake, hooks(log));
    const huge = "x".repeat(100 * 1024);
    fake.child.feed(
      `{"type":"ui_request","requestId":"big","threadId":"g-sess-1","method":"confirm","title":"${huge}"}`,
    );
    fake.child.close();
    const result = await driver.result;
    expect(result.isError).toBe(true);
    expect(result.errorMessage ?? "").toContain("pending dialog frame size cap");
  }, 15_000);

  test("上界内的帧照常保留（阈值是字节、非 code unit）", async () => {
    const fake = fakeSpawner();
    const driver = await reachRunning(fake, hooks({ events: [], uiRequests: [] }));
    const bigButLegal = "y".repeat(60 * 1024); // 60 KiB ASCII < 64 KiB cap
    fake.child.feed(
      `{"type":"ui_request","requestId":"ok","threadId":"g-sess-1","method":"confirm","title":"${bigButLegal}"}`,
    );
    await step(() => driver.pendingUiFrames().length === 1);
    fake.child.feed('{"type":"event","threadId":"g-sess-1","event":{"type":"agent_settled"}}');
    await step(() => lineIncludes(fake.child.lines, '"type":"thread/stop"'));
    fake.child.close();
    const result = await driver.result;
    expect(result.isError).toBe(false);
  }, 15_000);
});
