/**
 * Query face for background subagents (plan background-subagents stage 4):
 * task_out (snapshot), task_wait (barrier with notification suppression,
 * timeout, abort), task_stop (single stop). Pure observers except stop;
 * task_out never blocks and never kills.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GrandchildResult } from "./subagent-process.ts";
import type { SubagentRegistry } from "./subagent-registry.ts";
import type { TaskToolDeps, ToolResult } from "./subagent-tool.ts";

// --- query face: task_out / task_wait / task_stop (plan stage 4) ------------------

const OutParams = Type.Object({
  subagentId: Type.Optional(
    Type.String({ description: "Snapshot one task; omit for all known tasks" }),
  ),
});

const WaitParams = Type.Object({
  subagentIds: Type.Optional(
    Type.Array(Type.String(), { description: "Wait for these ids; omit for all in-flight" }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({ description: "Give up after this many ms (targets keep running); omit to wait" }),
  ),
});

const StopParams = Type.Object({
  subagentId: Type.String({ description: "The subagent to stop (running or queued)" }),
});

export function registerQueryTools(pi: ExtensionAPI, tool: TaskToolDeps): void {
  registerOut(pi, tool);
  registerWait(pi, tool);
  registerStop(pi, tool);
}

function registerOut(pi: ExtensionAPI, tool: TaskToolDeps): void {
  pi.registerTool({
    name: "task_out",
    label: "Task status",
    description:
      "Snapshot subagent task status (queued/running/completed/failed/stopped) with output excerpt and usage. Never blocks, never kills. NEVER invent a background task's result: read it here or wait for its [task-notification].",
    parameters: OutParams,
    async execute(_toolCallId, params) {
      const wanted = (params as { subagentId?: string }).subagentId;
      const snapshot = tool.registry.snapshot(wanted);
      if (snapshot === undefined) {
        return {
          content: [{ type: "text", text: `Unknown subagentId: ${String(wanted)}` }],
          isError: true,
          details: { mode: "single", results: [] },
        };
      }
      const entries = Array.isArray(snapshot) ? snapshot : [snapshot];
      return {
        content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
        details: { mode: "single", results: [] },
      };
    },
  });
}

function registerWait(pi: ExtensionAPI, tool: TaskToolDeps): void {
  pi.registerTool({
    name: "task_wait",
    label: "Wait for tasks",
    description:
      "Block this turn until the target subagents settle, then return their aggregated results. Omit ids to wait for all in-flight. Their completion notifications are suppressed (results arrive here once). timeoutMs returns early with an error; the targets keep running.",
    parameters: WaitParams,
    // eslint-disable-next-line max-params -- SDK-imposed tool signature
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      return waitForTasks({
        registry: tool.registry,
        params: params as { subagentIds?: string[]; timeoutMs?: number },
        signal,
      });
    },
  });
}

function registerStop(pi: ExtensionAPI, tool: TaskToolDeps): void {
  pi.registerTool({
    name: "task_stop",
    label: "Stop task",
    description:
      "Stop one subagent (running: SIGTERM chain; queued: dequeued without spawning). Idempotent; the stopped task keeps its retained result for task_out. Stopped tasks cannot be recovered.",
    parameters: StopParams,
    async execute(_toolCallId, params) {
      const id = (params as { subagentId: string }).subagentId;
      const status = tool.registry.stopOne(id);
      if (status === undefined) {
        return {
          content: [{ type: "text", text: `Unknown subagentId: ${id}` }],
          isError: true,
          details: { mode: "single", results: [] },
        };
      }
      return {
        content: [{ type: "text", text: `subagent ${id}: ${status}` }],
        details: { mode: "single", results: [] },
      };
    },
  });
}

/** task_wait barrier (plan stage 4): await settle promises, aggregate like
 * the parallel summary; suppress those ids' notifications while waiting;
 * unknown ids annotate the result (all-unknown -> isError); abort returns
 * an error (U2 kills the targets via the abort command); timeout returns
 * an error WITHOUT killing. */
