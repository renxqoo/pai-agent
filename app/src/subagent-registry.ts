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
  type GrandchildMessage,
  type GrandchildResult,
  type GrandchildTaskSpec,
  type GrandchildUsage,
  startGrandchildTask,
} from "./subagent-process.ts";
import { tailBytes, truncateBytes } from "./truncate.ts";

/** Subagent budget constants (single truth; the tool re-uses them). */
export const MAX_TASKS_PER_CALL = 8;
export const MAX_CONCURRENT_SUBAGENTS = 4;
export const MAX_INFLIGHT_PER_CONVERSATION = 8;
export const RETAINED_CAP = 16;
/** Notification output excerpt cap (plan budget section). */
export const NOTIFY_OUTPUT_CAP_BYTES = 8 * 1024;
/** Per-notification delivery retries before stderr-drop (review P1-2). */
export const NOTIFY_RETRY_CAP = 3;
/** Stage 8: inter-agent messages per task (report+send combined). Enforced
 * in the grandchild's tools AND here (defense in depth — the parent never
 * trusts the grandchild's own accounting). */
export const MAX_MESSAGES_PER_TASK = 10;

/** The session-facing surface the notification delivery needs. The worker
 * supplies this; the registry never imports SessionHost (deps direction). */
export interface NotifySession {
  isStreaming: boolean;
  isCompacting: boolean;
  prompt(text: string): Promise<void>;
}

interface PendingNotification {
  text: string;
  retries: number;
  /** Whose result this is (null = registry-generated notice); used to
   * recall queued entries when task_wait consumes the result. */
  subagentId: string | null;
}

export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "stopped";

interface RegistryEntry {
  spec: GrandchildTaskSpec;
  hooks: GrandchildHooks;
  resolveSettle: (result: GrandchildResult) => void;
  status: SubagentStatus;
  startedAt: number | null;
  settledAt: number | null;
  controller: AbortController;
  driver: GrandchildDriver | undefined;
  killedByKillAll: boolean;
  /** Background launches notify on settle; foreground results return in the
   * tool result and a wake turn would duplicate them (review P1-2). */
  background: boolean;
  result: GrandchildResult | undefined;
  settled: Promise<GrandchildResult>;
  /** Stage 8: report/send messages accepted from this task (parent-side cap). */
  messagesDelivered: number;
}

export interface LaunchHandle {
  result: Promise<GrandchildResult>;
  /** Whether this task got a concurrency slot immediately. */
  status: "started" | "queued" | "rejected";
  /** Set when status is "rejected" (in-flight budget; review P1-4). */
  rejection?: string;
}

export interface RegistryDeps {
  /** Test seam: grandchild launcher (defaults to the real driver). */
  startTask?: typeof startGrandchildTask;
  /** Notification target (stage 3): current session, dynamic per call. */
  getSession?: () => NotifySession | undefined;
  isShuttingDown?: () => boolean;
  writeStderr?: (text: string) => void;
}

export interface SnapshotEntry {
  subagentId: string;
  agent: string;
  task: string;
  status: SubagentStatus;
  elapsedMs: number;
  output: string;
  usage: GrandchildUsage;
  eventsRelayed: number;
  truncated: boolean;
}

/** running tail cap for task_out previews (plan contract section). */
export const TASK_OUT_RUNNING_TAIL_BYTES = 2 * 1024;
/** Envelope task cap (review P2-10): chain steps can embed a 50KB
 * {previous} output; event frames AND task_out snapshots would re-carry it
 * without this cap (review B-P3-7 closed the snapshot bypass). */
export const ENVELOPE_TASK_CAP = 512;

function envelopeTask(task: string): string {
  return Buffer.byteLength(task, "utf8") <= ENVELOPE_TASK_CAP
    ? task
    : truncateBytes(task, ENVELOPE_TASK_CAP, "...");
}

function elapsedOf(entry: RegistryEntry, now: number): number {
  if (entry.settledAt !== null && entry.startedAt !== null)
    return entry.settledAt - entry.startedAt;
  if (entry.startedAt !== null) return now - entry.startedAt;
  return 0;
}

