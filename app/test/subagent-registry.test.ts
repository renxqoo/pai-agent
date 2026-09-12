import { describe, expect, test } from "bun:test";
import type {
  GrandchildDriver,
  GrandchildHooks,
  GrandchildResult,
  GrandchildTaskSpec,
  startGrandchildTask,
} from "../src/backend/pi-coding-agent/subagent-process.ts";
import {
  ENVELOPE_TASK_CAP,
  MAX_CONCURRENT_SUBAGENTS,
  MAX_INFLIGHT_PER_CONVERSATION,
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
    permissionThreadId: "tid-test",
  };
}

interface FakeLaunch {
  spec: GrandchildTaskSpec;
  signal: AbortSignal | undefined;
  settle: (result: GrandchildResult) => void;
  driver: GrandchildDriver;
  /** v0.14: frames the fake driver reports as unsettled (tests mutate). */
  uiFrames: Array<Record<string, unknown>>;
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
    const uiFrames: Array<Record<string, unknown>> = [];
    const launch: FakeLaunch = {
      spec: deps.spec,
      signal: deps.signal,
      settle: resolveResult,
      uiFrames,
      driver: {
        result,
        resolveUi: () => false,
        steer: () => Promise.resolve(false),
        // eslint-disable-next-line unicorn/no-useless-undefined -- interface requires undefined before settle
        progress: () => undefined,
        pendingUiFrames: () => [...uiFrames],
      },
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
    const handle = registry.launch({ spec: makeSpec("sub_n100"), hooks: HOOKS, background: true });
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
    const handle = registry.launch({ spec: makeSpec("sub_n200"), hooks: HOOKS, background: true });
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
    const handle = registry.launch({ spec: makeSpec("sub_n300"), hooks: HOOKS, background: true });
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
    const killed = registry.launch({ spec: makeSpec("sub_n400"), hooks: HOOKS, background: true });
    registry.killAll();
    const [killedLaunch] = fake.launches;
    if (killedLaunch === undefined) throw new Error("no launch");
    killedLaunch.settle({ ...okResult(killedLaunch.spec), aborted: true, isError: true });
    await killed.result;
    const stopped = registry.launch({ spec: makeSpec("sub_n401"), hooks: HOOKS, background: true });
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
    const handle = registry.launch({ spec: makeSpec("sub_n500"), hooks: HOOKS, background: true });
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
      const handle = registry.launch({
        spec: makeSpec(`sub_n6${i}${i}`),
        hooks: HOOKS,
        background: true,
      });
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
    const handle = registry.launch({ spec: makeSpec("sub_n700"), hooks: HOOKS, background: true });
    const [launch] = fake.launches;
    if (launch === undefined) throw new Error("no launch");
    launch.settle(okResult(launch.spec));
    await handle.result;
    await tick();
    expect(target.prompts.length).toBe(0);
    expect(registry.pendingCount()).toBe(0);
  });
});

describe("steer routing (stage 7)", () => {
  function steerableLauncher(): {
    start: StartTaskFn;
    launches: FakeLaunch[];
    steered: Array<{ id: string; message: string }>;
  } {
    const fake = makeFakeLauncher();
    const steered: Array<{ id: string; message: string }> = [];
    const start: StartTaskFn = (deps) => {
      const driver = fake.start(deps);
      return {
        ...driver,
        steer: (message: string) => {
          const launch = fake.launches.find((l) => l.driver === driver);
          steered.push({ id: launch?.spec.subagentId ?? "?", message });
          return Promise.resolve(true);
        },
      };
    };
    return { start, launches: fake.launches, steered };
  }

  test("running task's driver receives the steer; result surfaces verbatim", async () => {
    const fake = steerableLauncher();
    const registry = new SubagentRegistry({ startTask: fake.start });
    registry.launch({ spec: makeSpec("sub_s100"), hooks: HOOKS });
    const outcome = await registry.steer("sub_s100", "go faster");
    expect(outcome).toBe(true);
    expect(fake.steered).toEqual([{ id: "sub_s100", message: "go faster" }]);
  });

  test("queued, settled, and unknown ids fail with the status wording", async () => {
    const fake = makeFakeLauncher();
    const registry = new SubagentRegistry({ startTask: fake.start });
    for (let i = 0; i < 5; i++) registry.launch({ spec: makeSpec(`sub_s2${i}${i}`), hooks: HOOKS });
    const queued = await registry.steer("sub_s244", "x"); // 5th: never spawned
    expect(queued).toContain("not running");
    expect(queued).toContain("queued");
    const unknown = await registry.steer("sub_nope", "x");
    expect(unknown).toContain("unknown subagent");
    const [first] = fake.launches;
    if (first === undefined) throw new Error("no launch");
    first.settle(okResult(first.spec));
    await tick();
    const settled = await registry.steer(first.spec.subagentId, "x");
    expect(settled).toContain("not running");
  });
});

