/**
 * The `task` tool (plan ui-completeness §3.1): delegates work to agent
 * definitions by spawning grandchild pai workers (subagent-process driver).
 * Modes: single {agent, task} / parallel {tasks[]} / chain {chain[]} with a
 * {previous} placeholder. Budgets (violating any is a defect): ≤8 tasks per
 * call, ≤4 concurrent grandchild processes, ≤8 in flight per conversation —
 * the batch is reserved synchronously before the first await and each task
 * releases from its grandchild close. Task cwd must resolve inside the
 * conversation cwd (plan §3.6).
 */

import { join as joinPath, resolve as resolvePath } from "node:path";
import type { ExtensionAPI, InlineExtension, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents } from "./agent-definitions.ts";
import type { HubFrame, SessionModel } from "./protocol.ts";
import { toWireEvent } from "./session-host.ts";
import {
  type GrandchildHooks,
  type GrandchildResult,
  type GrandchildTaskSpec,
  type GrandchildUsage,
  newSubagentId,
} from "./subagent-process.ts";
import {
  ENVELOPE_TASK_CAP,
  MAX_CONCURRENT_SUBAGENTS,
  MAX_INFLIGHT_PER_CONVERSATION,
  MAX_TASKS_PER_CALL,
  type SubagentRegistry,
} from "./subagent-registry.ts";
import { registerQueryTools } from "./subagent-query-tools.ts";
import { truncateBytes } from "./truncate.ts";

export interface TaskToolDeps {
  emit: (frame: HubFrame) => void;
  modelRuntime: ModelRuntime;
  registry: SubagentRegistry;
  writeStderr: (text: string) => void;
  getThreadId: () => string;
}

interface TaskItemInput {
  agent: string;
  task: string;
  cwd?: string;
}

interface TaskParamsInput {
  background?: boolean;
  agent?: string;
  task?: string;
  tasks?: TaskItemInput[];
  chain?: TaskItemInput[];
  cwd?: string;
}

interface PreparedBatch {
  mode: "single" | "parallel" | "chain";
  items: TaskItemInput[];
  defaultCwd?: string;
  background: boolean;
}

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory (must stay inside the conversation cwd)" }),
  ),
});

