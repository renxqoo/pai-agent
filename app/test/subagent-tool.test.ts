import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createTaskTool, type TaskToolDeps } from "../src/subagent-tool.ts";
import {
  MAX_CONCURRENT_SUBAGENTS,
  MAX_INFLIGHT_PER_CONVERSATION,
  MAX_TASKS_PER_CALL,
  SubagentRegistry,
} from "../src/subagent-registry.ts";
import type {
  GrandchildDriver,
  GrandchildResult,
  GrandchildTaskSpec,
} from "../src/subagent-process.ts";

/**
 * Tool-level unit matrix (plan §6): mode exclusivity, limits, cwd
 * constraint, unknown agents, budget reservation/release, concurrency gate,
 * and the model-fallback note. Grandchild launches go through the startTask
 * seam (no real processes).
 */

const agentDir = mkdtempSync(join(tmpdir(), "pai-cli-tool-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

mkdirSync(join(agentDir, "agents"), { recursive: true });
writeFileSync(
  join(agentDir, "agents", "echoer.md"),
  "---\nname: echoer\ndescription: echoes\n---\nYou echo.\n",
);
writeFileSync(
  join(agentDir, "agents", "modelagent.md"),
  "---\nname: modelagent\ndescription: has a model\nmodel: glm/no-such-model\n---\nYou model.\n",
);

interface ToolExecuteResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  details?: { mode: string; results: Array<{ agent: string; output: string }> };
}

interface ToolCtx {
  cwd: string;
  model: unknown;
  thinkingLevel: string | undefined;
}

// eslint-disable-next-line max-params -- SDK-imposed tool execute signature
type ToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: ToolCtx,
) => Promise<ToolExecuteResult>;

interface RegisteredTool {
  execute: ToolExecute;
}

interface ToolHarness {
  tool: RegisteredTool;
  tools: Map<string, RegisteredTool>;
  registry: SubagentRegistry;
  launches: GrandchildTaskSpec[];
  steers: Array<{ id: string; message: string }>;
  maxConcurrent: () => number;
}

function makeOkResult(): (spec: GrandchildTaskSpec) => GrandchildResult {
  return (spec) => ({
    agent: spec.agent,
    task: spec.task,
    output: `done:${spec.task}`,
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
    eventsRelayed: 3,
  });
}

function specTemplate(): GrandchildTaskSpec {
  return {
    subagentId: "sub_fill",
    agent: "echoer",
    task: "fill",
    cwd: tmpdir(),
    systemPrompt: "p",
    permissionThreadId: "tid-test",
  };
}

function makeHarness(options?: { hold?: boolean }): ToolHarness {
  const launches: GrandchildTaskSpec[] = [];
  const held: Array<{ spec: GrandchildTaskSpec; settle: (result: GrandchildResult) => void }> = [];
  const steers: Array<{ id: string; message: string }> = [];
  let inFlightNow = 0;
  let maxSeen = 0;
  const okResult = makeOkResult();
  const startTask = (deps: { spec: GrandchildTaskSpec }): GrandchildDriver => {
    launches.push(deps.spec);
    inFlightNow += 1;
    maxSeen = Math.max(maxSeen, inFlightNow);
    // Steers record and ack — the driver mechanics have their own tests.
    const steer = (message: string): Promise<boolean | string> => {
      steers.push({ id: deps.spec.subagentId, message });
      return Promise.resolve(true);
    };
    if (options?.hold === true) {
      let resolveHeld!: (result: GrandchildResult) => void;
      const result = new Promise<GrandchildResult>((resolve) => {
        resolveHeld = resolve;
      });
      held.push({ spec: deps.spec, settle: resolveHeld });
      return {
        result,
        resolveUi: () => false,
        steer,
        // eslint-disable-next-line unicorn/no-useless-undefined -- interface requires undefined before settle
        progress: () => undefined,
      };
    }
    const result = Promise.resolve(okResult(deps.spec)).finally(() => {
      inFlightNow -= 1;
    });
    return {
      result,
      resolveUi: () => false,
      steer,
      // eslint-disable-next-line unicorn/no-useless-undefined -- interface requires undefined before settle
      progress: () => undefined,
    };
  };
  const modelRuntime = {
    getAvailableSnapshot: () => [],
    refresh: async () => {},
  } as unknown as ModelRuntime;
  const registry = new SubagentRegistry({ startTask });
  const deps: TaskToolDeps = {
    emit: () => {},
    modelRuntime,
    registry,
    writeStderr: () => {},
    getThreadId: () => "tid-1",
  };
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool: (def: RegisteredTool & { name: string }) => {
      tools.set(def.name, def);
    },
  } as unknown as ExtensionAPI;
  createTaskTool(deps, false)(pi);
  const task = tools.get("task");
  if (task === undefined) throw new Error("task tool was not registered");
  return {
    tool: task,
    tools,
    registry,
    launches,
    steers,
    maxConcurrent: () => maxSeen,
    settleHeld(): void {
      for (const item of held.splice(0)) item.settle(okResult(item.spec));
    },
  };
}

