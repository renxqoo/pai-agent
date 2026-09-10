/**
 * Worker pool orchestration: one worker process per live conversation
 * (design.md migration §1/§6). Owns the retire/wake/death state machine,
 * the internal-id registry, and worker frame forwarding. The routing table
 * (entries / live workers / path occupancy) lives in thread-table.ts,
 * process mechanics in worker-process.ts, frame classification in
 * frame-classify.ts.
 *
 * Termination contract (design §6): every worker termination is processed
 * from the child `close` event (stdio drained), never from `exit`; pending
 * routed commands are reconciled against responses already seen and only
 * the missing ones get a synthesized failure.
 */

import { resolve as resolvePath } from "node:path";
import type {
  HubFrame,
  SessionModel,
  ThreadListEntry,
  UiResponseCmd,
  WorkerGrantFrame,
} from "./protocol.ts";
import { INTERNAL_ID_PREFIX } from "./protocol.ts";
import { type RetireIntent, type WorkerHandle, spawnWorkerProcess } from "./worker-process.ts";
import { type DeathDeps, reconcileWorkerClosed } from "./worker-death.ts";
import { GrantLedger, MAX_SUBAGENTS_DEFAULT, replyGrant } from "./grant-ledger.ts";
import {
  resumeThreadAdmission,
  settledHolderOf,
  startThreadAdmission,
  type AdmissionOps,
} from "./thread-admission.ts";
import { stopThreadSettlement, type StopOps } from "./thread-stop.ts";
import { type ThreadEntry, ThreadTable } from "./thread-table.ts";
import { readIntEnv } from "./int-env.ts";
import { copySidecarRules } from "./sidecar-rules.ts";
import { sleep } from "./subagent-wire.ts";
import {
  type FrameRelayDeps,
  type InternalWaiter,
  broadcastUiResponseToWorkers,
  onWorkerLine,
} from "./worker-frames.ts";

export const MAX_THREADS_DEFAULT = 32;
export const IDLE_RETIRE_MS_DEFAULT = 900_000;
export const WORKER_STALE_MS_DEFAULT = 30_000;
export const WORKER_EXIT_TIMEOUT_MS_DEFAULT = 10_000;
const STALE_SIGKILL_GRACE_MS = 2_000;
const SWEEP_INTERVAL_MS = 1_000;

export interface WorkerPoolOptions {
  /** Emit a synthesized frame (host serializes it). */
  emitFrame: (frame: HubFrame) => void;
  /** Forward a worker line verbatim (no re-serialization). */
  emitRaw: (line: string) => void;
  writeStderr: (text: string) => void;
  maxThreads?: number;
  idleRetireMs?: number;
  workerStaleMs?: number;
  workerExitTimeoutMs?: number;
  /** v0.6: global RUNNING-grandchild cap (PAI_MAX_SUBAGGENTS). */
  maxSubagents?: number;
  /** Test seam: fake worker spawn. */
  spawnWorker?: typeof spawnWorkerProcess;
  /** v0.8: backend id the host expects in each worker's hello frame. */
  backendId?: string;
  /** v0.8 registry: explicit spawn spec for external backends; omitted =
   * dynamic self-resolution (the three launch forms). */
  spawnSpec?: { command: string; args: readonly string[]; env?: Record<string, string> };
}

/** Internal resume exchange: settle when the absorbed response lands, the
 * worker dies, or the write fails; onFailedResume runs the occupancy/death
 * cleanup exactly once. */