const TaskParams = Type.Object({
  background: Type.Optional(
    Type.Boolean({
      description:
        "Run in background: returns a receipt immediately and the turn continues; a notification message wakes you when each task finishes (opt-in; default false blocks until done). Background tasks cannot be recovered after a stop.",
    }),
  ),
  agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task text (single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel {agent, task} items" })),
  chain: Type.Optional(
    Type.Array(TaskItem, {
      description: "Sequential steps; {previous} substitutes the prior output",
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory for single mode" })),
});

export function createTaskTool(deps: TaskToolDeps, trusted: boolean): InlineExtension {
  return (pi: ExtensionAPI): void => {
    registerQueryTools(pi, deps);
    pi.registerTool({
      name: "task",
      label: "Task",
      description: [
        "Delegate work to specialized subagents (isolated context windows, fresh processes).",
        "Modes: single {agent, task}, parallel {tasks: [{agent, task}]}, chain {chain: [{agent, task}]} with a {previous} placeholder.",
        trusted
          ? "Agents come from the user-level agent directory and the project .pi/agents directory (project overrides user)."
          : "Agents come from the user-level agent directory (project-local agents require a trusted thread).",
      ].join(" "),
      parameters: TaskParams,
      executionMode: "parallel",
      // eslint-disable-next-line max-params -- SDK-imposed tool signature
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        return runTaskTool({
          deps,
          trusted,
          params: params as TaskParamsInput,
          signal,
          onUpdate:
            onUpdate === undefined
              ? undefined
              : (text: string): void => {
                  onUpdate({ content: [{ type: "text", text }], details: undefined });
                },
          ctx: { cwd: ctx.cwd, model: ctx.model, thinkingLevel: ctx.thinkingLevel },
        });
      },
    });
  };
}

async function runTaskTool(deps: {
  deps: TaskToolDeps;
  trusted: boolean;
  params: TaskParamsInput;
  signal: AbortSignal | undefined;
  onUpdate: ((text: string) => void) | undefined;
  ctx: { cwd: string; model: SessionModel | undefined; thinkingLevel: string | undefined };
}): Promise<ToolResult> {
  const { deps: tool, trusted } = deps;
  const batch = prepareBatch(deps.params);
  if (typeof batch === "string") return textResult(batch, true);
  if (batch.background && batch.mode === "chain") {
    return textResult(
      "Invalid parameters: chain mode cannot run in background (each step needs the previous output); split it into sequential single calls.",
      true,
    );
  }

  // Sync reservation before the first await (plan stage 1): the in-flight
  // budget is checked against the registry (queued+running, single truth).
  const inFlight = tool.registry.inFlight();
  if (inFlight + batch.items.length > MAX_INFLIGHT_PER_CONVERSATION) {
    return textResult(
      `Too many subagents in flight (${inFlight} + ${batch.items.length} > ${MAX_INFLIGHT_PER_CONVERSATION}); wait for running tasks to finish`,
      true,
    );
  }
  try {
    const specsResult = await buildSpecs({ tool, trusted, batch, ctx: deps.ctx });
    if (specsResult instanceof Error) return textResult(specsResult.message, true);
    const { specs, notes } = specsResult;
    if (batch.background) return launchBackground({ tool, specs, batch, signal: deps.signal });
    const runOne = (spec: GrandchildTaskSpec): Promise<GrandchildResult> =>
      runGrandchild({ tool, spec, background: batch.background, signal: deps.signal });
    // await inside the try (batch-B lesson); budget release lives on the
    // registry settle hook, not a tool-level finally.
    const outcome =
      batch.mode === "chain"
        ? await runChain({ specs, items: batch.items, runOne, onUpdate: deps.onUpdate })
        : await runParallel({ specs, runOne, onUpdate: deps.onUpdate });
    if (notes.length > 0) appendNotes(outcome, notes);
    return outcome;
  } catch (error) {
    // Defensive: the registry/driver never reject, but a hook could throw.
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
}

/** Launch a background batch: receipts now, results later as notification
 * messages (plan stage 2). Nothing is awaited — the turn continues. */
function launchBackground(deps: {
  tool: TaskToolDeps;
  specs: GrandchildTaskSpec[];
  batch: PreparedBatch;
  signal: AbortSignal | undefined;
}): ToolResult {
  const { tool, specs, batch, signal } = deps;
  const lines: string[] = [];
  const results: Array<{ subagentId: string; agent: string; task: string; status: string }> = [];
  let rejected = 0;
  for (const spec of specs) {
    const handle = tool.registry.launch({
      spec,
      background: true,
      ...(signal !== undefined ? { outerSignal: signal } : {}),
      hooks: hooksFor(tool, spec),
    });
    if (handle.status === "rejected") rejected += 1;
    results.push({
      subagentId: spec.subagentId,
      agent: spec.agent,
      task: spec.task,
      status: handle.status,
    });
    lines.push(`${spec.agent} -> ${spec.subagentId} (${handle.status})`);
  }
  return {
    content: [
      {
        type: "text",
        text: [
          `Started ${specs.length - rejected} background task${specs.length - rejected === 1 ? "" : "s"}:`,
          ...lines,
          "You will receive a [task-notification] message as each finishes. Do not invent results before that notification; check live status with task_out, wait with task_wait, stop one with task_stop.",
        ].join("\n"),
      },
    ],
    ...(rejected > 0 ? { isError: true } : {}),
    details: { mode: batch.mode, results },
  };
}

/** Append model-fallback notes to the result text (U6: visible to the model). */
function appendNotes(outcome: ToolResult, notes: string[]): void {
  const suffix = notes.map((note) => `[${note}]`).join(" ");
  const [first] = outcome.content;
  if (first !== undefined && first.type === "text") first.text = `${first.text}\n\n${suffix}`;
}

/** Validate every item and resolve agent/model/cwd into grandchild specs. */
async function buildSpecs(deps: {
  tool: TaskToolDeps;
  trusted: boolean;
  batch: PreparedBatch;
  ctx: { cwd: string; model: SessionModel | undefined; thinkingLevel: string | undefined };
}): Promise<{ specs: GrandchildTaskSpec[]; notes: string[] } | Error> {
  const { tool, trusted, batch, ctx } = deps;
  const agents = discoverAgents({ cwd: ctx.cwd, trusted });
  const specs: GrandchildTaskSpec[] = [];
  const notes: string[] = [];
  for (const item of batch.items) {
    const def = agents.find((agent) => agent.name === item.agent);
    if (def === undefined) {
      const available = agents.map((agent) => `"${agent.name}"`).join(", ") || "none";
      return new Error(`Unknown agent: "${item.agent}". Available agents: ${available}.`);
    }
    const cwd = resolveWithin(item.cwd ?? batch.defaultCwd, ctx.cwd);
    if (cwd === null) {
      return new Error(
        `Invalid cwd: ${item.cwd ?? batch.defaultCwd} is outside the conversation directory ${ctx.cwd}`,
      );
    }
    const model = await resolveTaskModel({
      modelRuntime: tool.modelRuntime,
      wanted: def.model,
      fallback: ctx.model,
    });
    if (model.note !== undefined) notes.push(model.note);
    specs.push({
      subagentId: newSubagentId(),
      agent: def.name,
      task: item.task,
      cwd,
      systemPrompt: def.systemPrompt,
      ...(def.tools !== undefined ? { tools: def.tools } : {}),
      ...(model.inherit && def.model === undefined && ctx.thinkingLevel !== undefined
        ? { thinkingLevel: ctx.thinkingLevel }
        : {}),
      ...(model.model !== undefined ? { model: model.model } : {}),
      ...(def.source === "project" ? { projectSourced: true } : {}),
      permissionThreadId: tool.getThreadId(),
      parentProtectedPaths: [joinPath(ctx.cwd, ".pi", "sandbox.json")],
    });
  }
  return { specs, notes };
}

/** Relay hooks shared by the foreground and background launch paths. */
function hooksFor(tool: TaskToolDeps, spec: GrandchildTaskSpec): GrandchildHooks {
  return {
    onEvent: (event) => {
      tool.emit({
        type: "subagent_event",
        threadId: tool.getThreadId(),
        subagentId: spec.subagentId,
        agent: spec.agent,
        task:
          Buffer.byteLength(spec.task, "utf8") <= ENVELOPE_TASK_CAP
            ? spec.task
            : truncateBytes(spec.task, ENVELOPE_TASK_CAP, "..."),
        event: toWireEvent(event),
      });
    },
    onUiRequest: (frame) => {
      const { type: _type, threadId: _threadId, ...rest } = frame;
      tool.emit({
        type: "ui_request",
        requestId: String(frame["requestId"] ?? ""),
        threadId: tool.getThreadId(),
        ...rest,
        subagentId: spec.subagentId,
        agent: spec.agent,
      });
    },
    // Stage 8/9: re-stamp identity from the spec (the grandchild's own frame
    // fields are advisory), forward for client observability, and queue the
    // enveloped message for turn-boundary delivery to the father model.
    onMessage: (message) => {
      tool.emit({
        type: "subagent_message",
        threadId: tool.getThreadId(),
        subagentId: spec.subagentId,
        agent: spec.agent,
        text: message.text,
        ...(message.to !== undefined ? { to: message.to } : {}),
      });
      tool.registry.queueMessage(spec.subagentId, message);
    },
    writeStderr: tool.writeStderr,
  };
}

/** Launch one grandchild through the registry (global gate + queueing) and
 * await its result. The turn signal is chained onto the entry's controller
 * by the registry; killAll/task_stop reach it the same way. */
async function runGrandchild(deps: {
  tool: TaskToolDeps;
  spec: GrandchildTaskSpec;
  background: boolean;
  signal: AbortSignal | undefined;
}): Promise<GrandchildResult> {
  const { tool, spec } = deps;
  const handle = tool.registry.launch({
    spec,
    background: deps.background,
    ...(deps.signal !== undefined ? { outerSignal: deps.signal } : {}),
    hooks: hooksFor(tool, spec),
  });
  return handle.result;
}

// --- dispatch preparation --------------------------------------------------------

function prepareBatch(params: TaskParamsInput): PreparedBatch | string {
  const hasSingle = params.agent !== undefined || params.task !== undefined;
  const hasTasks = params.tasks !== undefined && params.tasks.length > 0;
  const hasChain = params.chain !== undefined && params.chain.length > 0;
  const modeCount = Number(hasSingle) + Number(hasTasks) + Number(hasChain);
  if (modeCount !== 1) {
    return "Invalid parameters: provide exactly one mode (agent+task, tasks[], or chain[])";
  }
  if (hasSingle) {
    if (params.agent === undefined || params.task === undefined) {
      return "Invalid parameters: single mode needs both agent and task";
    }
    return {
      mode: "single",
      items: [{ agent: params.agent, task: params.task }],
      defaultCwd: params.cwd,
      background: params.background === true,
    };
  }
  const items = hasTasks ? params.tasks : params.chain;
  if (items === undefined || items.length === 0) return "Invalid parameters: empty task list";
  if (items.length > MAX_TASKS_PER_CALL) {
    return `Too many tasks (${items.length}). Max is ${MAX_TASKS_PER_CALL} per call.`;
  }
  return {
    mode: hasTasks ? "parallel" : "chain",
    items,
    background: params.background === true,
  };
}

/** Task cwd must resolve inside the conversation cwd (plan §3.6). */
function resolveWithin(requested: string | undefined, conversationCwd: string): string | null {
  if (requested === undefined) return resolvePath(conversationCwd);
  const base = resolvePath(conversationCwd);
  const target = resolvePath(conversationCwd, requested);
  if (target === base || target.startsWith(`${base}/`)) return target;
  return null;
}

// --- model resolution (plan §3.1 U6) ----------------------------------------------

export async function resolveTaskModel(deps: {
  modelRuntime: ModelRuntime;
  wanted: string | undefined;
  fallback: SessionModel | undefined;
}): Promise<{ model?: SessionModel; inherit: boolean; note?: string }> {
  const { modelRuntime, wanted, fallback } = deps;
  if (wanted === undefined) {
    // No frontmatter model: inherit the conversation model and thinking level.
    return { ...(fallback !== undefined ? { model: fallback } : {}), inherit: true };
  }
  const find = (): SessionModel | undefined => {
    const snapshot = modelRuntime.getAvailableSnapshot();
    const slash = wanted.indexOf("/");
    return snapshot.find((model) =>
      slash > 0 ? `${model.provider}/${model.id}` === wanted : model.id === wanted,
    );
  };
  let model = find();
  if (model === undefined) {
    // Disk-only refresh: no network, no provider rebuild (review finding A6/B8).
    await modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
    model = find();
  }
  if (model === undefined && fallback !== undefined) {
    return {
      model: fallback,
      inherit: true,
      note: `${wanted}: model not found; ran with the conversation model`,
    };
  }
  return { ...(model !== undefined ? { model } : {}), inherit: model === undefined };
}

// --- execution -------------------------------------------------------------------

/** Full per-task record task_wait returns (review A-P3-8 parity with
 * runParallel's stats). */
export interface WaitingResult {
  output: string;
  isError: boolean;
  aborted: boolean;
  truncated: boolean;
  eventsRelayed: number;
  usage: GrandchildUsage;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  /** Per-agent outcomes (plan §3.3): usage and relay stats for the UI;
   * background receipts carry {subagentId, status} instead of outputs. */
  details: {
    mode: "single" | "parallel" | "chain";
    results: Array<
      | {
          agent: string;
          task: string;
          output: string;
          isError: boolean;
          aborted: boolean;
          truncated: boolean;
          eventsRelayed: number;
          usage: GrandchildUsage;
        }
      | { subagentId: string; agent: string; task: string; status: string }
      | (WaitingResult & {
          subagentId: string;
          agent: string;
          task: string;
          status: "completed" | "failed" | "stopped" | "unknown";
        })
    >;
  };
}

function detailsOf(
  mode: "single" | "parallel" | "chain",
  results: GrandchildResult[],
): ToolResult["details"] {
  return {
    mode,
    results: results.map((result) => ({
      agent: result.agent,
      task: result.task,
      output: result.output,
      isError: result.isError,
      aborted: result.aborted,
      truncated: result.truncated,
      eventsRelayed: result.eventsRelayed,
      usage: result.usage,
    })),
  };
}

function textResult(text: string, isError: boolean): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError } : {}),
    details: { mode: "single", results: [] },
  };
}

