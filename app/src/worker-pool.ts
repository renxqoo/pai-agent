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
import type { HubFrame, SessionModel, ThreadListEntry, UiResponseCmd } from "./protocol.ts";
import { INTERNAL_ID_PREFIX } from "./protocol.ts";
import { type RetireIntent, type WorkerHandle, spawnWorkerProcess } from "./worker-process.ts";
import { ThreadTable } from "./thread-table.ts";
import { type FrameRelayDeps, type InternalWaiter, onWorkerLine } from "./worker-frames.ts";

export const MAX_THREADS_DEFAULT = 32;
export const IDLE_RETIRE_MS_DEFAULT = 900_000;
export const WORKER_STALE_MS_DEFAULT = 30_000;
export const WORKER_EXIT_TIMEOUT_MS_DEFAULT = 10_000;
const STALE_SIGKILL_GRACE_MS = 2_000;
const SWEEP_INTERVAL_MS = 1_000;

/** Minimum entry shape the wake paths need (the table holds the full entry). */
interface WakeEntry {
  threadId: string;
  sessionPath: string | null;
  trusted: boolean;
  cwd: string;
}

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
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export class WorkerPool {
  private readonly table = new ThreadTable();
  private readonly internalIds = new Map<string, InternalWaiter>();
  private readonly allWorkers = new Set<WorkerHandle>();
  private internalSeq = 0;
  private readonly maxThreads: number;
  private readonly idleRetireMs: number;
  private readonly workerStaleMs: number;
  private readonly workerExitTimeoutMs: number;
  private readonly emitFrame: (frame: HubFrame) => void;
  private readonly emitRaw: (line: string) => void;
  private readonly writeStderr: (text: string) => void;
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
    this.sweep = setInterval(() => this.sweepWorkers(), SWEEP_INTERVAL_MS);
  }

  listEntries(): ThreadListEntry[] {
    return this.table.list((threadId) => this.table.liveWorker(threadId)?.streaming ?? false);
  }

  hasThread(threadId: string): boolean {
    return this.table.has(threadId);
  }

  liveCount(): number {
    return this.table.liveCount();
  }

  /** thread/start: spawn a worker and send the internal start (model resolved by the host). */
  async startThread(
    cmd: { id?: string; cwd?: string; trusted?: boolean },
    model: SessionModel | undefined,
  ): Promise<void> {
    if (this.rejectOverBudget(cmd.id, "thread/start")) return;
    const worker = this.spawnWorker(cmd.trusted === true);
    if (this.overBudget()) {
      // A concurrent start took the last slot while this worker spawned
      // (this spawn now counts itself). Exactly maxThreads survive.
      await this.killWorker(worker, "stop");
      this.rejectOverBudget(cmd.id, "thread/start");
      return;
    }
    const line = JSON.stringify({
      type: "thread/start",
      cwd: cmd.cwd ?? process.cwd(),
      trusted: cmd.trusted === true,
      ...(model !== undefined ? { model } : {}),
      ...(cmd.id !== undefined ? { id: cmd.id } : {}),
    });
    await this.deliverCommand({ worker, id: cmd.id, command: "thread/start", line });
  }

  /** thread/resume: claim the session path (spawning counts as occupied), then spawn. */
  async resumeThread(cmd: {
    id?: string;
    sessionPath: string;
    cwd?: string;
    trusted?: boolean;
  }): Promise<void> {
    const sessionPath = resolvePath(cmd.sessionPath);
    const holder = await this.settledHolder(sessionPath);
    if (holder !== undefined) {
      this.failure(
        cmd.id,
        "thread/resume",
        `Session already open (threadId: ${holder.threadId}); two writers would corrupt the session file`,
      );
      return;
    }
    if (this.rejectOverBudget(cmd.id, "thread/resume")) return;
    this.table.deleteNonLiveByPath(sessionPath);
    const worker = this.spawnWorker(cmd.trusted === true);
    if (this.table.holder(sessionPath, this.allWorkers) !== undefined || this.overBudget()) {
      await this.killWorker(worker, "stop");
      this.failure(
        cmd.id,
        "thread/resume",
        "Session already open in another conversation; two writers would corrupt the session file",
      );
      return;
    }
    this.table.occupy(worker, sessionPath);
    const line = JSON.stringify({
      type: "thread/resume",
      sessionPath,
      ...(cmd.cwd !== undefined ? { cwd: cmd.cwd } : {}),
      trusted: cmd.trusted === true,
      ...(cmd.id !== undefined ? { id: cmd.id } : {}),
    });
    await this.deliverCommand({ worker, id: cmd.id, command: "thread/resume", line });
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
    const entry = this.table.entry(threadId);
    if (entry === undefined) {
      // Idempotent: stopping an unknown thread succeeds silently (v0.3).
      this.ackStop(cmdId, cmdType);
      return;
    }
    if (entry.state !== "live") {
      this.stopNonLiveEntry(entry);
      this.ackStop(cmdId, cmdType);
      return;
    }
    const worker = this.table.liveWorker(threadId);
    if (worker === undefined) {
      this.table.delete(threadId);
      this.ackStop(cmdId, cmdType);
      return;
    }
    if (worker.retiring) {
      // Retirement in flight: repurpose it — close will drop the entry.
      worker.retireIntent = "stop";
      this.ackStop(cmdId, cmdType);
      return;
    }
    worker.retireIntent = "stop";
    const line = JSON.stringify({
      type: "thread/stop",
      threadId,
      ...(cmdId !== undefined ? { id: cmdId } : {}),
    });
    void this.deliverCommand({ worker, id: cmdId, command: "thread/stop", line });
  }

  /** ui_response: ack once in the host, broadcast to every live worker (the
   * owner resolves by requestId; the rest ignore it). No per-dialog state. */
  broadcastUiResponse(cmd: UiResponseCmd): void {
    const payload = JSON.stringify({
      type: "ui_response",
      requestId: cmd.requestId,
      payload: cmd.payload,
    });
    for (const worker of this.liveWorkers()) {
      const id = this.registerInternal(worker, {
        onResponse: () => {},
        onClosed: () => {},
      });
      void worker.writeLine(payload.replace(/^\{/, `{"id":"${id}",`)).catch(() => {
        this.internalIds.delete(id);
        worker.internalIds.delete(id);
      });
    }
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
    await this.awaitCloses(workers);
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

  private async awaitCloses(workers: WorkerHandle[]): Promise<void> {
    const timeout = new Promise<void>((done) => {
      setTimeout(done, this.workerExitTimeoutMs);
    });
    await Promise.race([Promise.allSettled(workers.map((worker) => worker.closed)), timeout]);
  }

  private ackStop(cmdId: string | undefined, cmdType: string): void {
    this.emitFrame({ type: "response", id: cmdId, command: cmdType, success: true });
  }

  private stopNonLiveEntry(entry: {
    threadId: string;
    wake: Promise<void> | undefined;
    stopRequested: boolean;
  }): void {
    if (entry.wake === undefined) {
      this.table.delete(entry.threadId);
      return;
    }
    // A wake is respawning this thread right now (design §6 spawning -
    // thread/stop edge): mark it so the wake lands on a stopped thread,
    // tears its worker down, and drops the re-registered entry instead
    // of resurrecting it.
    entry.stopRequested = true;
    void entry.wake.catch(() => {}).finally(() => this.table.delete(entry.threadId));
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

  private liveBudgetExceeded(): boolean {
    let spawning = 0;
    for (const worker of this.allWorkers) {
      if (worker.awaitingStart) spawning++;
    }
    return this.table.liveCount() + spawning >= this.maxThreads;
  }

  /** Post-spawn check: the caller's own spawn now counts itself, so the
   * budget is only violated when total EXCEEDS the cap (a spawn landing on
   * the exact last slot is legitimate — the off-by-one would otherwise make
   * PAI_MAX_THREADS=N an effective N-1, and N=1 unusable). */
  private overBudget(): boolean {
    let spawning = 0;
    for (const worker of this.allWorkers) {
      if (worker.awaitingStart) spawning++;
    }
    return this.table.liveCount() + spawning > this.maxThreads;
  }

  private failure(id: string | undefined, command: string, error: string): void {
    this.emitFrame({ type: "response", id, command, success: false, error });
  }

  private deliveryErrorMessage(error: unknown): string {
    return `worker died: command could not be delivered (${error instanceof Error ? error.message : String(error)})`;
  }

  private registerInternal(worker: WorkerHandle, waiter: InternalWaiter): string {
    this.internalSeq += 1;
    const id = `${INTERNAL_ID_PREFIX}${this.internalSeq}`;
    this.internalIds.set(id, waiter);
    worker.internalIds.add(id);
    return id;
  }

  private ensureAwake(entry: WakeEntry & { wake: Promise<void> | undefined }): Promise<void> {
    if (entry.wake !== undefined) return entry.wake;
    const wake = this.doWake(entry).finally(() => {
      const current = this.table.entry(entry.threadId);
      if (current !== undefined) current.wake = undefined;
    });
    const current = this.table.entry(entry.threadId);
    if (current !== undefined) current.wake = wake;
    return wake;
  }

  private async doWake(entry: WakeEntry): Promise<void> {
    if (entry.sessionPath === null) {
      throw new Error("Cannot wake thread: session was never persisted");
    }
    if (this.liveBudgetExceeded()) {
      throw new Error(`Too many concurrent conversations (limit ${this.maxThreads})`);
    }
    const sessionPath = resolvePath(entry.sessionPath);
    const holder = await this.settledHolder(sessionPath);
    if (holder !== undefined) {
      throw new Error(
        `Session already open (threadId: ${holder.threadId}); two writers would corrupt the session file`,
      );
    }
    const worker = this.spawnWorker(entry.trusted);
    if (this.table.holder(sessionPath, this.allWorkers) !== undefined || this.overBudget()) {
      await this.killWorker(worker, "stop");
      throw new Error("Session already open in another conversation");
    }
    this.table.occupy(worker, sessionPath);
    await this.resumeAndWait(worker, entry, sessionPath);
    // The absorbed resume response already registered the live entry —
    // unless thread/stop raced the wake (design §6 spawning -thread/stop
    // edge): tear the respawned worker down and drop the entry instead of
    // resurrecting a stopped conversation.
    const settled = this.table.entry(entry.threadId);
    if (settled !== undefined && settled.stopRequested) {
      const spawned = this.table.liveWorker(settled.threadId);
      this.table.delete(settled.threadId);
      if (spawned !== undefined) await this.killWorker(spawned, "stop");
    }
  }

  /** Send the internal resume and settle when the absorbed response lands
   * (or the worker dies / the write fails). */
  private async resumeAndWait(
    worker: WorkerHandle,
    entry: WakeEntry,
    sessionPath: string,
  ): Promise<void> {
    const forget = (id: string): void => {
      this.internalIds.delete(id);
      worker.internalIds.delete(id);
    };
    try {
      await new Promise<void>((done, refuse) => {
        const id = this.registerInternal(worker, {
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
              sessionPath,
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
      this.releaseOccupancy(worker, sessionPath);
      this.markDead(entry.threadId);
      // Idempotent cleanup: the response handler (failed resume) or close
      // (death) already did most of this; make sure no worker survives.
      await this.killWorker(worker, "stop").catch(() => {});
      throw error instanceof Error ? error : new Error(String(error));
    }
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

  /**
   * Path-occupancy lookup that first waits out a worker still releasing the
   * path: thread/stop is acknowledged before the worker closes (the response
   * rides ahead of the EOF), so an immediate resume of the same path must
   * wait for that close instead of reporting the thread's own stopping
   * worker as a conflict. Bounded: a wedged shutdown (worker alive but never
   * exiting) is force-closed via killWorker — resume must never become a
   * permanently unanswered command.
   */
  private async settledHolder(sessionPath: string): Promise<WorkerHandle | undefined> {
    for (;;) {
      const holder = this.table.holder(sessionPath, this.allWorkers);
      if (holder === undefined || !holder.retiring) return holder;
      await this.killWorker(holder, holder.retireIntent === "none" ? "stop" : holder.retireIntent);
    }
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
  }

  private sweepWorkers(): void {
    const now = Date.now();
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
    };
  }

  private spawnWorker(trusted: boolean): WorkerHandle {
    const relay = this.frameRelayDeps();
    const worker = spawnWorkerProcess({
      trusted,
      spawnTimeoutMs: this.workerExitTimeoutMs,
      onLine: (line) => onWorkerLine(relay, worker, line),
      onViolation: () => void this.killWorker(worker, "none"),
      onClosed: (code, signal) => this.onWorkerClosed(worker, code, signal),
      writeStderr: this.writeStderr,
    });
    this.allWorkers.add(worker);
    return worker;
  }

  private onWorkerClosed(worker: WorkerHandle, code: number | null, signal: string | null): void {
    this.allWorkers.delete(worker);
    if (worker.threadId !== "" && this.table.liveWorker(worker.threadId) === worker) {
      this.table.removeLive(worker.threadId);
    }
    this.table.reoccupy(worker, null);
    for (const id of worker.internalIds) {
      const waiter = this.internalIds.get(id);
      this.internalIds.delete(id);
      waiter?.onClosed();
    }
    worker.internalIds.clear();
    this.settleClosedWorker(worker, this.closeReason(worker, code, signal));
  }

  private closeReason(worker: WorkerHandle, code: number | null, signal: string | null): string {
    if (worker.retireIntent === "none" && worker.awaitingStart) {
      return worker.spawnError !== undefined
        ? `Worker failed to start: ${worker.spawnError}`
        : `Worker failed to start within ${this.workerExitTimeoutMs}ms`;
    }
    return `worker exited (code: ${String(code)}, signal: ${String(signal)})`;
  }

  private settleClosedWorker(worker: WorkerHandle, reason: string): void {
    const wasRetire = worker.retireIntent === "retire";
    const wasStop = worker.retireIntent === "stop";
    const wasShutdown = worker.retireIntent === "shutdown";
    const spawnTimeout =
      worker.retireIntent === "none" && worker.awaitingStart && worker.spawnError === undefined;
    if (!wasShutdown) {
      for (const [id, command] of worker.pendingIds) {
        // Responses already seen were removed from pendingIds; what remains
        // never got its exactly-one response. Spawn timeouts use the bare
        // documented message (design §2), without the "worker died" prefix.
        this.failure(id, command, spawnTimeout ? reason : `worker died: ${reason}`);
      }
    }
    worker.pendingIds.clear();
    const entry = worker.threadId !== "" ? this.table.entry(worker.threadId) : undefined;
    if (wasStop || wasShutdown) {
      if (entry !== undefined) this.table.delete(worker.threadId);
      return;
    }
    if (entry === undefined) return;
    entry.state = wasRetire ? "parked" : "dead";
    entry.wake = undefined;
    entry.sessionPath = worker.sessionPath ?? entry.sessionPath;
    this.table.enforceNonLiveCap();
    if (!wasRetire) {
      this.emitFrame({ type: "thread_died", threadId: worker.threadId, reason });
    }
  }
}
