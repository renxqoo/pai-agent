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
  registry: SubagentRegistry;
  launches: GrandchildTaskSpec[];
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
    permissionRules: { mode: "ask" },
  };
}

function makeHarness(options?: { hold?: boolean }): ToolHarness {
  const launches: GrandchildTaskSpec[] = [];
  let inFlightNow = 0;
  let maxSeen = 0;
  const okResult = makeOkResult();
  const startTask = (deps: { spec: GrandchildTaskSpec }): GrandchildDriver => {
    launches.push(deps.spec);
    inFlightNow += 1;
    maxSeen = Math.max(maxSeen, inFlightNow);
    const result =
      options?.hold === true
        ? new Promise<GrandchildResult>(() => {}) // never settles (budget test)
        : Promise.resolve(okResult(deps.spec)).finally(() => {
            inFlightNow -= 1;
          });
    return { result, resolveUi: () => false };
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
  let registered: RegisteredTool | undefined;
  const pi = {
    registerTool: (def: RegisteredTool) => {
      registered = def;
    },
  } as unknown as ExtensionAPI;
  createTaskTool(deps, false)(pi);
  if (registered === undefined) throw new Error("task tool was not registered");
  return { tool: registered, registry, launches, maxConcurrent: () => maxSeen };
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
    expect(h.launches[0]?.permissionRules).toBeDefined();
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

  test("model fallback note is appended to the result text (U6)", async () => {
    const h = makeHarness();
    const fallbackModel = { provider: "p", id: "m" };
    const r = await runTool(h, { agent: "modelagent", task: "x" }, fallbackModel);
    expect(h.launches[0]?.model).toBe(fallbackModel); // inherited the conversation model
    expect(r.text).toContain("model not found; ran with the conversation model");
    expect(h.registry.inFlight()).toBe(0);
  });
});
