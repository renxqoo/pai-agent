/**
 * pai-cli worker: one conversation per process (design.md migration §1).
 * Speaks the thread-scoped subset of the v0.3 protocol on stdin/stdout to
 * the pai-cli host; global commands (auth, models, thread listing) live in
 * the host. This file is bootstrap only — command behavior is in
 * worker-commands.ts; session lifecycle lives in the backend bundle
 * (backend/pi-coding-agent/session-adapter.ts for the default backend).
 */

import { capabilityError } from "./backend/capabilities.ts";
import { createWorkerBackend } from "./backend/index.ts";
import type { WorkerBackend } from "./backend/ports/backend.ts";
import type { PaiSessionHost } from "./backend/ports/session.ts";
import { DialogBroker } from "./dialogs.ts";
import { responseFailure, responseSuccess } from "./frames.ts";
import { createInflightRegistry } from "./inflight-registry.ts";
import { createJsonlSplitter } from "./jsonl.ts";
import { readNonNegativeIntEnv } from "./int-env.ts";
import type {
  HubFrame,
  WorkerCommand,
  WorkerGrantFrame,
  WorkerHeartbeatFrame,
} from "./protocol.ts";
import { OBSERVER_COMMANDS, WORKER_PROTOCOL_VERSION } from "./protocol.ts";
import { SubagentRegistry } from "./subagent-registry.ts";
import {
  createFrameWriter,
  getRawStdoutWrite,
  takeOverStdout,
  writeStderr,
} from "./stdout-guard.ts";
import { workerHandlers } from "./worker-commands.ts";
import type { WorkerContext } from "./worker-context.ts";
import type { InflightRegistry } from "./inflight-registry.ts";

const HEARTBEAT_INTERVAL_MS = 1_000;
/** v0.6 assembly defaults (env overrides parsed at use sites). */
const BASH_TIMEOUT_MS_DEFAULT = 600_000;
const GRANT_REQUEST_TIMEOUT_MS = 5_000;

function isCommandShape(message: unknown): message is WorkerCommand {
  return typeof message === "object" && message !== null && !Array.isArray(message);
}

interface WorkerRefs {
  broker?: DialogBroker;
  sessions?: PaiSessionHost;
}

interface WorkerStatus {
  /** Idle timer baseline: reset by non-observer commands and by activity
   * (streaming/compaction/dialogs/in-flight ops) on each heartbeat tick. */
  lastBusyAt: number;
}

/** Heartbeat carries the worker-side truth (design.md migration §3): the
 * host retires/kills workers from these fields and never guesses. */
function startHeartbeat(deps: {
  emit: (frame: WorkerHeartbeatFrame) => void;
  refs: WorkerRefs;
  registry: InflightRegistry;
  status: WorkerStatus;
  subagents: SubagentRegistry;
}): void {
  const { emit, refs, registry, status, subagents } = deps;
  const isBusy = (): boolean => {
    const session = refs.sessions?.get()?.session;
    return (
      session?.isStreaming === true ||
      session?.isCompacting === true ||
      (refs.broker?.pendingCount() ?? 0) > 0 ||
      registry.size() > 0 ||
      subagents.inFlight() > 0 ||
      subagents.pendingCount() > 0
    );
  };
  const heartbeat = setInterval(() => {
    if (isBusy()) status.lastBusyAt = Date.now();
    const session = refs.sessions?.get()?.session;
    emit({
      type: "heartbeat",
      idleMs: Date.now() - status.lastBusyAt,
      streaming: session?.isStreaming === true,
      sessionPath: session?.sessionFile ?? null,
      ...(subagents.inFlight() > 0 ? { subagents: subagents.inFlight() } : {}),
    });
  }, HEARTBEAT_INTERVAL_MS);
  process.on("exit", () => clearInterval(heartbeat));
}