describe("inter-agent messages (stage 8/9)", () => {
  test("queued with envelope, delivered at a turn boundary; running-only", async () => {
    const fake = makeFakeLauncher();
    const target = makeSession();
    const registry = new SubagentRegistry({
      startTask: fake.start,
      getSession: () => target.session,
    });
    registry.launch({ spec: makeSpec("sub_m100"), hooks: HOOKS });
    target.setStreaming(true); // messages queue like settle notifications
    registry.queueMessage("sub_m100", { text: "found the bug" });
    registry.queueMessage("sub_m100", { text: "hand off to sibling", to: "sub_m200" });
    expect(registry.pendingCount()).toBe(2);
    target.setStreaming(false);
    registry.onTurnSettled();
    await tick();
    expect(target.prompts.length).toBe(1);
    expect(target.prompts[0]).toContain("[task-message] from subagent sub_m100 (echoer):");
    expect(target.prompts[0]).toContain("found the bug");
    target.setStreaming(false);
    registry.onTurnSettled();
    await tick();
    expect(target.prompts.length).toBe(2);
    expect(target.prompts[1]).toContain("intended for sub_m200");
    expect(target.prompts[1]).toContain("task_send");
  });

  test("project-sourced agent messages carry the unverified marker", async () => {
    const fake = makeFakeLauncher();
    const target = makeSession();
    const registry = new SubagentRegistry({
      startTask: fake.start,
      getSession: () => target.session,
    });
    const spec = { ...makeSpec("sub_m300"), projectSourced: true };
    registry.launch({ spec, hooks: HOOKS });
    registry.queueMessage("sub_m300", { text: "hello" });
    await tick();
    expect(target.prompts.length).toBe(1);
    expect(target.prompts[0]).toContain("unverified data");
  });

  test("11th message drops with a stderr note (parent-side cap)", () => {
    const fake = makeFakeLauncher();
    const stderr: string[] = [];
    // No session: delivery stays guarded off, so pendingCount is exact.
    const registry = new SubagentRegistry({
      startTask: fake.start,
      writeStderr: (t) => stderr.push(t),
    });
    registry.launch({ spec: makeSpec("sub_m400"), hooks: HOOKS });
    for (let i = 0; i < 12; i++) registry.queueMessage("sub_m400", { text: `m${i}` });
    expect(registry.pendingCount()).toBe(10);
    expect(stderr.some((t) => t.includes("message budget exhausted"))).toBe(true);
  });

  test("settled or killed tasks' messages are suppressed", async () => {
    const fake = makeFakeLauncher();
    const target = makeSession();
    const registry = new SubagentRegistry({
      startTask: fake.start,
      getSession: () => target.session,
    });
    const handle = registry.launch({ spec: makeSpec("sub_m500"), hooks: HOOKS, background: true });
    const [launch] = fake.launches;
    if (launch === undefined) throw new Error("no launch");
    launch.settle(okResult(launch.spec));
    await handle.result;
    await tick();
    expect(target.prompts.length).toBe(1); // the settle notification only
    registry.queueMessage("sub_m500", { text: "late frame" });
    expect(registry.pendingCount()).toBe(0);
    registry.killAll();
    const handle2 = registry.launch({ spec: makeSpec("sub_m501"), hooks: HOOKS, background: true });
    registry.killAll();
    // In-flight frame while the kill lands: suppressed by the killed flag
    // even though the entry has not settled yet.
    registry.queueMessage("sub_m501", { text: "dying gasp" });
    const [second] = fake.launches.slice(1);
    if (second === undefined) throw new Error("no second launch");
    second.settle({ ...okResult(second.spec), aborted: true, isError: true });
    await handle2.result;
    await tick();
    expect(target.prompts.length).toBe(1); // no wake from the dying gasp
    expect(registry.pendingCount()).toBe(0);
  });
});

