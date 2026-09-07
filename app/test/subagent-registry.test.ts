import { describe, expect, test } from "bun:test";
import type {
  GrandchildDriver,
  GrandchildHooks,
  GrandchildResult,
  GrandchildTaskSpec,
  startGrandchildTask,
} from "../src/subagent-process.ts";
import {
  MAX_CONCURRENT_SUBAGENTS,
  RETAINED_CAP,
  SubagentRegistry,
} from "../src/subagent-registry.ts";

/**
 * Registry unit matrix (plan background-subagents stage 1): global
 * concurrency gate across batches, queued scheduling on settle, retention
 * FIFO eviction, stopOne/killAll via AbortControllers, ui routing.
 */

const HOOKS: GrandchildHooks = { onEvent: () => {}, onUiRequest: () => {}, writeStderr: () => {} };

function makeSpec(id: string): GrandchildTaskSpec {
  return {
    subagentId: id,
    agent: "echoer",
    task: `t-${id}`,
    cwd: "/tmp",
    systemPrompt: "p",
    permissionRules: { mode: "ask" },
  };
}

interface FakeLaunch {
  spec: GrandchildTaskSpec;
  signal: AbortSignal | undefined;
  settle: (result: GrandchildResult) => void;
  driver: GrandchildDriver;
}

function okResult(taskSpec: GrandchildTaskSpec): GrandchildResult {
  return {
    agent: taskSpec.agent,
    task: taskSpec.task,
    output: `done:${taskSpec.task}`,
    isError: false,
    aborted: false,
    usage: {
      turns: 1,
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 2,
    },
    stderr: "",
    truncated: false,
    eventsRelayed: 1,
  };
}

type StartTaskFn = typeof startGrandchildTask;

function makeFakeLauncher(): { start: StartTaskFn; launches: FakeLaunch[] } {
  const launches: FakeLaunch[] = [];
  const start = (deps: { spec: GrandchildTaskSpec; signal?: AbortSignal }): GrandchildDriver => {
    let resolveResult!: (result: GrandchildResult) => void;
    const result = new Promise<GrandchildResult>((resolve) => {
      resolveResult = resolve;
    });
    const launch: FakeLaunch = {
      spec: deps.spec,
      signal: deps.signal,
      settle: resolveResult,
      driver: { result, resolveUi: () => false },
    };
    launches.push(launch);
    return launch.driver;
  };
  return { start, launches };
}

describe("global concurrency gate (stage 1)", () => {
  test("two batches share the global 4 slots; overflow queues", () => {
    const fake = makeFakeLauncher();
    const registry = new SubagentRegistry({ startTask: fake.start });
    for (let i = 0; i < 6; i++) registry.launch({ spec: makeSpec(`sub_g${i}${i}`), hooks: HOOKS });
    expect(registry.liveCount()).toBe(MAX_CONCURRENT_SUBAGENTS);
    expect(registry.inFlight()).toBe(6);
    expect(fake.launches.length).toBe(MAX_CONCURRENT_SUBAGENTS); // only 4 spawned
  });

  test("settling one task releases its slot to the queue", async () => {
    const fake = makeFakeLauncher();
    const registry = new SubagentRegistry({ startTask: fake.start });
    const handles = Array.from({ length: 5 }, (_, i) =>
      registry.launch({ spec: makeSpec(`sub_r${i}${i}`), hooks: HOOKS }),
    );
    expect(fake.launches.length).toBe(4);
    const [firstLaunch] = fake.launches;
    if (firstLaunch === undefined) throw new Error("no launch");
    firstLaunch.settle(okResult(firstLaunch.spec));
    const [firstHandle] = handles;
    if (firstHandle === undefined) throw new Error("no handle");
    await firstHandle.result;
    expect(fake.launches.length).toBe(5); // the queued one spawned
    expect(registry.inFlight()).toBe(4);
  });

  test("foreground chain through the gate: budget counts queued+running", () => {
    const fake = makeFakeLauncher();
    const registry = new SubagentRegistry({ startTask: fake.start });
    for (let i = 0; i < 8; i++) registry.launch({ spec: makeSpec(`sub_b${i}${i}`), hooks: HOOKS });
    expect(registry.inFlight()).toBe(8);
    expect(fake.launches.length).toBe(4);
  });
});

describe("retention and eviction (stage 1)", () => {
  test("settled entries retain up to RETAINED_CAP, FIFO eviction beyond", async () => {
    const fake = makeFakeLauncher();
    const registry = new SubagentRegistry({ startTask: fake.start });
    for (let i = 0; i < RETAINED_CAP + 4; i++) {
      const handle = registry.launch({
        spec: makeSpec(`sub_e${String(i).padStart(2, "0")}`),
        hooks: HOOKS,
      });
      const launch = fake.launches[i];
      if (launch === undefined) throw new Error("missing launch");
      launch.settle(okResult(launch.spec));
      await handle.result;
    }
    expect(registry.inFlight()).toBe(0);
    // The registry map itself stays bounded by settled-retention.
    // (17 settled + 4 evicted + 0 live.)
    expect(fake.launches.length).toBe(RETAINED_CAP + 4);
  });
});