function buildContext(deps: {
  backend: WorkerBackend;
  refs: WorkerRefs;
  registry: InflightRegistry;
  emit: (frame: HubFrame | WorkerHeartbeatFrame | WorkerGrantFrame) => void;
  triggerShutdown: (reason: string) => void;
  subagents: SubagentRegistry;
  resolveGrant: (grantId: string, granted: boolean) => void;
}): WorkerContext {
  const { sessions } = deps.refs;
  const { broker } = deps.refs;
  if (sessions === undefined || broker === undefined) {
    throw new Error("worker context built before services are ready");
  }
  return {
    sessions,
    broker,
    emit: deps.emit,
    bashTimeoutMs: readNonNegativeIntEnv("PAI_BASH_TIMEOUT_MS", BASH_TIMEOUT_MS_DEFAULT),
    resolveGrant: deps.resolveGrant,
    registerInflight: deps.registry.register,
    triggerShutdown: deps.triggerShutdown,
    checkPermission: deps.backend.checkPermission,
    routeSubagentUi: (requestId, payload) => deps.subagents.route(requestId, payload),
    killSubagents: () => deps.subagents.killAll(),
    steerSubagent: (subagentId, message) => deps.subagents.steer(subagentId, message),
    success: (id, command, data) => {
      deps.emit(responseSuccess(id, command, data));
    },
    failure: (id, command, error) => {
      deps.emit(responseFailure(id, command, error));
    },
    requireThread: (threadId, command, id) => {
      const thread = sessions.get();
      if (!thread || thread.session.sessionId !== threadId) {
        responseFailure(id, command, `Unknown threadId: ${threadId}`);
        return;
      }
      return thread;
    },
  };
}