describe("stage 6 adversarial review fixes", () => {
  /** Fake session with the REAL SDK's ordering: prompt() fires the run's
   * agent_settled (onTurnSettled) BEFORE it resolves. */
  function productionOrderSession() {
    const prompts: string[] = [];
    let onSettled: (() => void) | undefined;
    const session = {
      isStreaming: false,
      isCompacting: false,
      prompt: async (text: string): Promise<void> => {
        prompts.push(text);
        session.isStreaming = true;
        onSettled?.(); // agent_settled reaches the worker before resolution
        await tick(5);
        session.isStreaming = false;
      },
    };
    return {
      session,
      prompts,
      setSettleHook: (hook: () => void): void => {
        onSettled = hook;
      },
    };
  }

  test("P1-1: serial delivery chains through production prompt ordering", async () => {
    const fake = makeFakeLauncher();
    const target = productionOrderSession();
    const registry = new SubagentRegistry({
      startTask: fake.start,
      getSession: () => target.session,
    });
    target.setSettleHook(() => registry.onTurnSettled());
    target.session.isStreaming = true; // two settles while the main turn runs
    for (let i = 0; i < 2; i++) {
      const handle = registry.launch({
        spec: makeSpec(`sub_c${i}${i}`),
        hooks: HOOKS,
        background: true,
      });
      const launch = fake.launches[i];
      if (launch === undefined) throw new Error("missing launch");
      launch.settle({ ...okResult(launch.spec), output: `out-${i}` });
      await handle.result;
    }
    expect(registry.pendingCount()).toBe(2);
    target.session.isStreaming = false;
    registry.onTurnSettled();
    await tick(50);
    // The old code stranded #2: the settle of delivery #1's own run raced
    // the delivering flag and no further trigger existed.
    expect(target.prompts.length).toBe(2);
    expect(target.prompts[1]).toContain("out-1");
  });

  test("P1-2: foreground launches never queue notifications", async () => {
    const fake = makeFakeLauncher();
    const target = makeSession();
    const registry = new SubagentRegistry({
      startTask: fake.start,
      getSession: () => target.session,
    });
    const handle = registry.launch({ spec: makeSpec("sub_fg0"), hooks: HOOKS });
    const [launch] = fake.launches;
    if (launch === undefined) throw new Error("no launch");
    launch.settle(okResult(launch.spec));
    await handle.result;
    await tick();
    expect(target.prompts.length).toBe(0);
    expect(registry.pendingCount()).toBe(0);
  });

  test("P1-3: killAll drops queued notifications", async () => {
    const fake = makeFakeLauncher();
    const target = makeSession();
    const registry = new SubagentRegistry({
      startTask: fake.start,
      getSession: () => target.session,
    });
    target.setStreaming(true);
    const handle = registry.launch({
      spec: makeSpec("sub_kq0"),
      hooks: HOOKS,
      background: true,
    });
    const [launch] = fake.launches;
    if (launch === undefined) throw new Error("no launch");
    launch.settle(okResult(launch.spec));
    await handle.result;
    expect(registry.pendingCount()).toBe(1); // queued behind the stream
    registry.killAll(); // user abort: no wake turn may follow
    expect(registry.pendingCount()).toBe(0);
    target.setStreaming(false);
    registry.onTurnSettled();
    await tick();
    expect(target.prompts.length).toBe(0);
  });

  test("P1-4: launch enforces the in-flight cap synchronously", () => {
    const fake = makeFakeLauncher();
    const registry = new SubagentRegistry({ startTask: fake.start });
    // Fill to the cap without the tool's pre-check (two interleaved batches).
    for (let i = 0; i < MAX_INFLIGHT_PER_CONVERSATION; i++) {
      const handle = registry.launch({
        spec: makeSpec(`sub_p4${String(i).padStart(2, "0")}`),
        hooks: HOOKS,
      });
      expect(handle.status).not.toBe("rejected");
    }
    const over = registry.launch({ spec: makeSpec("sub_p4over"), hooks: HOOKS });
    expect(over.status).toBe("rejected");
    expect(over.rejection).toContain("Too many subagents in flight");
    expect(registry.inFlight()).toBe(MAX_INFLIGHT_PER_CONVERSATION);
  });

  test("P2-5: task_wait suppression recalls an already-queued notification", async () => {
    const fake = makeFakeLauncher();
    const target = makeSession();
    const registry = new SubagentRegistry({
      startTask: fake.start,
      getSession: () => target.session,
    });
    target.setStreaming(true);
    const handle = registry.launch({
      spec: makeSpec("sub_sq0"),
      hooks: HOOKS,
      background: true,
    });
    const [launch] = fake.launches;
    if (launch === undefined) throw new Error("no launch");
    launch.settle({ ...okResult(launch.spec), output: "once-only" });
    await handle.result;
    expect(registry.pendingCount()).toBe(1);
    registry.suppressNotifications(["sub_sq0"]); // task_wait consumes it
    expect(registry.pendingCount()).toBe(0);
    registry.releaseNotifications(["sub_sq0"]);
    target.setStreaming(false);
    registry.onTurnSettled();
    await tick();
    expect(target.prompts.length).toBe(0); // no double delivery
  });

  test("P2-6: retention evicts by completion order, not launch order", async () => {
    const fake = makeFakeLauncher();
    const registry = new SubagentRegistry({ startTask: fake.start });
    // Long task launched FIRST (occupies one live slot while held).
    const held = registry.launch({ spec: makeSpec("sub_late0"), hooks: HOOKS, background: true });
    const [heldLaunch] = fake.launches;
    if (heldLaunch === undefined) throw new Error("no held launch");
    // 16 more tasks settle (with distinct settle times) while it runs.
    for (let i = 0; i < RETAINED_CAP; i++) {
      const handle = registry.launch({
        spec: makeSpec(`sub_ev${String(i).padStart(2, "0")}`),
        hooks: HOOKS,
      });
      const launch = fake.launches.at(-1);
      if (launch === undefined) throw new Error("missing launch");
      launch.settle(okResult(launch.spec));
      await handle.result;
      await tick(2); // distinct settledAt ordering
    }
    heldLaunch.settle(okResult(heldLaunch.spec));
    await held.result;
    await tick(2);
    // The just-completed long task must be retained; the OLDEST settled
    // entry is the one evicted (launch-order eviction would drop sub_late0).
    expect(registry.statusOf("sub_late0")).toBe("completed");
    expect(registry.statusOf("sub_ev00")).toBe("unknown");
  });

  test("B-P3-7: task_out snapshots cap the expanded task envelope", () => {
    const fake = makeFakeLauncher();
    const registry = new SubagentRegistry({ startTask: fake.start });
    const big = `chain step: ${"x".repeat(80 * 1024)}`; // {previous} expansion
    registry.launch({ spec: { ...makeSpec("sub_env00"), task: big }, hooks: HOOKS });
    const snapshot = registry.snapshot("sub_env00");
    if (snapshot === undefined || Array.isArray(snapshot)) throw new Error("no snapshot");
    expect(Buffer.byteLength(snapshot.task, "utf8")).toBeLessThanOrEqual(ENVELOPE_TASK_CAP + 8);
  });
});

