/**
 * Worker process pool: one worker process per live conversation
 * (design.md migration §1/§6). Owns the routing table (external threadId =
 * worker sessionId), cross-process session-path occupancy (spawning counts
 * as occupied), the retire/wake/death state machine, and worker frame
 * forwarding. The pool never imports pi runtime APIs — it manages processes
 * and frames only.
 *
 * Termination contract (design §6): every worker termination is processed
 * from the child `close` event (stdio drained), never from `exit`; pending
 * routed commands are reconciled against responses already seen and only
 * the missing ones get a synthesized failure.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createJsonlSplitter, WORKER_LINE_BYTES } from "./jsonl.ts";
import {
  type HubFrame,
  INTERNAL_ID_PREFIX,
  type SessionModel,
  type ThreadListEntry,
  type UiResponseCmd,
  WORKER_FLAG,
  type WorkerHeartbeatFrame,
} from "./protocol.ts";

export const MAX_THREADS_DEFAULT = 32;
export const IDLE_RETIRE_MS_DEFAULT = 900_000;
export const WORKER_STALE_MS_DEFAULT = 30_000;
export const WORKER_EXIT_TIMEOUT_MS_DEFAULT = 10_000;
const NON_LIVE_ENTRY_CAP = 1024;
const STALE_SIGKILL_GRACE_MS = 2_000;
const SWEEP_INTERVAL_MS = 1_000;

type RetireIntent = "none" | "retire" | "stop" | "shutdown";

interface ThreadEntry {
  threadId: string;
  cwd: string;
  sessionPath: string | null;
  trusted: boolean;
  state: "live" | "parked" | "dead";
  /** In-progress respawn (parked/dead -> live); concurrent senders share it. */
  wake: Promise<void> | undefined;
}

interface InternalWaiter {
  onResponse: (frame: Record<string, unknown>) => void;
  onClosed: () => void;
}