async function runTool(
  harness: ToolHarness,
  params: Record<string, unknown>,
  model?: unknown,
): Promise<{ text: string; isError: boolean | undefined; details: ToolExecuteResult["details"] }> {
  const result = await harness.tool.execute("call-1", params, undefined, undefined, {
    cwd: tmpdir(),
    model,
    thinkingLevel: undefined,
  });
  const [first] = result.content;
  return {
    text: first !== undefined && first.type === "text" ? (first.text ?? "") : "",
    isError: result.isError,
    details: result.details,
  };
}

async function runNamed(deps: {
  harness: ToolHarness;
  name: string;
  params: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<{ text: string; isError: boolean | undefined; details: unknown }> {
  const { harness, name, params, signal } = deps;
  const def = harness.tools.get(name);
  if (def === undefined) {
    throw new Error(`tool ${name} not registered`);
  }
  const result = await def.execute("q-1", params, signal, undefined, {
    cwd: tmpdir(),
    model: undefined,
    thinkingLevel: undefined,
  });
  const [first] = result.content;
  return {
    text: first !== undefined && first.type === "text" ? (first.text ?? "") : "",
    isError: result.isError,
    details: result.details,
  };
}

describe("query tools (background plan stage 4)", () => {
  test("task_out snapshots running output tail and settled results", async () => {
    const h = makeHarness({ hold: true });
    await runTool(h, { agent: "echoer", task: "snap", background: true });
    const running = await runNamed({ harness: h, name: "task_out", params: {} });
    expect(running.text).toContain('"status": "running"');
    expect(running.text).toContain("snap");
  });

  test("task_out unknown id is an error", async () => {
    const h = makeHarness();
    const r = await runNamed({
      harness: h,
      name: "task_out",
      params: { subagentId: "sub_ghost00" },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Unknown subagentId");
  });

  test("task_wait aggregates results and suppresses their notifications", async () => {
    const h = makeHarness({ hold: true });
    await runTool(h, { agent: "echoer", task: "wait-a", background: true });
    await runTool(h, { agent: "echoer", task: "wait-b", background: true });
    const waiting = runNamed({ harness: h, name: "task_wait", params: {} });
    h.settleHeld(); // settle while the wait holds the suppression
    const r = await waiting;
    expect(r.text).toContain("done:wait-a");
    expect(r.text).toContain("done:wait-b");
    expect(h.registry.pendingCount()).toBe(0); // suppressed, not queued
  });

  test("task_wait empty set returns immediately", async () => {
    const h = makeHarness();
    const r = await runNamed({ harness: h, name: "task_wait", params: {} });
    expect(r.text).toContain("nothing in flight");
  });

  test("task_wait all-unknown ids is an error; mixed annotates unknown", async () => {
    const h = makeHarness();
    const allUnknown = await runNamed({
      harness: h,
      name: "task_wait",
      params: { subagentIds: ["sub_nope11"] },
    });
    expect(allUnknown.isError).toBe(true);
    await runTool(h, { agent: "echoer", task: "mix", background: true });
    const ids = (h.registry.snapshot() as Array<{ subagentId: string }>).map((e) => e.subagentId);
    const mixed = await runNamed({
      harness: h,
      name: "task_wait",
      params: { subagentIds: ["sub_nope11", ...ids] },
    });
    expect(mixed.isError).toBeUndefined();
    expect(mixed.text).toContain("unknown");
    expect(mixed.text).toContain("done:mix");
  });

  test("task_wait timeout returns an error and targets keep running", async () => {
    const h = makeHarness({ hold: true });
    await runTool(h, { agent: "echoer", task: "slow", background: true });
    const r = await runNamed({ harness: h, name: "task_wait", params: { timeoutMs: 50 } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("timed out");
    expect(h.registry.inFlight()).toBe(1); // still running
  });

  test("task_stop stops a running task idempotently; unknown is an error", async () => {
    const h = makeHarness({ hold: true });
    await runTool(h, { agent: "echoer", task: "stoppable", background: true });
    const [entry] = h.registry.snapshot() as Array<{ subagentId: string }>;
    if (entry === undefined) throw new Error("no snapshot entry");
    const id = entry.subagentId;
    const first = await runNamed({ harness: h, name: "task_stop", params: { subagentId: id } });
    expect(first.text).toContain("running");
    const unknown = await runNamed({
      harness: h,
      name: "task_stop",
      params: { subagentId: "sub_nope22" },
    });
    expect(unknown.isError).toBe(true);
    // Idempotence: after settle, the second stop returns the terminal state.
    h.settleHeld();
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    const second = await runNamed({ harness: h, name: "task_stop", params: { subagentId: id } });
    expect(second.isError).toBeUndefined();
    expect(second.text).toMatch(/sub_.*: (completed|stopped)/); // terminal state
  });
});

function liveId(h: ToolHarness, index = 0): string {
  const entry = (h.registry.snapshot() as Array<{ subagentId: string; status: string }>)[index];
  if (entry === undefined) throw new Error(`no launch ${index}`);
  return entry.subagentId;
}

describe("steer and sibling routing (stages 7/9)", () => {
  test("task_steer targets a running task through the registry pipeline", async () => {
    const h = makeHarness({ hold: true });
    await runTool(h, { agent: "echoer", task: "steer-me", background: true });
    const id = liveId(h);
    const ok = await runNamed({
      harness: h,
      name: "task_steer",
      params: { subagentId: id, message: "focus on tests" },
    });
    expect(ok.isError).toBeUndefined();
    expect(ok.text).toContain(`steered ${id}`);
    expect(h.steers).toEqual([{ id, message: "focus on tests" }]);
    const unknown = await runNamed({
      harness: h,
      name: "task_steer",
      params: { subagentId: "sub_gone33", message: "x" },
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("unknown subagent");
  });

  test("task_send routes running-only with the lead envelope", async () => {
    const h = makeHarness({ hold: true });
    await runTool(h, { agent: "echoer", task: "target", background: true });
    await runTool(h, { agent: "echoer", task: "other", background: true });
    const ok = await runNamed({
      harness: h,
      name: "task_send",
      params: { to: liveId(h, 1), message: "hand over the file list" },
    });
    expect(ok.isError).toBeUndefined();
    expect(ok.text).toContain(`sent to ${liveId(h, 1)}`);
    expect(h.steers).toEqual([
      { id: liveId(h, 1), message: "[from: lead via task_send] hand over the file list" },
    ]);
    h.settleHeld();
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    }); // let the settles propagate to the registry entries
    const settled = await runNamed({
      harness: h,
      name: "task_send",
      params: { to: liveId(h, 0), message: "hi" },
    });
    expect(settled.isError).toBe(true);
    expect(settled.text).toContain("not running");
  });
});

describe("task tool parameter validation (plan §6)", () => {
  test("exactly one mode required", async () => {
    const h = makeHarness();
    expect((await runTool(h, { agent: "echoer" })).text).toContain(
      "single mode needs both agent and task",
    );
    expect((await runTool(h, { task: "x" })).text).toContain(
      "single mode needs both agent and task",
    );
    const both = await runTool(h, {
      agent: "echoer",
      task: "x",
      tasks: [{ agent: "echoer", task: "y" }],
    });
    expect(both.text).toContain("exactly one mode");
  });

  test("unknown agent lists available agents, no spawn", async () => {
    const h = makeHarness();
    const r = await runTool(h, { agent: "ghost", task: "x" });
    expect(r.text).toContain('Unknown agent: "ghost"');
    expect(r.text).toContain('"echoer"');
    expect(h.launches.length).toBe(0);
    expect(h.registry.inFlight()).toBe(0);
  });

  test("cwd must stay inside the conversation directory", async () => {
    const h = makeHarness();
    expect((await runTool(h, { agent: "echoer", task: "x", cwd: ".." })).text).toContain(
      "outside the conversation directory",
    );
    expect((await runTool(h, { agent: "echoer", task: "x", cwd: "/etc" })).text).toContain(
      "outside the conversation directory",
    );
    expect(h.launches.length).toBe(0);
  });

  test("per-call task cap enforced for tasks and chain", async () => {
    const h = makeHarness();
    const many = Array.from({ length: MAX_TASKS_PER_CALL + 1 }, (_, i) => ({
      agent: "echoer",
      task: `t${i}`,
    }));
    expect((await runTool(h, { tasks: many })).text).toContain(
      `Max is ${MAX_TASKS_PER_CALL} per call`,
    );
    expect((await runTool(h, { chain: many })).text).toContain(
      `Max is ${MAX_TASKS_PER_CALL} per call`,
    );
    expect(h.launches.length).toBe(0);
  });

  test("conversation-level in-flight budget rejected before spawning", async () => {
    const h = makeHarness({ hold: true });
    // Fill the registry with never-settling tasks (queued+running all count).
    for (let i = 0; i < MAX_INFLIGHT_PER_CONVERSATION; i++) {
      h.registry.launch({
        spec: { ...specTemplate(), subagentId: `sub_fill${i}${i}` },
        hooks: { onEvent: () => {}, onUiRequest: () => {}, writeStderr: () => {} },
      });
    }
    const r = await runTool(h, { agent: "echoer", task: "x" });
    expect(r.text).toContain("Too many subagents in flight");
    expect(h.launches.length).toBe(MAX_CONCURRENT_SUBAGENTS); // gate spawned only 4
    expect(h.registry.inFlight()).toBe(MAX_INFLIGHT_PER_CONVERSATION); // untouched
  });
});

describe("task tool execution semantics", () => {
  test("single success returns output and releases the budget", async () => {
    const h = makeHarness();
    const r = await runTool(h, { agent: "echoer", task: "echo hi" });
    expect(r.text).toContain("done:echo hi");
    expect(r.isError).toBeUndefined();
    expect(h.registry.inFlight()).toBe(0); // released on settle
    expect(h.launches.length).toBe(1);
    expect(h.launches[0]?.cwd).toBe(tmpdir());
    expect(h.launches[0]?.permissionThreadId).toBe("tid-1");
    expect(r.details?.results[0]?.agent).toBe("echoer");
  });

  test("budget release also happens on validation failures mid-batch", async () => {
    const h = makeHarness();
    await runTool(h, {
      tasks: [
        { agent: "echoer", task: "a" },
        { agent: "ghost", task: "b" },
      ],
    });
    expect(h.registry.inFlight()).toBe(0);
    expect(h.launches.length).toBe(0); // nothing spawned for the failed batch
  });

  test("parallel respects the concurrency gate and reports counts", async () => {
    const h = makeHarness();
    const tasks = Array.from({ length: 6 }, (_, i) => ({ agent: "echoer", task: `p${i}` }));
    const r = await runTool(h, { tasks });
    expect(r.text).toContain("6/6 succeeded");
    expect(h.launches.length).toBe(6);
    expect(h.maxConcurrent()).toBeLessThanOrEqual(MAX_CONCURRENT_SUBAGENTS);
    expect(h.registry.inFlight()).toBe(0);
  });

  test("chain substitutes {previous} and runs sequentially", async () => {
    const h = makeHarness();
    const r = await runTool(h, {
      chain: [
        { agent: "echoer", task: "step one {previous}" },
        { agent: "echoer", task: "step two {previous}" },
      ],
    });
    expect(r.text).toContain("done:step two done:step one ");
    expect(h.launches.length).toBe(2);
    expect(h.maxConcurrent()).toBe(1);
  });

  test("background:true returns a receipt immediately and registers the task", async () => {
    const h = makeHarness({ hold: true });
    const r = await runTool(h, { agent: "echoer", task: "long job", background: true });
    expect(r.text).toContain("Started 1 background task");
    expect(r.text).toMatch(/echoer -> sub_[0-9a-f]{8} \(started\)/);
    expect(r.text).toContain("task-notification");
    expect(r.details?.results[0]).toMatchObject({ agent: "echoer", status: "started" });
    expect(h.registry.inFlight()).toBe(1);
    expect(h.registry.liveCount()).toBe(1);
  });

  test("background receipt marks queued when the global gate is full", async () => {
    const h = makeHarness({ hold: true });
    for (let i = 0; i < MAX_CONCURRENT_SUBAGENTS; i++) {
      h.registry.launch({
        spec: { ...specTemplate(), subagentId: `sub_bgfill${i}${i}` },
        hooks: { onEvent: () => {}, onUiRequest: () => {}, writeStderr: () => {} },
      });
    }
    const r = await runTool(h, { agent: "echoer", task: "overflow", background: true });
    expect(r.text).toMatch(/\(queued\)/);
    expect(h.registry.inFlight()).toBe(MAX_CONCURRENT_SUBAGENTS + 1);
    expect(h.registry.liveCount()).toBe(MAX_CONCURRENT_SUBAGENTS);
  });

  test("chain + background is rejected", async () => {
    const h = makeHarness();
    const r = await runTool(h, {
      background: true,
      chain: [{ agent: "echoer", task: "a" }],
    });
    expect(r.text).toContain("chain mode cannot run in background");
    expect(h.launches.length).toBe(0);
  });

  test("model fallback note is appended to the result text (U6)", async () => {
    const h = makeHarness();
    const fallbackModel = { provider: "p", id: "m" };
    const r = await runTool(h, { agent: "modelagent", task: "x" }, fallbackModel);
    expect(h.launches[0]?.model).toBe(fallbackModel); // inherited the conversation model
    expect(r.text).toContain("model not found; ran with the conversation model");
    expect(h.registry.inFlight()).toBe(0);
  });
});