/** Parse + dispatch one stdin line; parse failures become parse responses. */
function createLineHandler(deps: {
  emit: (frame: HubFrame) => void;
  handleCommand: (cmd: WorkerCommand) => Promise<void>;
}): (line: string) => void {
  const { emit, handleCommand } = deps;
  return (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      emit(
        responseFailure(
          undefined,
          "parse",
          `Failed to parse command: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }
    if (!isCommandShape(message)) {
      emit(responseFailure(undefined, "parse", "Command must be a JSON object"));
      return;
    }
    void handleCommand(message).catch((error: unknown) => {
      emit(
        responseFailure(
          message.id,
          message.type,
          error instanceof Error ? error.message : String(error),
        ),
      );
    });
  };
}

function attachStdinLoop(deps: {
  emit: (frame: HubFrame | WorkerGrantFrame) => void;
  handleCommand: (cmd: WorkerCommand) => Promise<void>;
  onEnd: () => void;
}): void {
  const onOverflow = (lineLength: number): void => {
    deps.emit(
      responseFailure(undefined, "parse", `Command line exceeds ${lineLength} byte limit; dropped`),
    );
  };
  const splitter = createJsonlSplitter(
    createLineHandler({ emit: deps.emit, handleCommand: deps.handleCommand }),
    onOverflow,
  );
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => splitter.push(chunk));
  process.stdin.on("end", () => {
    splitter.flush();
    deps.onEnd();
  });
}

/** Tail wiring: stdin loop + signal guards (both drain into shutdown). */
function wireWorkerIo(deps: {
  emit: (frame: HubFrame | WorkerGrantFrame) => void;
  handleCommand: (cmd: WorkerCommand) => Promise<void>;
  shutdown: (reason: string) => Promise<void>;
}): void {
  attachStdinLoop({
    emit: deps.emit,
    handleCommand: deps.handleCommand,
    onEnd: () => void deps.shutdown("stdin end"),
  });
  attachProcessGuards({ emit: deps.emit, onSignal: (signal) => void deps.shutdown(signal) });
}

function attachProcessGuards(deps: {
  emit: (frame: HubFrame) => void;
  onSignal: (signal: string) => void;
}): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => deps.onSignal(signal));
  }
  process.on("uncaughtException", (error) => {
    deps.emit({
      type: "hub_error",
      scope: "uncaughtException",
      error: String(error?.stack ?? error),
    });
  });
  process.on("unhandledRejection", (reason) => {
    deps.emit({ type: "hub_error", scope: "unhandledRejection", error: String(reason) });
  });
}

/** Shutdown is re-entry safe and runs to completion once (contract). */
function createLifecycle(deps: {
  writer: ReturnType<typeof createFrameWriter>;
  registry: ReturnType<typeof createInflightRegistry>;
  refs: WorkerRefs;
  subagents: SubagentRegistry;
  shutdownProbe: { active: boolean };
}): { shutdown: (reason: string) => Promise<void>; isShuttingDown: () => boolean } {
  let shuttingDown = false;
  return {
    async shutdown(reason: string): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      deps.shutdownProbe.active = true;
      writeStderr(`pai-cli worker shutting down: ${reason}\n`);
      deps.subagents.killAll();
      await deps.registry.abortAll();
      deps.refs.broker?.settleAll();
      await deps.refs.sessions?.dispose();
      await deps.writer.flush().catch(() => {});
      process.exit(0);
    },
    isShuttingDown: () => shuttingDown,
  };
}

/**
 * v0.6 global subagent cap client: worker→host grant roundtrips over the
 * frame writer. The emitter is late-bound (the registry is built before the
 * writer exists); a silent host resolves acquisitions as denied — the worker
 * follows the host down via stdin EOF anyway, so no denial can outlive it.
 */
function createGrantClient(): {
  request: () => Promise<{ token: string | null; running?: number }>;
  release: (token: string) => void;
  resolve: (grantId: string, granted: boolean, running?: number) => void;
  bind: (send: (frame: WorkerGrantFrame) => void) => void;
} {
  const waiters = new Map<string, (granted: boolean, running?: number) => void>();
  const sink: { send?: (frame: WorkerGrantFrame) => void } = {};
  let seq = 0;
  return {
    request: () =>
      new Promise((resolve) => {
        seq += 1;
        const grantId = `g-${seq}`;
        const timer = setTimeout(() => {
          if (waiters.delete(grantId)) resolve({ token: null });
        }, GRANT_REQUEST_TIMEOUT_MS);
        waiters.set(grantId, (granted, running) => {
          clearTimeout(timer);
          resolve(granted ? { token: grantId, running } : { token: null, running });
        });
        sink.send?.({ type: "grant", id: grantId, n: 1 });
      }),
    release: (token) => {
      sink.send?.({ type: "grant", id: token, release: true, n: 1 });
    },
    resolve: (grantId, granted, running) => {
      const waiter = waiters.get(grantId);
      if (waiter !== undefined) {
        waiters.delete(grantId);
        waiter(granted, running);
        return;
      }
      // Late decision after the 5s timeout: the task was already treated as
      // denied, but the host ledger holds a lease — release it, or a busy
      // worker's heartbeats renew the ghost lease forever (review #4).
      if (granted) {
        sink.send?.({ type: "grant", id: grantId, release: true, n: 1 });
      }
    },
    bind: (send) => {
      sink.send = send;
    },
  };
}

export async function runWorker(): Promise<void> {
  takeOverStdout();
  const writer = createFrameWriter(getRawStdoutWrite());
  const backend = createWorkerBackend();
  const refs: WorkerRefs = {};
  const status: WorkerStatus = { lastBusyAt: Date.now() };
  const registry = createInflightRegistry();
  const shutdownProbe = { active: false };
  const grantClient = createGrantClient();
  const subagents = new SubagentRegistry({
    startTask: backend.startTask,
    getSession: () => refs.sessions?.get()?.session,
    isShuttingDown: () => shutdownProbe.active,
    writeStderr,
    grants: { acquire: grantClient.request, release: grantClient.release },
  });
  const lifecycle = createLifecycle({ writer, registry, refs, subagents, shutdownProbe });
  const { shutdown } = lifecycle;

  const emit = (frame: HubFrame | WorkerHeartbeatFrame | WorkerGrantFrame): void => {
    // Turn-boundary trigger (plan stage 3): the run that just settled may
    // free the session for a queued subagent notification.
    if (frame.type === "event" && frame.event.type === "agent_settled") subagents.onTurnSettled();
    writer.write(`${JSON.stringify(frame)}\n`).catch((error: unknown) => {
      // stdout is gone (host closed the pipe): frames can no longer be
      // delivered. Contract: report to stderr and exit via the normal path.
      writeStderr(`pai-cli worker stdout write failed: ${String(error)}\n`);
      void shutdown("stdout write failed");
    });
  };
  grantClient.bind(emit);
  emitHello({ writer, backend, shutdown });
  startHeartbeat({ emit, refs, registry, status, subagents });
  const ctx = await setupWorkerServices({
    backend,
    refs,
    registry,
    emit,
    shutdown,
    subagents,
    grantClient,
  });

  const handleCommand = createCommandDispatcher({ ctx, backend, lifecycle, status });

  wireWorkerIo({ emit, handleCommand, shutdown });

  // Keep the process alive waiting on stdin.
  await new Promise<void>(() => {});
}

/** Worker contract v1 greeting: the FIRST frame, enqueued before the
 * heartbeat timer arms (the serial writer keeps the order even though both
 * writes are async). A write failure here is the stdout-gone path. */
function emitHello(deps: {
  writer: ReturnType<typeof createFrameWriter>;
  backend: WorkerBackend;
  shutdown: (reason: string) => Promise<void>;
}): void {
  void deps.writer
    .write(
      `${JSON.stringify({
        type: "hello",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        backendId: deps.backend.id,
        capabilities: [...deps.backend.capabilities].toSorted(),
      })}\n`,
    )
    .catch((error: unknown) => {
      writeStderr(`pai-cli worker stdout write failed: ${String(error)}\n`);
      void deps.shutdown("stdout write failed");
    });
}

/** Broker + backend session host + the command context (post-heartbeat). */
async function setupWorkerServices(deps: {
  backend: WorkerBackend;
  refs: WorkerRefs;
  registry: InflightRegistry;
  emit: (frame: HubFrame | WorkerHeartbeatFrame | WorkerGrantFrame) => void;
  shutdown: (reason: string) => Promise<void>;
  subagents: SubagentRegistry;
  grantClient: ReturnType<typeof createGrantClient>;
}): Promise<WorkerContext> {
  const broker = new DialogBroker((frame) => deps.emit(frame));
  deps.refs.broker = broker;
  deps.refs.sessions = await deps.backend.createSessionHost({
    emit: deps.emit,
    broker,
    writeStderr,
    subagents: deps.subagents,
  });
  return buildContext({
    backend: deps.backend,
    refs: deps.refs,
    registry: deps.registry,
    emit: deps.emit,
    triggerShutdown: (reason) => void deps.shutdown(reason),
    subagents: deps.subagents,
    resolveGrant: deps.grantClient.resolve,
  });
}

function createCommandDispatcher(deps: {
  ctx: WorkerContext;
  backend: WorkerBackend;
  lifecycle: { isShuttingDown: () => boolean };
  status: WorkerStatus;
}): (cmd: WorkerCommand) => Promise<void> {
  const { ctx, backend, lifecycle, status } = deps;
  return async (cmd: WorkerCommand): Promise<void> => {
    const { id } = cmd;
    if (lifecycle.isShuttingDown()) {
      responseFailure(id, String(cmd.type ?? "unknown"), "pai-cli worker is shutting down");
      return;
    }
    if (!OBSERVER_COMMANDS.has(cmd.type)) status.lastBusyAt = Date.now();
    const name = String(cmd.type ?? "unknown");
    // v0.8 capability gate (design.md): capability-gated commands the
    // backend does not support fail here with the contract error shape —
    // exactly one response, before any handler runs.
    const unsupported = capabilityError(cmd.type, backend.id, backend.capabilities);
    if (unsupported !== undefined) {
      responseFailure(id, name, unsupported);
      return;
    }
    const handler = workerHandlers.get(cmd.type);
    if (handler === undefined) {
      responseFailure(id, name, `Unknown command: ${name}`);
      return;
    }
    await handler(ctx, cmd, id);
  };
}