async function waitForTasks(deps: {
  registry: SubagentRegistry;
  params: { subagentIds?: string[]; timeoutMs?: number };
  signal: AbortSignal | undefined;
}): Promise<ToolResult> {
  const { registry, params, signal } = deps;
  const ids = params.subagentIds ?? allInFlightIds(registry);
  if (ids.length === 0) {
    return {
      content: [{ type: "text", text: "wait: nothing in flight" }],
      details: { mode: "parallel", results: [] },
    };
  }
  const unknown: string[] = [];
  const pairs: Array<{ id: string; settled: Promise<{ id: string; result: GrandchildResult }> }> =
    [];
  for (const id of ids) {
    const settled = registry.awaitOf(id);
    if (settled === undefined) unknown.push(id);
    else {
      const pair = settled.then((result): { id: string; result: GrandchildResult } => ({
        id,
        result,
      }));
      pairs.push({ id, settled: pair });
    }
  }
  if (pairs.length === 0) {
    return {
      content: [{ type: "text", text: `Unknown subagentIds: ${unknown.join(", ")}` }],
      isError: true,
      details: { mode: "parallel", results: [] },
    };
  }
  registry.suppressNotifications(pairs.map((pair) => pair.id));
  try {
    const outcome = await raceSettles(pairs, params.timeoutMs, signal);
    if (outcome === "aborted") return abortedWait("wait aborted");
    if (outcome === "timed-out") {
      return abortedWait(
        `wait timed out after ${String(params.timeoutMs)}ms; targets keep running (task_wait again or task_out)`,
      );
    }
    return aggregateWait(outcome, unknown);
  } finally {
    registry.releaseNotifications(pairs.map((pair) => pair.id));
  }
}

function abortedWait(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    details: { mode: "parallel", results: [] },
  };
}

function aggregateWait(
  pairs: Array<{ id: string; result: GrandchildResult }>,
  unknown: string[],
): ToolResult {
  const lines: string[] = [];
  const entries: Array<{ subagentId: string; agent: string; task: string; status: string }> = [];
  for (const pair of pairs) {
    let statusWord = "completed";
    if (pair.result.aborted) statusWord = "stopped";
    else if (pair.result.isError) statusWord = "failed";
    lines.push(
      `### [${pair.result.agent}] ${statusWord}\n\n${pair.result.output || "(no output)"}`,
    );
    entries.push({
      subagentId: pair.id,
      agent: pair.result.agent,
      task: pair.result.task,
      status: statusWord,
    });
  }
  for (const id of unknown) {
    lines.push(`### [unknown] ${id}\n\n(id not found; possibly evicted)`);
    entries.push({ subagentId: id, agent: "?", task: "?", status: "unknown" });
  }
  return {
    content: [{ type: "text", text: lines.join("\n\n---\n\n") }],
    details: { mode: "parallel", results: entries },
  };
}

function allInFlightIds(registry: SubagentRegistry): string[] {
  const all = registry.snapshot();
  if (!Array.isArray(all)) return [];
  return all
    .filter((entry) => entry.status === "queued" || entry.status === "running")
    .map((entry) => entry.subagentId);
}

interface SettledPair {
  id: string;
  result: GrandchildResult;
}

function raceSettles(
  pairs: Array<{ id: string; settled: Promise<SettledPair> }>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<SettledPair[] | "aborted" | "timed-out"> {
  const all = Promise.all(pairs.map((pair) => pair.settled));
  const racers: Array<Promise<SettledPair[] | "aborted" | "timed-out">> = [all];
  if (timeoutMs !== undefined) {
    racers.push(
      new Promise((resolve) => {
        setTimeout(() => {
          resolve("timed-out");
        }, timeoutMs);
      }),
    );
  }
  if (signal !== undefined) {
    racers.push(
      new Promise((resolve) => {
        const onAbort = (): void => {
          resolve("aborted");
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }
  return Promise.race(racers);
}
