/**
 * Query face for background subagents (plan background-subagents stage 4 +
 * communication stages 7/9): task_out (snapshot), task_wait (barrier with
 * notification suppression, timeout, abort), task_stop (single stop),
 * task_steer (inject into a running task), task_send (sibling routing via
 * the same steer pipeline, father-mediated). Pure observers except stop;
 * task_out never blocks and never kills.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GrandchildResult } from "../../pi-coding-agent/subagent-process.ts";
import type { SubagentRegistryFace } from "../../ports/subagent.ts";
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

const SteerParams = Type.Object({
  subagentId: Type.String({ description: "The RUNNING subagent to steer (sub_…)" }),
  message: Type.String({ description: "Guidance injected after the current tool call" }),
});

const SendParams = Type.Object({
  to: Type.String({ description: "Target sibling subagentId; must be RUNNING (sub_…)" }),
  message: Type.String({ description: "Message for the sibling (enveloped as from the lead)" }),
});

export function registerQueryTools(pi: ExtensionAPI, tool: TaskToolDeps): void {
  registerOut(pi, tool);
  registerWait(pi, tool);
  registerStop(pi, tool);
  registerSteer(pi, tool);
  registerSend(pi, tool);
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

/** Stage 7: same pipeline as the client's subagent/steer command — the
 * registry owns the not-running wording; fire-and-ack (delivery inside the
 * grandchild is pi's steer queue, after its current tool call). */
function registerSteer(pi: ExtensionAPI, tool: TaskToolDeps): void {
  pi.registerTool({
    name: "task_steer",
    label: "Steer task",
    description:
      "Inject guidance into a RUNNING subagent (delivered after its current tool call, before its next model call). Cannot steer queued or settled tasks — check task_out first.",
    parameters: SteerParams,
    async execute(_toolCallId, params) {
      const { subagentId, message } = params as { subagentId: string; message: string };
      const outcome = await tool.registry.steer(subagentId, message);
      if (outcome === true) {
        return {
          content: [{ type: "text", text: `steered ${subagentId}` }],
          details: { mode: "single", results: [] },
        };
      }
      return {
        content: [
          { type: "text", text: typeof outcome === "string" ? outcome : "subagent is gone" },
        ],
        isError: true,
        details: { mode: "single", results: [] },
      };
    },
  });
}

/** Stage 9: sibling routing, father-mediated — the target must be running;
 * the message is enveloped so the sibling knows it came via the lead. */
function registerSend(pi: ExtensionAPI, tool: TaskToolDeps): void {
  pi.registerTool({
    name: "task_send",
    label: "Send to sibling",
    description:
      "Relay a message to a RUNNING sibling subagent (delivered like a steer, enveloped [from: lead]). Subagents cannot receive while queued or settled — route later requests as a new task instead.",
    parameters: SendParams,
    async execute(_toolCallId, params) {
      const { to, message } = params as { to: string; message: string };
      const outcome = await tool.registry.steer(to, `[from: lead via task_send] ${message}`);
      if (outcome === true) {
        return {
          content: [{ type: "text", text: `sent to ${to}` }],
          details: { mode: "single", results: [] },
        };
      }
      return {
        content: [
          { type: "text", text: typeof outcome === "string" ? outcome : "subagent is gone" },
        ],
        isError: true,
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
  registry: SubagentRegistryFace;
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

/** details.results carries the full per-task record (review A-P3-8): UI
 * panels reading wait results get the same stats runParallel provides. */
function aggregateWait(
  pairs: Array<{ id: string; result: GrandchildResult }>,
  unknown: string[],
): ToolResult {
  const lines: string[] = [];
  const entries: ToolResult["details"]["results"] = [];
  for (const pair of pairs) {
    let statusWord: "completed" | "stopped" | "failed" = "completed";
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
      output: pair.result.output,
      isError: pair.result.isError,
      aborted: pair.result.aborted,
      truncated: pair.result.truncated,
      eventsRelayed: pair.result.eventsRelayed,
      usage: pair.result.usage,
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

function allInFlightIds(registry: SubagentRegistryFace): string[] {
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

/** Racer cleanup (review A-P3-7): the losing timeout timer and abort
 * listener must not linger — a long timeoutMs would pin the loop's
 * references after the settles won. */
function raceSettles(
  pairs: Array<{ id: string; settled: Promise<SettledPair> }>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<SettledPair[] | "aborted" | "timed-out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined && signal !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  };
  const all = Promise.all(pairs.map((pair) => pair.settled));
  const racers: Array<Promise<SettledPair[] | "aborted" | "timed-out">> = [all];
  if (timeoutMs !== undefined) {
    racers.push(
      new Promise((resolve) => {
        timer = setTimeout(() => {
          resolve("timed-out");
        }, timeoutMs);
      }),
    );
  }
  if (signal !== undefined) {
    racers.push(
      new Promise((resolve) => {
        onAbort = (): void => {
          resolve("aborted");
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }
  return Promise.race(racers).finally(cleanup);
}