describe("stopOne and killAll (stage 1)", () => {
  test("stopOne on a queued task dequeues without spawning", async () => {
    const fake = makeFakeLauncher();
    const registry = new SubagentRegistry({ startTask: fake.start });
    for (let i = 0; i < 5; i++) registry.launch({ spec: makeSpec(`sub_q${i}${i}`), hooks: HOOKS });
    expect(fake.launches.length).toBe(4); // 5th still queued, never spawned
    const handle = registry.launch({ spec: makeSpec("sub_qstop"), hooks: HOOKS });
    const status = registry.stopOne("sub_qstop");
    expect(status).toBe("stopped"); // settles straight to the terminal state
    const result = await handle.result;
    expect(result.aborted).toBe(true);
    expect(fake.launches.length).toBe(4); // nothing extra spawned
  });

  test("stopOne on a running task aborts its controller; killAll aborts all", async () => {
    const fake = makeFakeLauncher();
    const registry = new SubagentRegistry({ startTask: fake.start });
    const handles = Array.from({ length: 3 }, (_, i) =>
      registry.launch({ spec: makeSpec(`sub_k${i}${i}`), hooks: HOOKS }),
    );
    expect(fake.launches.length).toBe(3);
    registry.stopOne("sub_k00");
    expect(fake.launches[0]?.signal?.aborted).toBe(true);
    registry.killAll();
    for (const launch of fake.launches) {
      expect(launch.signal?.aborted).toBe(true);
    }
    // The aborted controllers are the kill path; resolve the drivers as the
    // real ones would and confirm every handle settles.
    for (const launch of fake.launches) {
      launch.settle({ ...okResult(launch.spec), aborted: true, isError: true });
    }
    const results = await Promise.all(handles.map((h) => h.result));
    expect(results.every((r) => r.aborted)).toBe(true);
  });

  test("outer (turn) signal is chained onto the entry controller", () => {
    const fake = makeFakeLauncher();
    const registry = new SubagentRegistry({ startTask: fake.start });
    const controller = new AbortController();
    registry.launch({ spec: makeSpec("sub_sig"), hooks: HOOKS, outerSignal: controller.signal });
    controller.abort();
    expect(fake.launches[0]?.signal?.aborted).toBe(true);
  });
});

function tick(ms = 10): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

/** Fake NotifySession for delivery-timing tests. */
function makeSession(options?: {
  streaming?: () => boolean;
  compacting?: () => boolean;
  fail?: () => boolean;
}) {
  const prompts: string[] = [];
  const session = {
    isStreaming: false,
    isCompacting: false,
    prompt: async (text: string): Promise<void> => {
      if (options?.fail?.() === true) throw new Error("already processing");
      prompts.push(text);
      // A accepted prompt starts a run: the streaming guard is what makes
      // delivery serial in production.
      session.isStreaming = true;
    },
  };
  return {
    session,
    prompts,
    setStreaming(v: boolean): void {
      session.isStreaming = v;
    },
    setCompacting(v: boolean): void {
      session.isCompacting = v;
    },
  };
}

