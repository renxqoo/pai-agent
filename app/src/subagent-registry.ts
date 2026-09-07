/**
 * Subagent registry (plan background-subagents §拆分): the worker-level
 * single truth for grandchild tasks — global concurrency gate (live <= 4
 * across ALL batches), queued scheduling, per-task AbortControllers
 * (killAll / task_stop), retained results (FIFO <= 16), and the ui_response
 * routing absorbed from the old SubagentRelay. Foreground batches flow
 * through the same gate: a lone call behaves exactly as before; concurrent
 * calls share the global 4 slots (new contract, plan stage 1).
 *
 * Budgets (violating any is a defect): live <= MAX_CONCURRENT_SUBAGENTS at
 * any instant; in-flight (queued+running) <= MAX_INFLIGHT_PER_CONVERSATION
 * enforced by the tool before reservation; retained <= RETAINED_CAP.
 */

import {
  type GrandchildDriver,
  type GrandchildHooks,
  type GrandchildResult,
  type GrandchildTaskSpec,
  startGrandchildTask,
} from "./subagent-process.ts";

/** Subagent budget constants (single truth; the tool re-uses them). */
export const MAX_TASKS_PER_CALL = 8;
export const MAX_CONCURRENT_SUBAGENTS = 4;
export const MAX_INFLIGHT_PER_CONVERSATION = 8;
export const RETAINED_CAP = 16;

export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "stopped";

interface RegistryEntry {
  spec: GrandchildTaskSpec;
  hooks: GrandchildHooks;
  resolveSettle: (result: GrandchildResult) => void;
  status: SubagentStatus;
  startedAt: number | null;
  controller: AbortController;
  driver: GrandchildDriver | undefined;
  stopRequested: boolean;
  killedByKillAll: boolean;
  result: GrandchildResult | undefined;
  settled: Promise<GrandchildResult>;
}

export interface LaunchHandle {
  result: Promise<GrandchildResult>;
  /** Whether this task got a concurrency slot immediately. */
  status: "started" | "queued";
}

export interface RegistryDeps {
  /** Test seam: grandchild launcher (defaults to the real driver). */
  startTask?: typeof startGrandchildTask;
}

export class SubagentRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly queue: string[] = [];
  private readonly startTask: typeof startGrandchildTask;

  constructor(deps?: RegistryDeps) {
    this.startTask = deps?.startTask ?? startGrandchildTask;
  }

  /** In-flight = queued + running (the heartbeat `subagents` figure). */
  inFlight(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === "queued" || entry.status === "running") count += 1;
    }
    return count;
  }

  liveCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === "running") count += 1;
    }
    return count;
  }

  /**
   * Reserve one task: spawn immediately when a concurrency slot is free,
   * queue otherwise (status "queued" until a slot opens at some settle).
   * `outerSignal` (the foreground turn signal) is chained onto the entry's
   * own controller so both turn abort and killAll reach the grandchild.
   */
  launch(deps: {
    spec: GrandchildTaskSpec;
    hooks: GrandchildHooks;
    outerSignal?: AbortSignal;
  }): LaunchHandle {
    const { spec } = deps;
    let resolveSettle!: (result: GrandchildResult) => void;
    const settled = new Promise<GrandchildResult>((resolvePromise) => {
      resolveSettle = resolvePromise;
    });
    const entry: RegistryEntry = {
      spec,
      resolveSettle,
      hooks: deps.hooks,
      status: "queued",
      startedAt: null,
      controller: new AbortController(),
      driver: undefined,
      stopRequested: false,
      killedByKillAll: false,
      result: undefined,
      settled,
    };
    this.entries.set(spec.subagentId, entry);
    if (deps.outerSignal !== undefined) {
      if (deps.outerSignal.aborted) entry.controller.abort();
      else
        deps.outerSignal.addEventListener(
          "abort",
          () => {
            entry.controller.abort();
          },
          { once: true },
        );
    }
    if (this.liveCount() < MAX_CONCURRENT_SUBAGENTS) {
      this.startNow(entry);
      return { result: settled, status: "started" };
    }
    this.queue.push(spec.subagentId);
    return { result: settled, status: "queued" };
  }

  /** Stop one task: queued -> dequeue without spawning; running -> abort chain. */
  stopOne(subagentId: string): SubagentStatus | undefined {
    const entry = this.entries.get(subagentId);
    if (entry === undefined) return undefined;
    if (entry.status === "queued") {
      const index = this.queue.indexOf(subagentId);
      if (index !== -1) this.queue.splice(index, 1);
      this.settleEntry(entry, stoppedResult(entry.spec, false));
      return entry.status;
    }
    if (entry.status === "running") {
      entry.stopRequested = true;
      entry.controller.abort();
      return entry.status;
    }
    return entry.status; // already settled: idempotent terminal state
  }

  /** Kill every non-settled task (client abort / thread stop / shutdown). */
  killAll(): void {
    this.queue.length = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === "running") {
        entry.killedByKillAll = true;
        entry.controller.abort();
      } else if (entry.status === "queued") {
        entry.killedByKillAll = true;
        this.settleEntry(entry, stoppedResult(entry.spec, true));
      }
    }
  }

  /** Route a ui_response broadcast into a live grandchild (false = unknown). */
  route(requestId: string, payload: Record<string, unknown>): boolean {
    for (const entry of this.entries.values()) {
      if (entry.status === "running" && entry.driver?.resolveUi(requestId, payload) === true) {
        return true;
      }
    }
    return false;
  }

  private startNow(entry: RegistryEntry): void {
    entry.status = "running";
    entry.startedAt = Date.now();
    const driver = this.startTask({
      spec: entry.spec,
      hooks: entry.hooks,
      signal: entry.controller.signal,
    });
    entry.driver = driver;
    void driver.result.then((result) => this.settleEntry(entry, result));
  }

  private settleEntry(entry: RegistryEntry, result: GrandchildResult): void {
    entry.result = result;
    entry.driver = undefined;
    entry.status = terminalStatus(entry, result);
    entry.resolveSettle(result);
    this.evictOverflow();
    this.scheduleQueued();
  }

  private scheduleQueued(): void {
    while (this.queue.length > 0 && this.liveCount() < MAX_CONCURRENT_SUBAGENTS) {
      const id = this.queue.shift();
      const entry = id === undefined ? undefined : this.entries.get(id);
      if (entry === undefined) continue;
      if (entry.status !== "queued") continue;
      this.startNow(entry);
    }
  }

  private evictOverflow(): void {
    const settledIds: string[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.result !== undefined) settledIds.push(id);
    }
    while (settledIds.length > RETAINED_CAP) {
      const evicted = settledIds.shift();
      if (evicted !== undefined) this.entries.delete(evicted);
    }
  }
}

function terminalStatus(entry: RegistryEntry, result: GrandchildResult): SubagentStatus {
  if (result.aborted) return "stopped";
  if (result.isError) return "failed";
  return "completed";
}

function stoppedResult(spec: GrandchildTaskSpec, killed: boolean): GrandchildResult {
  return {
    agent: spec.agent,
    task: spec.task,
    output: killed ? "subagent killed" : "subagent stopped before start",
    isError: true,
    errorMessage: killed ? "subagent killed" : "subagent stopped before start",
    aborted: true,
    usage: {
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
    },
    stderr: "",
    truncated: false,
    eventsRelayed: 0,
  };
}