describe("pending dialogs read face (v0.14)", () => {
  test("running entries expose unsettled frames with spec identity; settled entries drop out", async () => {
    const fake = makeFakeLauncher();
    const registry = new SubagentRegistry({ startTask: fake.start });
    registry.launch({ spec: makeSpec("sub_pd1"), hooks: HOOKS });
    const [launch] = fake.launches;
    if (launch === undefined) throw new Error("no launch");
    const frame = {
      type: "ui_request",
      requestId: "req-a",
      threadId: "g-sess-9",
      method: "confirm",
      title: "Allow command execution?",
    };
    launch.uiFrames.push(frame);
    expect(registry.pendingDialogs()).toEqual([
      { requestId: "req-a", subagentId: "sub_pd1", agent: launch.spec.agent, frame },
    ]);
    launch.settle(okResult(launch.spec));
    await tick();
    expect(registry.pendingDialogs()).toEqual([]);
  });

  test("frames without a usable requestId are skipped (garbage degrade)", () => {
    const fake = makeFakeLauncher();
    const registry = new SubagentRegistry({ startTask: fake.start });
    registry.launch({ spec: makeSpec("sub_pd2"), hooks: HOOKS });
    const [launch] = fake.launches;
    if (launch === undefined) throw new Error("no launch");
    launch.uiFrames.push(
      { type: "ui_request", method: "confirm" },
      { type: "ui_request", requestId: "", method: "confirm" },
    );
    expect(registry.pendingDialogs()).toEqual([]);
  });
});