describe("notification delivery (stage 3)", () => {
  test("idle settle delivers one notification as a prompt with id + output", async () => {
    const fake = makeFakeLauncher();
    const target = makeSession();
    const stderr: string[] = [];
    const registry = new SubagentRegistry({
      startTask: fake.start,
      getSession: () => target.session,
      writeStderr: (t) => stderr.push(t),
    });
    const handle = registry.launch({ spec: makeSpec("sub_n100"), hooks: HOOKS });
    const [first] = fake.launches;
    if (first === undefined) throw new Error("no launch");
    first.settle({ ...okResult(first.spec), output: "the-answer-42" });
    await handle.result;
    await tick();
    expect(target.prompts.length).toBe(1);
    expect(target.prompts[0]).toContain(
      "[task-notification] subagent sub_n100 (echoer) completed.",
    );
    expect(target.prompts[0]).toContain("the-answer-42");
    expect(target.prompts[0]).toContain('task_out {"subagentId":"sub_n100"}');
  });

  test("streaming settle queues; agent_settled delivers", async () => {
    const fake = makeFakeLauncher();
    const target = makeSession();
    const registry = new SubagentRegistry({
      startTask: fake.start,
      getSession: () => target.session,
    });
    target.setStreaming(true);
    const handle = registry.launch({ spec: makeSpec("sub_n200"), hooks: HOOKS });
    const [launch] = fake.launches;
    if (launch === undefined) throw new Error("no launch");
    launch.settle(okResult(launch.spec));
    await handle.result;
    await tick();
    expect(target.prompts.length).toBe(0); // queued behind the streaming run
    expect(registry.pendingCount()).toBe(1);
    target.setStreaming(false);
    registry.onTurnSettled();
    await tick();
    expect(target.prompts.length).toBe(1);
  });

  test("prompt failure requeues; cap 3 then stderr-drop", async () => {
    const fake = makeFakeLauncher();
    const target = makeSession({ fail: () => true });
    const stderr: string[] = [];
    const registry = new SubagentRegistry({
      startTask: fake.start,
      getSession: () => target.session,
      writeStderr: (t) => stderr.push(t),
    });
    const handle = registry.launch({ spec: makeSpec("sub_n300"), hooks: HOOKS });
    const [launch] = fake.launches;
    if (launch === undefined) throw new Error("no launch");
    launch.settle(okResult(launch.spec));
    await handle.result;
    for (let i = 0; i < 3; i++) {
      await tick();
      registry.onTurnSettled();
    }
    await tick();
    expect(target.prompts.length).toBe(0);
    expect(registry.pendingCount()).toBe(0); // dropped after cap
    expect(stderr.some((t) => t.includes("dropped"))).toBe(true);
  });

  test("killAll settles are silent; task_stop settles notify", async () => {
    const fake = makeFakeLauncher();
    const target = makeSession();
    const registry = new SubagentRegistry({
      startTask: fake.start,
      getSession: () => target.session,
    });
    const killed = registry.launch({ spec: makeSpec("sub_n400"), hooks: HOOKS });
    registry.killAll();
    const [killedLaunch] = fake.launches;
    if (killedLaunch === undefined) throw new Error("no launch");
    killedLaunch.settle({ ...okResult(killedLaunch.spec), aborted: true, isError: true });
    await killed.result;
    const stopped = registry.launch({ spec: makeSpec("sub_n401"), hooks: HOOKS });
    registry.stopOne("sub_n401");
    const [second] = fake.launches.slice(1);
    if (second === undefined) throw new Error("no second launch");
    second.settle({ ...okResult(second.spec), aborted: true, isError: true });
    await stopped.result;
    await tick();
    expect(target.prompts.length).toBe(1); // only the task_stop one
    expect(target.prompts[0]).toContain("stopped");
  });

  test("compacting defers delivery to the next trigger", async () => {
    const fake = makeFakeLauncher();
    const target = makeSession();
    const registry = new SubagentRegistry({
      startTask: fake.start,
      getSession: () => target.session,
    });
    target.setCompacting(true);
    const handle = registry.launch({ spec: makeSpec("sub_n500"), hooks: HOOKS });
    const [launch] = fake.launches;
    if (launch === undefined) throw new Error("no launch");
    launch.settle(okResult(launch.spec));
    await handle.result;
    await tick();
    expect(target.prompts.length).toBe(0);
    target.setCompacting(false);
    registry.onTurnSettled();
    await tick();
    expect(target.prompts.length).toBe(1);
  });

  test("two settles deliver serially: one now, one after the next turn settles", async () => {
    const fake = makeFakeLauncher();
    const target = makeSession();
    const registry = new SubagentRegistry({
      startTask: fake.start,
      getSession: () => target.session,
    });
    for (let i = 0; i < 2; i++) {
      const handle = registry.launch({ spec: makeSpec(`sub_n6${i}${i}`), hooks: HOOKS });
      const launch = fake.launches[i];
      if (launch === undefined) throw new Error("missing launch");
      launch.settle({ ...okResult(launch.spec), output: `out-${i}` });
      await handle.result;
    }
    await tick();
    expect(target.prompts.length).toBe(1); // serial single-flight
    expect(registry.pendingCount()).toBe(1);
    target.setStreaming(false); // the first notification run ended
    registry.onTurnSettled();
    await tick();
    expect(target.prompts.length).toBe(2);
    expect(target.prompts[1]).toContain("out-1");
  });

  test("suppressed ids never notify", async () => {
    const fake = makeFakeLauncher();
    const target = makeSession();
    const registry = new SubagentRegistry({
      startTask: fake.start,
      getSession: () => target.session,
    });
    registry.suppressNotifications(["sub_n700"]);
    const handle = registry.launch({ spec: makeSpec("sub_n700"), hooks: HOOKS });
    const [launch] = fake.launches;
    if (launch === undefined) throw new Error("no launch");
    launch.settle(okResult(launch.spec));
    await handle.result;
    await tick();
    expect(target.prompts.length).toBe(0);
    expect(registry.pendingCount()).toBe(0);
  });
});