async function runParallel(deps: {
  specs: GrandchildTaskSpec[];
  runOne: (spec: GrandchildTaskSpec) => Promise<GrandchildResult>;
  onUpdate: ((text: string) => void) | undefined;
}): Promise<ToolResult> {
  const { specs, runOne, onUpdate } = deps;
  const byIndex = new Map<number, GrandchildResult>();
  let done = 0;
  let next = 0;
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_SUBAGENTS, specs.length) },
    async () => {
      for (;;) {
        const index = next++;
        const spec = specs[index];
        if (spec === undefined) return;
        byIndex.set(index, await runOne(spec));
        done += 1;
        onUpdate?.(`parallel: ${done}/${specs.length} done`);
      }
    },
  );
  await Promise.all(workers);
  const results = specs.map((_, index) => byIndex.get(index)).filter(hasResult);
  const succeeded = results.filter((result) => !result.isError).length;
  const summaries = results.map((result) => {
    const status = result.isError ? `failed${result.aborted ? " (aborted)" : ""}` : "completed";
    return `### [${result.agent}] ${status}\n\n${result.output || "(no output)"}`;
  });
  if (specs.length === 1) {
    return {
      content: [{ type: "text", text: summaries[0] ?? "" }],
      ...(results[0]?.isError ? { isError: true } : {}),
      details: detailsOf("single", results),
    };
  }
  const text = `parallel: ${succeeded}/${specs.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`;
  return { content: [{ type: "text", text }], details: detailsOf("parallel", results) };
}