interface WorkerHandle {
  child: ChildProcess;
  stdin: {
    end: () => void;
    write: (chunk: string, cb?: (error?: Error | null) => void) => boolean;
  };
  /** Current session id; changes on fork/clone. Empty before first response. */
  threadId: string;
  trusted: boolean;
  writeLine: (line: string) => Promise<void>;
  closed: Promise<void>;
  retireIntent: RetireIntent;
  retiring: boolean;
  /** True until the first start/resume response lands (spawn timeout window). */
  awaitingStart: boolean;
  spawnDeadline: number;
  spawnError: string | undefined;
  lastHeartbeatAt: number;
  idleMs: number;
  streaming: boolean;
  sessionPath: string | null;
  /** Routed command ids awaiting a response (id -> command), reconciled at close. */
  readonly pendingIds: Map<string, string>;
  /** Internal ids issued to this worker (broadcast acks, wake resumes). */
  readonly internalIds: Set<string>;
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

/**
 * Response frames serialize as {"id":"…","type":"response","command":"…",…}
 * (id first when present). Giant data responses are classified by this
 * strict head match (no escapes inside the id) instead of a full parse;
 * anything the regex cannot match exactly falls back to JSON.parse. The
 * key order is asserted by unit test to match the worker's literals.
 */
const RESPONSE_HEAD_WITH_ID = /^\{"id":"([^"\\]*)","type":"response","command":"([^"\\]*)"/;
const RESPONSE_HEAD_NO_ID = /^\{"type":"response","command":"([^"\\]*)"/;

export interface ResponseHead {
  id: string | undefined;
  command: string;
}

/** Returns undefined for lines that are not response frames, null for
 * response frames the strict head match cannot classify. */
export function matchResponseHead(line: string): ResponseHead | undefined | null {
  if (line.startsWith('{"id":"')) {
    const match = RESPONSE_HEAD_WITH_ID.exec(line);
    if (match) return { id: match[1] ?? "", command: match[2] ?? "" };
    return null;
  }
  if (line.startsWith('{"type":"response"')) {
    const match = RESPONSE_HEAD_NO_ID.exec(line);
    if (match) return { id: undefined, command: match[1] ?? "" };
    return null;
  }
  return undefined;
}

const CONTROL_COMMANDS: ReadonlySet<string> = new Set([
  "thread/start",
  "thread/resume",
  "thread/stop",
  "fork",
  "clone",
]);

interface SpawnArgsResult {
  command: string;
  args: string[];
}

/**
 * Worker self-arguments for the three launch forms (design §7, bun 1.4.2
 * measured): script form (argv[1] exists on disk) re-invokes the runtime
 * with the script; compiled form (argv[1] is a /$bunfs virtual path) runs
 * the binary itself.
 */
export function workerSpawnArgs(argv1: string | undefined, execPath: string): SpawnArgsResult {
  if (argv1 !== undefined && argv1 !== execPath && existsSync(argv1)) {
    return { command: execPath, args: [argv1, WORKER_FLAG] };
  }
  return { command: execPath, args: [WORKER_FLAG] };
}

interface StartResponseData {
  threadId: string;
  cwd: string;
  sessionPath: string | null;
}

interface ForkResponseData {
  threadId: string;
  previousThreadId: string;
  sessionPath: string | null;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export class WorkerPool {
  private readonly entries = new Map<string, ThreadEntry>();
  private readonly workers = new Map<string, WorkerHandle>(); // live threadId -> worker
  private readonly occupiedPaths = new Map<string, WorkerHandle>(); // resolved path -> worker
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
    return [...this.entries.values()].map((entry) => ({
      threadId: entry.threadId,
      cwd: entry.cwd,
      sessionPath: entry.sessionPath,
      isStreaming:
        entry.state === "live" ? (this.workers.get(entry.threadId)?.streaming ?? false) : false,
      state: entry.state,
    }));
  }

  hasThread(threadId: string): boolean {
    return this.entries.has(threadId);
  }

  liveCount(): number {
    return this.workers.size;
  }

  /** thread/start: spawn a worker and send the internal start (model resolved by the host). */
  async startThread(
    cmd: { id?: string; cwd?: string; trusted?: boolean },
    model: SessionModel | undefined,
  ): Promise<void> {
    if (this.liveBudgetExceeded()) {
      this.failure(
        cmd.id,
        "thread/start",
        `Too many concurrent conversations (limit ${this.maxThreads})`,
      );
      return;
    }
    const worker = await this.spawnWorker(cmd.trusted === true);
    if (this.liveBudgetExceeded()) {
      await this.killWorker(worker, "stop");
      this.failure(
        cmd.id,
        "thread/start",
        `Too many concurrent conversations (limit ${this.maxThreads})`,
      );
      return;
    }
    this.trackPending(worker, cmd.id, "thread/start");
    const line = JSON.stringify({
      type: "thread/start",
      cwd: cmd.cwd ?? process.cwd(),
      trusted: cmd.trusted === true,
      ...(model !== undefined ? { model } : {}),
      ...(cmd.id !== undefined ? { id: cmd.id } : {}),
    });
    try {
      await worker.writeLine(line);
    } catch (error) {
      this.untrackPending(worker, cmd.id);
      this.failure(cmd.id, "thread/start", this.deliveryErrorMessage(error));
    }
  }

  /** thread/resume: claim the session path (spawning counts as occupied), then spawn. */
  async resumeThread(cmd: {
    id?: string;
    sessionPath: string;
    cwd?: string;
    trusted?: boolean;
  }): Promise<void> {
    const sessionPath = resolve(cmd.sessionPath);
    const holder = this.occupiedPaths.get(sessionPath);
    if (holder !== undefined) {
      this.failure(
        cmd.id,
        "thread/resume",
        `Session already open (threadId: ${holder.threadId}); two writers would corrupt the session file`,
      );
      return;
    }
    if (this.liveBudgetExceeded()) {
      this.failure(
        cmd.id,
        "thread/resume",
        `Too many concurrent conversations (limit ${this.maxThreads})`,
      );
      return;
    }
    // A parked/dead entry for the same file is being replaced, not duplicated.
    this.dropNonLiveEntryByPath(sessionPath);
    const worker = await this.spawnWorker(cmd.trusted === true);
    if (this.occupiedPaths.has(sessionPath) || this.liveBudgetExceeded()) {
      await this.killWorker(worker, "stop");
      this.failure(
        cmd.id,
        "thread/resume",
        "Session already open in another conversation; two writers would corrupt the session file",
      );
      return;
    }
    this.occupy(worker, sessionPath);
    this.trackPending(worker, cmd.id, "thread/resume");
    const line = JSON.stringify({
      type: "thread/resume",
      sessionPath,
      ...(cmd.cwd !== undefined ? { cwd: cmd.cwd } : {}),
      trusted: cmd.trusted === true,
      ...(cmd.id !== undefined ? { id: cmd.id } : {}),
    });
    try {
      await worker.writeLine(line);
    } catch (error) {
      this.untrackPending(worker, cmd.id);
      this.failure(cmd.id, "thread/resume", this.deliveryErrorMessage(error));
    }
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
      const entry = this.entries.get(cmd.threadId);
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
      const worker = this.workers.get(cmd.threadId);
      if (worker === undefined) {
        // ensureAwake raced a death; its close handling already re-marked
        // the entry — re-evaluate.
        continue;
      }
      if (worker.retiring) {
        await worker.closed;
        continue;
      }
      this.trackPending(worker, cmd.id, cmd.type);
      try {
        await worker.writeLine(line);
      } catch {
        // Never delivered; close reconciliation will not see it.
        this.untrackPending(worker, cmd.id);
        this.failure(cmd.id, cmd.type, "worker died: command could not be delivered");
      }
      return;
    }
  }

  async stopThread(threadId: string, cmdId: string | undefined, cmdType: string): Promise<void> {
    const entry = this.entries.get(threadId);
    if (entry === undefined) {
      // Idempotent: stopping an unknown thread succeeds silently (v0.3).
      this.emitFrame({ type: "response", id: cmdId, command: cmdType, success: true });
      return;
    }
    if (entry.state !== "live") {
      this.entries.delete(threadId);
      this.emitFrame({ type: "response", id: cmdId, command: cmdType, success: true });
      return;
    }
    const worker = this.workers.get(threadId);
    if (worker === undefined) {
      this.entries.delete(threadId);
      this.emitFrame({ type: "response", id: cmdId, command: cmdType, success: true });
      return;
    }
    if (worker.retiring) {
      // Retirement in flight: repurpose it — close will drop the entry.
      worker.retireIntent = "stop";
      this.emitFrame({ type: "response", id: cmdId, command: cmdType, success: true });
      return;
    }
    worker.retireIntent = "stop";
    this.trackPending(worker, cmdId, "thread/stop");
    try {
      await worker.writeLine(
        JSON.stringify({
          type: "thread/stop",
          threadId,
          ...(cmdId !== undefined ? { id: cmdId } : {}),
        }),
      );
    } catch {
      this.untrackPending(worker, cmdId);
      this.failure(cmdId, cmdType, "worker died: command could not be delivered");
    }
  }

  /** ui_response: ack once in the host, broadcast to every live worker (the
   * owner resolves by requestId; the rest ignore it). No per-dialog state. */
  broadcastUiResponse(cmd: UiResponseCmd): void {
    const payload = JSON.stringify({
      type: "ui_response",
      requestId: cmd.requestId,
      payload: cmd.payload,
    });
    for (const worker of this.workers.values()) {
      if (worker.retiring) continue;
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
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, this.workerExitTimeoutMs));
    await Promise.race([Promise.allSettled(workers.map((w) => w.closed)), timeout]);
    for (const worker of this.allWorkers) {
      if (!worker.child.killed) worker.child.kill("SIGKILL");
    }
    await Promise.allSettled([...this.allWorkers].map((w) => w.closed));
  }

  // --- internals ------------------------------------------------------------

  private liveBudgetExceeded(): boolean {
    let spawning = 0;
    for (const worker of this.allWorkers) {
      if (worker.awaitingStart) spawning++;
    }
    return this.workers.size + spawning >= this.maxThreads;
  }

  private failure(id: string | undefined, command: string, error: string): void {
    this.emitFrame({ type: "response", id, command, success: false, error });
  }

  private deliveryErrorMessage(error: unknown): string {
    return `worker died: command could not be delivered (${error instanceof Error ? error.message : String(error)})`;
  }

  private trackPending(worker: WorkerHandle, id: string | undefined, command: string): void {
    if (id !== undefined) worker.pendingIds.set(id, command);
  }

  private untrackPending(worker: WorkerHandle, id: string | undefined): void {
    if (id !== undefined) worker.pendingIds.delete(id);
  }

  private registerInternal(worker: WorkerHandle, waiter: InternalWaiter): string {
    this.internalSeq += 1;
    const id = `${INTERNAL_ID_PREFIX}${this.internalSeq}`;
    this.internalIds.set(id, waiter);
    worker.internalIds.add(id);
    return id;
  }

  private dropNonLiveEntryByPath(sessionPath: string): void {
    for (const entry of this.entries.values()) {
      if (
        entry.state !== "live" &&
        entry.sessionPath !== null &&
        resolve(entry.sessionPath) === sessionPath
      ) {
        this.entries.delete(entry.threadId);
      }
    }
  }

  private occupy(worker: WorkerHandle, path: string): void {
    worker.sessionPath = path;
    this.occupiedPaths.set(resolve(path), worker);
  }

  /** Move the worker's path occupancy to `path` (null = release only). */
  private reoccupy(worker: WorkerHandle, path: string | null): void {
    if (worker.sessionPath !== null) {
      const resolved = resolve(worker.sessionPath);
      if (this.occupiedPaths.get(resolved) === worker) this.occupiedPaths.delete(resolved);
    }
    if (path !== null) this.occupy(worker, path);
    else worker.sessionPath = null;
  }

  private enforceNonLiveCap(): void {
    let nonLive = 0;
    for (const entry of this.entries.values()) {
      if (entry.state !== "live") nonLive++;
    }
    while (nonLive > NON_LIVE_ENTRY_CAP) {
      let evicted = false;
      for (const entry of this.entries.values()) {
        if (entry.state !== "live") {
          this.entries.delete(entry.threadId);
          nonLive--;
          evicted = true;
          break;
        }
      }
      if (!evicted) break;
    }
  }

  private ensureAwake(entry: ThreadEntry): Promise<void> {
    if (entry.wake !== undefined) return entry.wake;
    const wake = this.doWake(entry).finally(() => {
      entry.wake = undefined;
    });
    entry.wake = wake;
    return wake;
  }

  private async doWake(entry: ThreadEntry): Promise<void> {
    if (entry.sessionPath === null) {
      throw new Error("Cannot wake thread: session was never persisted");
    }
    if (this.liveBudgetExceeded()) {
      throw new Error(`Too many concurrent conversations (limit ${this.maxThreads})`);
    }
    const sessionPath = resolve(entry.sessionPath);
    const holder = this.occupiedPaths.get(sessionPath);
    if (holder !== undefined) {
      throw new Error(
        `Session already open (threadId: ${holder.threadId}); two writers would corrupt the session file`,
      );
    }
    const worker = await this.spawnWorker(entry.trusted);
    if (this.occupiedPaths.has(sessionPath) || this.liveBudgetExceeded()) {
      await this.killWorker(worker, "stop");
      throw new Error("Session already open in another conversation");
    }
    this.occupy(worker, sessionPath);
    try {
      await new Promise<void>((resolve, reject) => {
        const id = this.registerInternal(worker, {
          onResponse: (frame) => {
            this.internalIds.delete(id);
            worker.internalIds.delete(id);
            if (frame["success"] === true) resolve();
            else reject(new Error(String(frame["error"] ?? "resume failed")));
          },
          onClosed: () => {
            this.internalIds.delete(id);
            worker.internalIds.delete(id);
            reject(new Error("worker died while resuming"));
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
            this.internalIds.delete(id);
            worker.internalIds.delete(id);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      });
    } catch (error) {
      if (this.occupiedPaths.get(sessionPath) === worker) this.occupiedPaths.delete(sessionPath);
      entry.state = "dead";
      // Idempotent cleanup: the response handler (failed resume) or close
      // (death) already did most of this; make sure no worker survives.
      await this.killWorker(worker, "stop").catch(() => {});
      throw error instanceof Error ? error : new Error(String(error));
    }
    // The absorbed resume response already registered the live entry.
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
      if (!this.workers.has(worker.threadId)) continue; // not live yet
      if (now - worker.lastHeartbeatAt > this.workerStaleMs) {
        void this.killWorker(worker, "none");
        continue;
      }
      if (!worker.retiring && worker.idleMs >= this.idleRetireMs && worker.sessionPath !== null) {
        this.retire(worker);
      }
    }
  }

  private spawnWorker(trusted: boolean): Promise<WorkerHandle> {
    return new Promise((resolve) => {
      const { command, args } = workerSpawnArgs(process.argv[1], process.execPath);
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        cwd: process.cwd(),
      });
      const stdin = child.stdin;
      const stdout = child.stdout;
      const stderr = child.stderr;
      if (stdin === null || stdout === null || stderr === null) {
        child.kill("SIGKILL");
        resolve(this.makeFailedSpawnHandle(child, "worker stdio pipes unavailable"));
        return;
      }

      let stdinTail: Promise<void> = Promise.resolve();
      const writeLine = (line: string): Promise<void> => {
        const attempt = (): Promise<void> =>
          new Promise<void>((writeResolve, writeReject) => {
            stdin.write(`${line}\n`, (error) => {
              if (error) writeReject(error);
              else writeResolve();
            });
          });
        const previous = stdinTail;
        stdinTail = previous.then(attempt, attempt);
        return stdinTail;
      };

      const worker: WorkerHandle = {
        child,
        stdin,
        threadId: "",
        trusted,
        writeLine,
        closed: Promise.resolve(),
        retireIntent: "none",
        retiring: false,
        awaitingStart: true,
        spawnDeadline: Date.now() + this.workerExitTimeoutMs,
        spawnError: undefined,
        lastHeartbeatAt: Date.now(),
        idleMs: 0,
        streaming: false,
        sessionPath: null,
        pendingIds: new Map<string, string>(),
        internalIds: new Set<string>(),
      };
      this.allWorkers.add(worker);
      worker.closed = new Promise<void>((closeResolve) => {
        child.on("close", (code, signal) => {
          this.onWorkerClosed(worker, code, signal);
          closeResolve();
        });
      });
      child.on("error", (error) => {
        worker.spawnError = error instanceof Error ? error.message : String(error);
      });
      stdin.on("error", () => {});
      stdout.on("error", () => {});
      stderr.on("error", () => {});

      const stdoutSplitter = createJsonlSplitter(
        (line) => {
          try {
            this.onWorkerLine(worker, line);
          } catch {
            this.writeStderr(
              `pai-cli worker sent a malformed frame (threadId: ${worker.threadId || "unassigned"}); killing worker\n`,
            );
            void this.killWorker(worker, "none");
          }
        },
        (limit) => {
          this.writeStderr(
            `pai-cli worker frame exceeded ${limit} bytes (threadId: ${worker.threadId || "unassigned"}); killing worker\n`,
          );
          void this.killWorker(worker, "none");
        },
        WORKER_LINE_BYTES,
      );
      stdout.setEncoding("utf8");
      stdout.on("data", (chunk: string) => stdoutSplitter.push(chunk));

      const stderrSplitter = createJsonlSplitter(
        (line) => {
          const name = worker.threadId !== "" ? worker.threadId : String(child.pid ?? "?");
          this.writeStderr(`[pai:worker:${name}] ${line}\n`);
        },
        undefined,
        WORKER_LINE_BYTES,
      );
      stderr.setEncoding("utf8");
      stderr.on("data", (chunk: string) => stderrSplitter.push(chunk));

      resolve(worker);
    });
  }

  /** Handle for a spawn whose pipes could not be set up: it can only close. */
  private makeFailedSpawnHandle(child: ChildProcess, reason: string): WorkerHandle {
    const dead: WorkerHandle = {
      child,
      stdin: {
        end: () => {},
        write: (_chunk: string, cb?: (e?: Error | null) => void) => {
          cb?.(new Error(reason));
          return false;
        },
      },
      threadId: "",
      trusted: false,
      writeLine: () => Promise.reject(new Error(reason)),
      closed: Promise.resolve(),
      retireIntent: "shutdown",
      retiring: true,
      awaitingStart: true,
      spawnDeadline: 0,
      spawnError: reason,
      lastHeartbeatAt: Date.now(),
      idleMs: 0,
      streaming: false,
      sessionPath: null,
      pendingIds: new Map<string, string>(),
      internalIds: new Set<string>(),
    };
    dead.closed = new Promise<void>((closeResolve) => {
      child.on("close", () => closeResolve());
    });
    return dead;
  }

  private onWorkerLine(worker: WorkerHandle, line: string): void {
    if (line.startsWith('{"type":"heartbeat"')) {
      const frame = JSON.parse(line) as WorkerHeartbeatFrame;
      worker.lastHeartbeatAt = Date.now();
      worker.idleMs = frame.idleMs;
      worker.streaming = frame.streaming;
      if (frame.sessionPath !== worker.sessionPath) {
        // First persist, or a fork/clone path change: keep occupancy exact.
        this.reoccupy(worker, frame.sessionPath);
      }
      return;
    }
    if (line.startsWith('{"type":"event"') || line.startsWith('{"type":"ui_request"')) {
      this.emitRaw(line);
      return;
    }
    if (line.startsWith('{"type":"hub_error"')) {
      const frame = JSON.parse(line) as { type: "hub_error"; scope: string; error: string };
      this.emitFrame({
        type: "hub_error",
        ...(worker.threadId !== "" ? { threadId: worker.threadId } : {}),
        scope: frame.scope,
        error: frame.error,
      });
      return;
    }
    const head = matchResponseHead(line);
    if (head !== undefined) {
      this.onWorkerResponse(worker, line, head);
      return;
    }
    this.writeStderr(`pai-cli worker sent an unclassified frame; ignored: ${line.slice(0, 200)}\n`);
  }

  private onWorkerResponse(worker: WorkerHandle, line: string, head: ResponseHead | null): void {
    let resolvedHead: ResponseHead;
    let frame: { id?: string; command?: string; success?: boolean; data?: Record<string, unknown> };
    if (head === null) {
      // Strict head match failed (escaped id or unusual shape): parse fully.
      frame = JSON.parse(line) as typeof frame;
      resolvedHead = {
        id: typeof frame.id === "string" ? frame.id : undefined,
        command: typeof frame.command === "string" ? frame.command : "",
      };
    } else {
      resolvedHead = head;
      frame = { id: resolvedHead.id, command: resolvedHead.command };
      if (CONTROL_COMMANDS.has(resolvedHead.command)) {
        const parsed = JSON.parse(line) as typeof frame;
        frame = parsed;
      }
    }
    const id = resolvedHead.id;
    const waiter = id !== undefined ? this.internalIds.get(id) : undefined;
    const isInternal = waiter !== undefined;
    if (id !== undefined && !isInternal) worker.pendingIds.delete(id);

    if (CONTROL_COMMANDS.has(resolvedHead.command)) {
      // Table updates run BEFORE the response is forwarded or the internal
      // waiter resolves (design §4: routing must be ready for the next
      // command the client sends against the response).
      if (frame.success === true && frame.data !== undefined) {
        this.applyControlResponse(worker, resolvedHead.command, frame.data);
      } else if (
        frame.success !== true &&
        (resolvedHead.command === "thread/start" || resolvedHead.command === "thread/resume")
      ) {
        // Initial start/resume failed: no conversation exists; reclaim the worker.
        void this.killWorker(worker, "stop");
      }
      if (resolvedHead.command === "thread/stop" && worker.retireIntent === "stop") {
        worker.retiring = true;
        worker.stdin.end();
      }
    }

    if (isInternal && waiter !== undefined) {
      this.internalIds.delete(id ?? "");
      worker.internalIds.delete(id ?? "");
      waiter.onResponse(frame as Record<string, unknown>);
      return;
    }
    this.emitRaw(line);
  }

  private applyControlResponse(
    worker: WorkerHandle,
    command: string,
    data: Record<string, unknown>,
  ): void {
    if (command === "thread/start" || command === "thread/resume") {
      const start = data as unknown as StartResponseData;
      if (typeof start.threadId !== "string" || typeof start.cwd !== "string") return;
      if (worker.threadId !== "" && worker.threadId !== start.threadId) {
        // Wake resumed to a different session id than parked: trust the response.
        this.writeStderr(
          `pai-cli worker resumed to a different session id (${worker.threadId} -> ${start.threadId})\n`,
        );
        this.entries.delete(worker.threadId);
        this.workers.delete(worker.threadId);
      }
      const entry: ThreadEntry = this.entries.get(start.threadId) ?? {
        threadId: start.threadId,
        cwd: start.cwd,
        sessionPath: start.sessionPath,
        trusted: worker.trusted,
        state: "live",
        wake: undefined,
      };
      entry.threadId = start.threadId;
      entry.cwd = start.cwd;
      entry.sessionPath = start.sessionPath;
      entry.trusted = worker.trusted;
      entry.state = "live";
      entry.wake = undefined;
      this.entries.set(start.threadId, entry);
      worker.threadId = start.threadId;
      this.workers.set(start.threadId, worker);
      worker.awaitingStart = false;
      this.reoccupy(worker, start.sessionPath);
      return;
    }
    if (command === "fork" || command === "clone") {
      const fork = data as unknown as ForkResponseData;
      if (
        typeof fork.threadId !== "string" ||
        typeof fork.previousThreadId !== "string" ||
        fork.threadId === fork.previousThreadId
      ) {
        return; // cancelled fork: ids equal, nothing re-keys
      }
      const entry = this.entries.get(fork.previousThreadId);
      if (entry !== undefined) {
        this.entries.delete(fork.previousThreadId);
        entry.threadId = fork.threadId;
        entry.sessionPath = fork.sessionPath;
        this.entries.set(fork.threadId, entry);
      }
      if (this.workers.get(fork.previousThreadId) === worker) {
        this.workers.delete(fork.previousThreadId);
        this.workers.set(fork.threadId, worker);
        worker.threadId = fork.threadId;
      }
      this.reoccupy(worker, fork.sessionPath);
    }
  }

  private onWorkerClosed(worker: WorkerHandle, code: number | null, signal: string | null): void {
    this.allWorkers.delete(worker);
    if (worker.threadId !== "") this.workers.delete(worker.threadId);
    this.reoccupy(worker, null);
    for (const id of worker.internalIds) {
      const waiter = this.internalIds.get(id);
      this.internalIds.delete(id);
      waiter?.onClosed();
    }
    worker.internalIds.clear();
    const wasRetire = worker.retireIntent === "retire";
    const wasStop = worker.retireIntent === "stop";
    const wasShutdown = worker.retireIntent === "shutdown";
    const reason =
      worker.retireIntent === "none" && worker.awaitingStart
        ? worker.spawnError !== undefined
          ? `Worker failed to start: ${worker.spawnError}`
          : `Worker failed to start within ${this.workerExitTimeoutMs}ms`
        : `worker exited (code: ${String(code)}, signal: ${String(signal)})`;
    if (!wasShutdown) {
      for (const [id, command] of worker.pendingIds) {
        // Responses already seen were removed from pendingIds; what remains
        // never got its exactly-one response.
        this.failure(id, command, `worker died: ${reason}`);
      }
    }
    worker.pendingIds.clear();
    const entry = worker.threadId !== "" ? this.entries.get(worker.threadId) : undefined;
    if (wasStop || wasShutdown) {
      if (entry !== undefined) this.entries.delete(worker.threadId);
    } else if (wasRetire) {
      if (entry !== undefined) {
        entry.state = "parked";
        entry.wake = undefined;
        entry.sessionPath = worker.sessionPath ?? entry.sessionPath;
        this.enforceNonLiveCap();
      }
    } else if (entry !== undefined) {
      entry.state = "dead";
      entry.wake = undefined;
      entry.sessionPath = worker.sessionPath ?? entry.sessionPath;
      this.enforceNonLiveCap();
      this.emitFrame({ type: "thread_died", threadId: worker.threadId, reason });
    }
  }
}
