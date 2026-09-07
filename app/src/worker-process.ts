/**
 * Worker process mechanics: spawn a `pai --internal-worker` child, wire its
 * stdio (serialized stdin writes, stdout frame splitter, stderr forwarding),
 * and expose the mutable WorkerHandle the pool orchestrates. No routing
 * knowledge lives here.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createJsonlSplitter, WORKER_LINE_BYTES } from "./jsonl.ts";
import { WORKER_FLAG } from "./protocol.ts";

export type RetireIntent = "none" | "retire" | "stop" | "shutdown";

export interface WorkerStdin {
  end: () => void;
  write: (chunk: string, cb?: (error?: Error | null) => void) => boolean;
}

export interface WorkerHandle {
  child: ChildProcess;
  stdin: WorkerStdin;
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

/** Serialized stdin writer: one line at a time, in invocation order. */
function createLineWriter(stdin: WorkerStdin): (line: string) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (line: string): Promise<void> => {
    const attempt = (): Promise<void> =>
      new Promise<void>((writeResolve, writeReject) => {
        stdin.write(`${line}\n`, (error) => {
          if (error) writeReject(error);
          else writeResolve();
        });
      });
    const previous = tail;
    tail = previous.then(attempt, attempt);
    return tail;
  };
}

/** Handle for a spawn whose pipes could not be set up: it can only close. */
function makeFailedSpawnHandle(child: ChildProcess, reason: string): WorkerHandle {
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
    child.on("close", () => {
      closeResolve();
    });
  });
  return dead;
}

function workerLabel(worker: WorkerHandle, pid: number | undefined): string {
  return worker.threadId !== "" ? worker.threadId : String(pid ?? "?");
}

/** Wire stdout/stderr splitters and stream error swallows (close handles it). */
function attachWorkerStreams(deps: {
  child: ChildProcess;
  worker: WorkerHandle;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  onLine: (line: string) => void;
  onViolation: (reason: string) => void;
  writeStderr: (text: string) => void;
}): void {
  const { child, worker, stdin, stdout, stderr, onLine, onViolation, writeStderr } = deps;
  const label = (): string => workerLabel(worker, child.pid);
  stdin.on("error", () => {});
  stdout.on("error", () => {});
  stderr.on("error", () => {});

  const stdoutSplitter = createJsonlSplitter(
    (line) => {
      try {
        onLine(line);
      } catch {
        writeStderr(
          `pai-cli worker sent a malformed frame (threadId: ${label()}); killing worker\n`,
        );
        onViolation("malformed frame");
      }
    },
    (limit) => {
      writeStderr(
        `pai-cli worker frame exceeded ${limit} bytes (threadId: ${label()}); killing worker\n`,
      );
      onViolation("oversized frame");
    },
    WORKER_LINE_BYTES,
  );
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => stdoutSplitter.push(chunk));

  const stderrSplitter = createJsonlSplitter(
    (line) => {
      writeStderr(`[pai:worker:${label()}] ${line}\n`);
    },
    (limit) => {
      writeStderr(`[pai:worker:${label()}] stderr line exceeded ${limit} bytes and was dropped\n`);
    },
    WORKER_LINE_BYTES,
  );
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => stderrSplitter.push(chunk));
}

export interface SpawnWorkerDeps {
  trusted: boolean;
  /** Spawn-to-first-response budget; the pool kills past it (design §8). */
  spawnTimeoutMs: number;
  onLine: (line: string) => void;
  /** Malformed/oversized frame: caller kills the worker. */
  onViolation: (reason: string) => void;
  onClosed: (code: number | null, signal: string | null) => void;
  writeStderr: (text: string) => void;
}

/** Spawn one worker process and return its handle (resolved synchronously —
 * node buffers stdin/stdout until listeners attach). */
export function spawnWorkerProcess(deps: SpawnWorkerDeps): WorkerHandle {
  const { command, args } = workerSpawnArgs(process.argv[1], process.execPath);
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    cwd: process.cwd(),
  });
  const { stdin } = child;
  const { stdout } = child;
  const { stderr } = child;
  if (stdin === null || stdout === null || stderr === null) {
    child.kill("SIGKILL");
    return makeFailedSpawnHandle(child, "worker stdio pipes unavailable");
  }

  const worker = makeWorkerHandle({
    child,
    stdin,
    trusted: deps.trusted,
    spawnTimeoutMs: deps.spawnTimeoutMs,
    onClosed: deps.onClosed,
  });
  attachWorkerStreams({
    child,
    worker,
    stdin,
    stdout,
    stderr,
    onLine: deps.onLine,
    onViolation: deps.onViolation,
    writeStderr: deps.writeStderr,
  });
  return worker;
}

function makeWorkerHandle(deps: {
  child: ChildProcess;
  stdin: WorkerStdin;
  trusted: boolean;
  spawnTimeoutMs: number;
  onClosed: (code: number | null, signal: string | null) => void;
}): WorkerHandle {
  const worker: WorkerHandle = {
    child: deps.child,
    stdin: deps.stdin,
    threadId: "",
    trusted: deps.trusted,
    writeLine: createLineWriter(deps.stdin),
    closed: Promise.resolve(),
    retireIntent: "none",
    retiring: false,
    awaitingStart: true,
    spawnDeadline: Date.now() + deps.spawnTimeoutMs,
    spawnError: undefined,
    lastHeartbeatAt: Date.now(),
    idleMs: 0,
    streaming: false,
    sessionPath: null,
    pendingIds: new Map<string, string>(),
    internalIds: new Set<string>(),
  };
  worker.closed = new Promise<void>((closeResolve) => {
    deps.child.on("close", (code, signal) => {
      deps.onClosed(code, signal);
      closeResolve();
    });
  });
  deps.child.on("error", (error) => {
    worker.spawnError = error instanceof Error ? error.message : String(error);
  });
  return worker;
}