function hasResult(result: GrandchildResult | undefined): result is GrandchildResult {
  return result !== undefined;
}

async function runChain(deps: {
  specs: GrandchildTaskSpec[];
  items: TaskItemInput[];
  runOne: (spec: GrandchildTaskSpec) => Promise<GrandchildResult>;
  onUpdate: ((text: string) => void) | undefined;
}): Promise<ToolResult> {
  const { specs, items, runOne, onUpdate } = deps;
  const results: GrandchildResult[] = [];
  let previous = "";
  for (let i = 0; i < specs.length; i++) {
    const baseSpec = specs[i];
    const item = items[i];
    if (baseSpec === undefined || item === undefined) break;
    const spec = { ...baseSpec, task: item.task.replace(/\{previous\}/g, previous) };
    onUpdate?.(`chain: step ${i + 1}/${specs.length} (${spec.agent})`);
    const result = await runOne(spec);
    results.push(result);
    if (result.isError) {
      const text = `chain stopped at step ${i + 1} (${spec.agent}): ${result.output}`;
      return {
        content: [{ type: "text", text }],
        isError: true,
        details: detailsOf("chain", results),
      };
    }
    previous = result.output;
  }
  const last = results.at(-1);
  return {
    content: [{ type: "text", text: last?.output || "(no output)" }],
    details: detailsOf("chain", results),
  };
}