function snapshotOf(entry: RegistryEntry): SnapshotEntry {
  const now = Date.now();
  const base = {
    subagentId: entry.spec.subagentId,
    agent: entry.spec.agent,
    task: envelopeTask(entry.spec.task),
    status: entry.status,
    elapsedMs: elapsedOf(entry, now),
  };
  if (entry.result !== undefined) {
    return {
      ...base,
      output: entry.result.output,
      usage: entry.result.usage,
      eventsRelayed: entry.result.eventsRelayed,
      truncated: entry.result.truncated,
    };
  }
  const live = entry.driver?.progress();
  const text = live === undefined ? "" : tailBytes(live.text, TASK_OUT_RUNNING_TAIL_BYTES);
  return {
    ...base,
    output: text,
    usage: live?.usage ?? zeroUsage(),
    eventsRelayed: live?.eventsRelayed ?? 0,
    truncated: live?.truncated ?? false,
  };
}

function zeroUsage(): GrandchildUsage {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };
}

function noSession(): NotifySession | undefined {
  return undefined;
}

export class SubagentRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly queue: string[] = [];
  private readonly startTask: typeof startGrandchildTask;
  private readonly getSession: () => NotifySession | undefined;
  private readonly isShuttingDown: () => boolean;
  private readonly writeStderr: (text: string) => void;
  private readonly pendingNotifications: PendingNotification[] = [];
  /** ids whose notifications task_wait suppresses (results come from wait). */
  private readonly suppressedIds = new Set<string>();
  private delivering = false;

  constructor(deps?: RegistryDeps) {
    this.startTask = deps?.startTask ?? startGrandchildTask;
    this.getSession = deps?.getSession ?? noSession;
    this.isShuttingDown = deps?.isShuttingDown ?? (() => false);
    this.writeStderr = deps?.writeStderr ?? (() => {});
  }

  /** Turn-boundary trigger: the main session's run fully settled. */
  onTurnSettled(): void {
    this.tryDeliver();
  }

  pendingCount(): number {
    return this.pendingNotifications.length;
  }

  /**
   * task_wait consumes results directly, so their queued notifications must
   * be recalled (not just future ones blocked): an entry that settled
   * mid-turn is already sitting in pendingNotifications. A notification
   * mid-delivery cannot be recalled (its prompt is running).
   */
  suppressNotifications(ids: string[]): void {
    for (const id of ids) this.suppressedIds.add(id);
    for (let i = this.pendingNotifications.length - 1; i >= 0; i--) {
      const queued = this.pendingNotifications[i];
      if (
        queued !== undefined &&
        queued.subagentId !== null &&
        this.suppressedIds.has(queued.subagentId)
      ) {
        this.pendingNotifications.splice(i, 1);
      }
    }
  }

  releaseNotifications(ids: string[]): void {
    for (const id of ids) this.suppressedIds.delete(id);
  }

  /**
   * Deliver at most one queued notification as a new user-role turn (plan
   * stage 3): guards shut down / no session / streaming / compacting; any
   * prompt failure requeues (cap 3 then stderr-drop); serial single-flight
   * — the next notification waits for this run's agent_settled trigger.
   */
  private tryDeliver(): void {
    if (this.delivering) return;
    if (this.isShuttingDown()) return;
    const session = this.getSession();
    if (session === undefined || session.isStreaming || session.isCompacting) return;
    const next = this.pendingNotifications.shift();
    if (next === undefined) return;
    this.delivering = true;
    void this.deliverOne(session, next);
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
   * The in-flight cap (queued+running ≤ 8) is enforced HERE, synchronously
   * (review P1-4): the tool's pre-check spans an await, so two parallel
   * task calls could both pass it and double the budget — the registry is
   * the single truth. Rejected launches settle immediately with an error.
   */
  launch(deps: {
    spec: GrandchildTaskSpec;
    hooks: GrandchildHooks;
    background?: boolean;
    outerSignal?: AbortSignal;
  }): LaunchHandle {
    const { spec } = deps;
    if (this.inFlight() >= MAX_INFLIGHT_PER_CONVERSATION) {
      const error = `Too many subagents in flight (${MAX_INFLIGHT_PER_CONVERSATION}); wait for running tasks to finish`;
      return {
        result: Promise.resolve(settledError(spec, error)),
        status: "rejected",
        rejection: error,
      };
    }
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
      settledAt: null,
      controller: new AbortController(),
      driver: undefined,
      killedByKillAll: false,
      background: deps.background === true,
      result: undefined,
      settled,
      messagesDelivered: 0,
    };
    this.entries.set(spec.subagentId, entry);
    chainOuterSignal(entry, deps.outerSignal);
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
      // task_stop (vs killAll): the stopped task still notifies on settle.
      entry.controller.abort();
      return entry.status;
    }
    return entry.status; // already settled: idempotent terminal state
  }

  /** Kill every non-settled task (client abort / thread stop / shutdown) and
   * drop queued notifications: a wake turn after the user declined the work
   * would be spurious (review P1-3). */
  killAll(): void {
    this.queue.length = 0;
    this.pendingNotifications.length = 0;
    this.suppressedIds.clear();
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

  statusOf(subagentId: string): SubagentStatus | "unknown" {
    const entry = this.entries.get(subagentId);
    return entry === undefined ? "unknown" : entry.status;
  }

  /** The settle promise of a known task (resolved already when retained). */
  awaitOf(subagentId: string): Promise<GrandchildResult> | undefined {
    return this.entries.get(subagentId)?.settled;
  }

  /** task_out snapshot: one entry or all (undefined id = everything). */
  snapshot(subagentId?: string): SnapshotEntry[] | SnapshotEntry | undefined {
    if (subagentId !== undefined) {
      const entry = this.entries.get(subagentId);
      return entry === undefined ? undefined : snapshotOf(entry);
    }
    return [...this.entries.values()].map(snapshotOf);
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

  /**
   * Steer one task (stage 7). true = the grandchild accepted the steer;
   * an error string explains why it cannot run (not running / unknown /
   * the grandchild's own rejection); callers surface that verbatim.
   */
  steer(subagentId: string, message: string): Promise<boolean | string> {
    const entry = this.entries.get(subagentId);
    if (entry === undefined) return Promise.resolve(`unknown subagent: ${subagentId}`);
    if (entry.status !== "running" || entry.driver === undefined) {
      return Promise.resolve(`subagent ${subagentId} is not running (status: ${entry.status})`);
    }
    return entry.driver.steer(message);
  }

  /**
   * Queue one inter-agent message (stage 8/9) for turn-boundary delivery to
   * the father model. Suppressed unless the task is still running and was
   * not killed (a dying grandchild's in-flight frame must not wake anyone);
   * the per-task cap is enforced again here (grandchild-side accounting is
   * not trusted). Overflow drops with a stderr note, never throws.
   */
  queueMessage(subagentId: string, message: GrandchildMessage): void {
    const entry = this.entries.get(subagentId);
    if (entry === undefined || entry.status !== "running" || entry.killedByKillAll) return;
    if (entry.messagesDelivered >= MAX_MESSAGES_PER_TASK) {
      this.writeStderr(
        `pai-cli dropped subagent message from ${subagentId}: message budget exhausted\n`,
      );
      return;
    }
    entry.messagesDelivered += 1;
    this.pendingNotifications.push({
      text: formatMessage(entry.spec, message),
      retries: 0,
      // Interim reports are not duplicated by task_wait results — never
      // recalled by suppression (only results are).
      subagentId: null,
    });
    this.tryDeliver();
  }

  private startNow(entry: RegistryEntry): void {
    entry.status = "running";
    entry.startedAt = Date.now();
    entry.settledAt = null;
    const driver = this.startTask({
      spec: entry.spec,
      hooks: entry.hooks,
      signal: entry.controller.signal,
    });
    entry.driver = driver;
    void driver.result.then((result) => this.settleEntry(entry, result));
  }

  private async deliverOne(session: NotifySession, next: PendingNotification): Promise<void> {
    let delivered = false;
    try {
      await session.prompt(next.text);
      delivered = true;
    } catch {
      next.retries += 1;
      if (next.retries < NOTIFY_RETRY_CAP) {
        this.pendingNotifications.unshift(next);
      } else {
        const message = `pai-cli dropped a subagent notification after ${NOTIFY_RETRY_CAP} failed deliveries\n`;
        this.writeStderr(message);
      }
    } finally {
      this.delivering = false;
      // Success path chains the next delivery (review P1-1, both reviewers):
      // pi's prompt() resolves only AFTER the run's agent_settled fired, so
      // that trigger raced the still-set delivering flag and was swallowed —
      // stranding every later queued notification. The failure path must NOT
      // chain: the just-failed prompt would be retried in a tight loop and
      // burn the retry cap in microseconds; it waits for the next trigger.
      if (delivered) this.tryDeliver();
    }
  }

  private settleEntry(entry: RegistryEntry, result: GrandchildResult): void {
    entry.result = result;
    entry.driver = undefined;
    entry.settledAt = Date.now();
    entry.status = terminalStatus(entry, result);
    entry.resolveSettle(result);
    this.evictOverflow();
    this.scheduleQueued();
    // Stage 3: killed-by-killAll → silent (the user declined the work);
    // task_stop (stopped) and genuine settles DO notify — but background
    // tasks only (review P1-2): a foreground result returns in the tool
    // result, and a wake turn would duplicate it and burn a model call.
    if (
      entry.background &&
      !entry.killedByKillAll &&
      !this.suppressedIds.has(entry.spec.subagentId)
    ) {
      this.pendingNotifications.push({
        text: formatNotification(entry.spec, result),
        retries: 0,
        subagentId: entry.spec.subagentId,
      });
      this.tryDeliver();
    }
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

  /** Evict beyond RETAINED_CAP by completion order, not launch order
   * (review P2-6): a long task that launched first but settled last must
   * not be the first evicted the moment it completes. */
  private evictOverflow(): void {
    const settled: Array<{ id: string; settledAt: number }> = [];
    for (const [id, entry] of this.entries) {
      if (entry.settledAt !== null) settled.push({ id, settledAt: entry.settledAt });
    }
    settled.sort((a, b) => a.settledAt - b.settledAt);
    while (settled.length > RETAINED_CAP) {
      const evicted = settled.shift();
      if (evicted !== undefined) this.entries.delete(evicted.id);
    }
  }
}

function formatNotification(spec: GrandchildTaskSpec, result: GrandchildResult): string {
  let statusWord = "completed";
  if (result.aborted) statusWord = "stopped";
  else if (result.isError) statusWord = "failed";
  const output = truncateBytes(
    result.output,
    NOTIFY_OUTPUT_CAP_BYTES,
    "\n[output truncated to 8KB]",
  );
  return [
    `[task-notification] subagent ${spec.subagentId} (${spec.agent}) ${statusWord}.`,
    output,
    `(full output: task_out {"subagentId":"${spec.subagentId}"}; wait for others: task_wait)`,
  ].join("\n");
}

/** Envelope for a queued inter-agent message (stage 8/9 guardrails): source
 * id always; `to` marks a sibling-routing request the father mediates;
 * project-sourced agents speak as unverified data, not instructions. */
function formatMessage(spec: GrandchildTaskSpec, message: GrandchildMessage): string {
  const text = truncateBytes(message.text, NOTIFY_OUTPUT_CAP_BYTES, "\n[message truncated to 8KB]");
  const header =
    message.to === undefined
      ? `[task-message] from subagent ${spec.subagentId} (${spec.agent}):`
      : `[task-message] from subagent ${spec.subagentId} (${spec.agent}) intended for ${message.to} — route it with task_send only if appropriate:`;
  const unverified =
    spec.projectSourced === true
      ? "\n[unverified data: agent definition from the project directory]"
      : "";
  return `${header}\n${text}${unverified}`;
}

function terminalStatus(entry: RegistryEntry, result: GrandchildResult): SubagentStatus {
  if (result.aborted) return "stopped";
  if (result.isError) return "failed";
  return "completed";
}

function settledError(spec: GrandchildTaskSpec, message: string): GrandchildResult {
  return {
    agent: spec.agent,
    task: spec.task,
    output: message,
    isError: true,
    errorMessage: message,
    aborted: false,
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

/** The foreground turn's abort reaches the entry's controller (one-shot). */
function chainOuterSignal(entry: RegistryEntry, outerSignal: AbortSignal | undefined): void {
  if (outerSignal === undefined) return;
  if (outerSignal.aborted) entry.controller.abort();
  else
    outerSignal.addEventListener(
      "abort",
      () => {
        entry.controller.abort();
      },
      { once: true },
    );
}