async function resumeAndWait(deps: {
  worker: WorkerHandle;
  entry: ThreadEntry;
  sessionPath: string;
  registerInternal: (waiter: InternalWaiter) => string;
  internalIds: Map<string, InternalWaiter>;
  onFailedResume: () => Promise<void>;
}): Promise<void> {
  const { worker, entry } = deps;
  const forget = (id: string): void => {
    deps.internalIds.delete(`${worker.uid}:${id}`);
    worker.internalIds.delete(id);
  };
  try {
    await new Promise<void>((done, refuse) => {
      const id = deps.registerInternal({
        onResponse: (frame) => {
          forget(id);
          if (frame["success"] === true) done();
          else refuse(new Error(String(frame["error"] ?? "resume failed")));
        },
        onClosed: () => {
          forget(id);
          refuse(new Error("worker died while resuming"));
        },
      });
      void worker
        .writeLine(
          JSON.stringify({
            type: "thread/resume",
            sessionPath: deps.sessionPath,
            cwd: entry.cwd,
            trusted: entry.trusted,
            id,
          }),
        )
        .catch((error: unknown) => {
          forget(id);
          refuse(error instanceof Error ? error : new Error(String(error)));
        });
    });
  } catch (error) {
    await deps.onFailedResume();
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export class WorkerPool {
  private readonly table = new ThreadTable();
  private readonly internalIds = new Map<string, InternalWaiter>();
  private readonly allWorkers = new Set<WorkerHandle>();
  private internalSeq = 0;
  private workerSeq = 0;
  private readonly maxThreads: number;
  private readonly idleRetireMs: number;
  private readonly workerStaleMs: number;
  private readonly workerExitTimeoutMs: number;
  private readonly maxSubagents: number;
  private readonly grantLedger: GrantLedger;
  private readonly emitFrame: (frame: HubFrame) => void;
  private readonly emitRaw: (line: string) => void;
  private readonly writeStderr: (text: string) => void;
  private readonly spawnWorkerFn: typeof spawnWorkerProcess;
  private readonly backendId: string;
  private readonly spawnSpec: WorkerPoolOptions["spawnSpec"];
  private readonly sweep: ReturnType<typeof setInterval>;
  private shuttingDown = false;

  constructor(options: WorkerPoolOptions) {
    this.emitFrame = options.emitFrame;
    this.emitRaw = options.emitRaw;
    this.writeStderr = options.writeStderr;
    this.maxThreads = options.maxThreads ?? readIntEnv("PAI_MAX_THREADS", MAX_THREADS_DEFAULT);
    this.idleRetireMs =
      options.idleRetireMs ?? readIntEnv("PAI_IDLE_RETIRE_MS", IDLE_RETIRE_MS_DEFAULT);
    this.workerStaleMs =
      options.workerStaleMs ?? readIntEnv("PAI_WORKER_STALE_MS", WORKER_STALE_MS_DEFAULT);
    this.workerExitTimeoutMs =
      options.workerExitTimeoutMs ??
      readIntEnv("PAI_WORKER_EXIT_TIMEOUT_MS", WORKER_EXIT_TIMEOUT_MS_DEFAULT);
    this.maxSubagents =
      options.maxSubagents ?? readIntEnv("PAI_MAX_SUBAGENTS", MAX_SUBAGENTS_DEFAULT);
    this.grantLedger = new GrantLedger(this.maxSubagents);
    this.spawnWorkerFn = options.spawnWorker ?? spawnWorkerProcess;
    this.backendId = options.backendId ?? "pi-coding-agent";
    this.spawnSpec = options.spawnSpec;
    this.sweep = setInterval(() => this.sweepWorkers(), SWEEP_INTERVAL_MS);
  }

  listEntries(): ThreadListEntry[] {
    return this.table.list((threadId) => this.table.liveWorker(threadId)?.streaming ?? false);
  }

  hasThread(threadId: string): boolean {
    return this.table.has(threadId);
  }

  /** Entry facts for host-local commands (agents/list). */
  entryFor(threadId: string): { cwd: string; trusted: boolean } | undefined {
    const entry = this.table.entry(threadId);
    return entry === undefined ? undefined : { cwd: entry.cwd, trusted: entry.trusted };
  }
  /** Parked read-history routing fact (v0.12): entry state + session path. */
  historyTarget(
    threadId: string,
  ): { state: "live" | "parked" | "dead"; sessionPath: string | null } | undefined {
    const entry = this.table.entry(threadId);
    return entry === undefined ? undefined : { state: entry.state, sessionPath: entry.sessionPath };
  }
  liveCount(): number {
    return this.table.liveCount();
  }

  /** Aggregate in-flight subagent (grandchild) count over live workers. */
  inFlightSubagents(): number {
    return this.liveWorkers().reduce((total, worker) => total + worker.subagents, 0);
  }

  /** Live/parked/dead entry counts (get_host_info.threads). */
  threadStateCounts(): { live: number; parked: number; dead: number } {
    return this.table.stateCounts();
  }

  limits(): {
    maxThreads: number;
    idleRetireMs: number;
    workerStaleMs: number;
    workerExitTimeoutMs: number;
    maxSubagents: number;
  } {
    return {
      maxThreads: this.maxThreads,
      idleRetireMs: this.idleRetireMs,
      workerStaleMs: this.workerStaleMs,
      workerExitTimeoutMs: this.workerExitTimeoutMs,
      maxSubagents: this.maxSubagents,
    };
  }

  /** Global RUNNING grandchildren per the grant ledger. */
  runningGrants(): number {
    return this.grantLedger.running();
  }

  /** Worker→host grant arbitration (migration §3 addendum): synchronous
   * ledger decision + internal reply; release frames free silently. */
  handleGrantFrame(worker: WorkerHandle, frame: WorkerGrantFrame): void {
    replyGrant({
      internalIds: this.internalIds,
      worker,
      grantId: frame.id,
      decision: this.grantLedger.apply(worker, frame),
    });
  }

  /** thread/start / thread/resume: admission lives in thread-admission.ts. */
  async startThread(
    cmd: { id?: string; cwd?: string; trusted?: boolean },
    model?: SessionModel,
  ): Promise<void> {
    await startThreadAdmission(this.admissionOps(), cmd, model);
  }

  async resumeThread(cmd: {
    id?: string;
    sessionPath: string;
    cwd?: string;
    trusted?: boolean;
  }): Promise<void> {
    await resumeThreadAdmission(this.admissionOps(), cmd);
  }

  /**
   * Route one already-serialized command line to the thread's worker,
   * waking parked/dead threads and queueing behind an in-flight retirement.
   * Emits the failure response itself when routing is impossible.
   */
  async sendToThread(
    cmd: { type: string; threadId: string; id?: string },
    line: string,
  ): Promise<void> {
    for (;;) {
      if (this.shuttingDown) {
        this.failure(cmd.id, cmd.type, "pai-cli is shutting down");
        return;
      }
      const entry = this.table.entry(cmd.threadId);
      if (entry === undefined) {
        this.failure(cmd.id, cmd.type, `Unknown threadId: ${cmd.threadId}`);
        return;
      }
      if (entry.state !== "live") {
        try {
          await this.ensureAwake(entry);
        } catch (error) {
          this.failure(cmd.id, cmd.type, error instanceof Error ? error.message : String(error));
          return;
        }
        continue;
      }
      const worker = this.table.liveWorker(cmd.threadId);
      if (worker === undefined) {
        // ensureAwake raced a death; its close handling already re-marked
        // the entry — re-evaluate.
        continue;
      }
      if (worker.retiring) {
        await worker.closed;
        continue;
      }
      void this.deliverCommand({ worker, id: cmd.id, command: cmd.type, line });
      return;
    }
  }

  async stopThread(threadId: string, cmdId: string | undefined, cmdType: string): Promise<void> {
    stopThreadSettlement(this.stopOps(), { threadId, id: cmdId, cmdType });
  }

  /** ui_response: ack once in the host, broadcast to every live worker (the
   * owner resolves by requestId; the rest ignore it). No per-dialog state. */
  broadcastUiResponse(cmd: UiResponseCmd): void {
    broadcastUiResponseToWorkers({
      cmd,
      workers: this.liveWorkers(),
      registerInternal: (worker, waiter) => this.registerInternal(worker, waiter),
      forgetInternal: (worker, id) => {
        this.internalIds.delete(WorkerPool.internalKey(worker, id));
        worker.internalIds.delete(id);
      },
    });
  }

  /** Graceful shutdown: EOF every worker, wait for close, force after timeout.
   * Does NOT run death handling (no thread_died, no synthesized failures) —
   * the host connection is closing and Electron will not consume them. */
  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.sweep);
    const workers = [...this.allWorkers];
    for (const worker of workers) {
      worker.retireIntent = "shutdown";
      worker.retiring = true;
      worker.stdin.end();
    }
    const timeout = sleep(this.workerExitTimeoutMs);
    await Promise.race([Promise.allSettled(workers.map((w) => w.closed)), timeout]);
    for (const worker of this.allWorkers) {
      if (!worker.child.killed) worker.child.kill("SIGKILL");
    }
    await Promise.allSettled([...this.allWorkers].map((worker) => worker.closed));
  }

  // --- internals ------------------------------------------------------------

  private liveWorkers(): WorkerHandle[] {
    const live: WorkerHandle[] = [];
    for (const worker of this.allWorkers) {
      if (!worker.retiring && this.table.liveWorker(worker.threadId) === worker) live.push(worker);
    }
    return live;
  }

  private stopOps(): StopOps {
    return {
      table: this.table,
      emitFrame: this.emitFrame,
      liveWorker: (threadId) => this.table.liveWorker(threadId),
      armTeardownDeadline: (worker) => this.armTeardownDeadline(worker),
      deliverCommand: (command) => this.deliverCommand(command),
    };
  }

  private rejectOverBudget(id: string | undefined, command: string): boolean {
    if (!this.liveBudgetExceeded()) return false;
    this.failure(id, command, `Too many concurrent conversations (limit ${this.maxThreads})`);
    return true;
  }

  /** Track the command id, deliver the line, and self-report a failure for
   * a delivery error (close reconciliation never sees undelivered writes). */
  private deliverCommand(deps: {
    worker: WorkerHandle;
    id: string | undefined;
    command: string;
    line: string;
  }): Promise<void> {
    const { worker, id, command, line } = deps;
    if (id !== undefined) worker.pendingIds.set(id, command);
    return worker.writeLine(line).catch((error: unknown) => {
      worker.pendingIds.delete(id ?? "");
      this.failure(id, command, this.deliveryErrorMessage(error));
    });
  }

  private liveAndSpawning(): number {
    const spawning = Array.from(this.allWorkers).filter((w) => w.awaitingStart).length;
    return this.table.liveCount() + spawning;
  }

  private liveBudgetExceeded(): boolean {
    return this.liveAndSpawning() >= this.maxThreads;
  }

  /** Post-spawn check: the caller's own spawn now counts itself, so the
   * budget is only violated when total EXCEEDS the cap (a spawn landing on
   * the exact last slot is legitimate — the off-by-one would otherwise make
   * PAI_MAX_THREADS=N an effective N-1, and N=1 unusable). */
  private overBudget(): boolean {
    return this.liveAndSpawning() > this.maxThreads;
  }

  private failure(id: string | undefined, command: string, error: string): void {
    this.emitFrame({ type: "response", id, command, success: false, error });
  }

  private deliveryErrorMessage(error: unknown): string {
    return `worker died: command could not be delivered (${error instanceof Error ? error.message : String(error)})`;
  }

  /** Internal-id key is worker-scoped: ids are only unique within one
   * worker, and a global raw-id lookup would mis-absorb same-string ids
   * across workers (adversarial review #2/#3). */
  private static internalKey(worker: WorkerHandle, id: string): string {
    return `${worker.uid}:${id}`;
  }

  private registerInternal(worker: WorkerHandle, waiter: InternalWaiter): string {
    this.internalSeq += 1;
    const id = `${INTERNAL_ID_PREFIX}${this.internalSeq}`;
    this.internalIds.set(WorkerPool.internalKey(worker, id), waiter);
    worker.internalIds.add(id);
    return id;
  }

  private ensureAwake(entry: ThreadEntry): Promise<void> {
    if (entry.wake !== undefined) return entry.wake;
    const wake = this.doWake(entry).finally(() => {
      const current = this.table.entry(entry.threadId);
      if (current !== undefined) current.wake = undefined;
    });
    const current = this.table.entry(entry.threadId);
    if (current !== undefined) current.wake = wake;
    return wake;
  }

  private async doWake(entry: ThreadEntry): Promise<void> {
    if (entry.sessionPath === null) {
      throw new Error("Cannot wake thread: session was never persisted");
    }
    if (this.liveBudgetExceeded()) {
      throw new Error(`Too many concurrent conversations (limit ${this.maxThreads})`);
    }
    const sessionPath = resolvePath(entry.sessionPath);
    const holder = await settledHolderOf(this.admissionOps(), sessionPath);
    if (holder !== undefined) {
      throw new Error(
        `Session already open (threadId: ${holder.threadId}); two writers would corrupt the session file`,
      );
    }
    const worker = this.spawnWorker(entry.trusted);
    const held = this.table.holder(sessionPath, this.allWorkers) !== undefined;
    if (held || this.overBudget()) {
      await this.killWorker(worker, "stop");
      throw new Error(
        held
          ? "Session already open in another conversation"
          : `Too many concurrent conversations (limit ${this.maxThreads})`,
      );
    }
    this.table.occupy(worker, sessionPath);
    await this.internalResume(worker, entry, sessionPath);
    // Lazy-persist sessions resume under a fresh session id: re-key the
    // stale parked entry (sidecar rules follow) or it wedges the same
    // session path forever ("Session already open" self-lock).
    if (worker.threadId !== "" && worker.threadId !== entry.threadId) {
      this.table.rekeyWake(worker, entry.threadId, {
        warn: this.writeStderr,
        copy: copySidecarRules,
      });
    }
    // thread/stop raced the wake (design §6): settle by closure reference —
    // the kill must never depend on table lookups the re-key above or
    // registerLive's re-registration may have invalidated.
    if (entry.stopRequested) {
      this.table.delete(entry.threadId);
      this.table.delete(worker.threadId);
      await this.killWorker(worker, "stop");
    }
  }

  /** Internal resume: settle on the absorbed response, death, or write
   * failure; cleanup (occupancy + dead mark + kill) runs exactly once. */
  private async internalResume(
    worker: WorkerHandle,
    entry: ThreadEntry,
    sessionPath: string,
  ): Promise<void> {
    await resumeAndWait({
      worker,
      entry,
      sessionPath,
      registerInternal: (waiter) => this.registerInternal(worker, waiter),
      internalIds: this.internalIds,
      onFailedResume: async () => {
        this.releaseOccupancy(worker, sessionPath);
        this.markDead(entry.threadId);
        await this.killWorker(worker, "stop").catch(() => {});
      },
    });
  }

  private releaseOccupancy(worker: WorkerHandle, sessionPath: string): void {
    const holder = this.table.holder(sessionPath, this.allWorkers);
    if (holder === worker) this.table.reoccupy(worker, null);
  }

  private markDead(threadId: string): void {
    const entry = this.table.entry(threadId);
    if (entry === undefined) return;
    entry.state = "dead";
    this.table.enforceNonLiveCap();
  }

  private admissionOps(): AdmissionOps {
    return {
      table: this.table,
      workers: () => [...this.allWorkers],
      spawnWorker: (trusted) => this.spawnWorker(trusted),
      killWorker: (worker, intent) => this.killWorker(worker, intent),
      deliverCommand: (command) => this.deliverCommand(command),
      rejectOverBudget: (id, command) => this.rejectOverBudget(id, command),
      overBudget: () => this.overBudget(),
      failure: (id, command, error) => this.failure(id, command, error),
    };
  }

  private async killWorker(worker: WorkerHandle, intent: RetireIntent): Promise<void> {
    if (worker.retireIntent === "none") worker.retireIntent = intent;
    worker.child.kill("SIGTERM");
    const grace = setTimeout(() => worker.child.kill("SIGKILL"), STALE_SIGKILL_GRACE_MS);
    await worker.closed.finally(() => clearTimeout(grace));
  }

  private retire(worker: WorkerHandle): void {
    if (worker.retireIntent !== "none" || worker.retiring) return;
    worker.retiring = true;
    worker.retireIntent = "retire";
    worker.stdin.end();
    this.armTeardownDeadline(worker);
  }

  /** Bounded tear-down (design §6): a wedged-but-heartbeating worker would
   * outlive the sweep's stale kill line forever — force-kill it once the
   * exit budget lapses (killWorker owns SIGTERM -> SIGKILL; the timer is
   * cleared on close like every other state transition). */
  private armTeardownDeadline(worker: WorkerHandle): void {
    const grace = setTimeout(() => void this.killWorker(worker, "none"), this.workerExitTimeoutMs);
    void worker.closed.finally(() => clearTimeout(grace));
  }

  private sweepWorkers(): void {
    const now = Date.now();
    this.grantLedger.expire();
    for (const worker of this.allWorkers) {
      if (worker.awaitingStart && now > worker.spawnDeadline) {
        void this.killWorker(worker, "none");
        continue;
      }
      if (this.table.liveWorker(worker.threadId) !== worker) continue; // not live yet
      if (now - worker.lastHeartbeatAt > this.workerStaleMs) {
        void this.killWorker(worker, "none");
        continue;
      }
      if (!worker.retiring && worker.idleMs >= this.idleRetireMs && worker.sessionPath !== null) {
        this.retire(worker);
      }
    }
  }

  private frameRelayDeps(): FrameRelayDeps {
    return {
      table: this.table,
      internalIds: this.internalIds,
      emitFrame: this.emitFrame,
      emitRaw: this.emitRaw,
      writeStderr: this.writeStderr,
      killWorker: (worker, intent) => this.killWorker(worker, intent),
      onGrant: (worker, frame) => this.handleGrantFrame(worker, frame),
      renewGrants: (worker) => this.grantLedger.renew(worker),
      internalKey: (worker, id) => WorkerPool.internalKey(worker, id),
      expectedBackendId: this.backendId,
    };
  }

  private spawnWorker(trusted: boolean): WorkerHandle {
    const relay = this.frameRelayDeps();
    this.workerSeq += 1;
    const worker = this.spawnWorkerFn({
      uid: `w${this.workerSeq}`,
      trusted,
      spawnTimeoutMs: this.workerExitTimeoutMs,
      onLine: (line) => onWorkerLine(relay, worker, line),
      onViolation: () => void this.killWorker(worker, "none"),
      onClosed: (code, signal) => this.onWorkerClosed(worker, code, signal),
      writeStderr: this.writeStderr,
      ...(this.spawnSpec !== undefined ? { spawnSpec: this.spawnSpec } : {}),
    });
    this.allWorkers.add(worker);
    return worker;
  }

  private onWorkerClosed(worker: WorkerHandle, code: number | null, signal: string | null): void {
    reconcileWorkerClosed({
      death: this.deathDeps(),
      worker,
      code,
      signal,
      workerExitTimeoutMs: this.workerExitTimeoutMs,
    });
  }

  private deathDeps(): DeathDeps {
    return {
      table: this.table,
      internalIds: this.internalIds,
      allWorkers: this.allWorkers,
      freeGrants: (worker) => this.grantLedger.freeWorker(worker),
      failure: (id, command, error) => this.failure(id, command, error),
      emitFrame: this.emitFrame,
    };
  }
}
