/**
 * pai-cli worker: one conversation per process (design.md migration §1).
 * Speaks the thread-scoped subset of the v0.3 protocol on stdin/stdout to
 * the pai-cli host; global commands (auth, models, thread listing) live in
 * the host. This file is bootstrap only — command behavior is in
 * worker-commands.ts, session lifecycle in session-host.ts.
 */

import { type InlineExtension, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DialogBroker } from "./dialogs.ts";
import { responseFailure, responseSuccess } from "./frames.ts";
import { createInflightRegistry } from "./inflight-registry.ts";
import { createJsonlSplitter } from "./jsonl.ts";
import type { HubFrame, WorkerCommand, WorkerHeartbeatFrame } from "./protocol.ts";
import { OBSERVER_COMMANDS } from "./protocol.ts";
import { SessionHost } from "./session-host.ts";
import { createSubagentCommunicationExtension } from "./subagent-communication.ts";
import { createTaskTool } from "./subagent-tool.ts";
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
import { createUiContext } from "./ui-context.ts";

const HEARTBEAT_INTERVAL_MS = 1_000;

function isCommandShape(message: unknown): message is WorkerCommand {
  return typeof message === "object" && message !== null && !Array.isArray(message);
}

interface WorkerRefs {
  broker?: DialogBroker;
  sessions?: SessionHost;
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
  refs: WorkerRefs;
  registry: InflightRegistry;
  emit: (frame: HubFrame | WorkerHeartbeatFrame) => void;
  triggerShutdown: (reason: string) => void;
  subagents: SubagentRegistry;
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
    registerInflight: deps.registry.register,
    triggerShutdown: deps.triggerShutdown,
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
  emit: (frame: HubFrame) => void;
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

/** Built-in extensions (not user code): normal conversations get the task
 * tool (project-level agent definitions stay trust-gated inside); grandchild
 * spawns (depth 1) get the communication tools instead — report/send to the
 * parent, never a task tool of their own. */
function builtinExtensions(deps: {
  emit: (frame: HubFrame | WorkerHeartbeatFrame) => void;
  modelRuntime: ModelRuntime;
  subagents: SubagentRegistry;
  getThreadId: () => string;
}): (spawn: {
  trusted: boolean;
  subagent: boolean;
  subagentId?: string;
  agentName?: string;
}) => InlineExtension[] {
  return (spawn) =>
    spawn.subagent
      ? [
          createSubagentCommunicationExtension({
            emit: (frame) => deps.emit(frame),
            getThreadId: deps.getThreadId,
            subagentId: spawn.subagentId ?? "",
            agentName: spawn.agentName ?? "",
          }),
        ]
      : [
          createTaskTool(
            {
              emit: deps.emit,
              modelRuntime: deps.modelRuntime,
              registry: deps.subagents,
              writeStderr,
              getThreadId: deps.getThreadId,
            },
            spawn.trusted,
          ),
        ];
}

/** Model runtime, dialog broker, and the single-session host. */
async function setupWorkerServices(deps: {
  refs: WorkerRefs;
  registry: ReturnType<typeof createInflightRegistry>;
  emit: (frame: HubFrame | WorkerHeartbeatFrame) => void;
  shutdown: (reason: string) => Promise<void>;
  subagents: SubagentRegistry;
}): Promise<WorkerContext> {
  const modelRuntime = await ModelRuntime.create();
  const broker = new DialogBroker((frame) => deps.emit(frame));
  const { subagents } = deps;
  deps.refs.broker = broker;
  deps.refs.sessions = new SessionHost({
    modelRuntime,
    emit: deps.emit,
    createUi: (threadId) => createUiContext(threadId, broker, deps.emit),
    onThreadDisposed: (threadId) => broker.settleThread(threadId),
    writeStderr,
    createExtensions: builtinExtensions({
      emit: deps.emit,
      modelRuntime,
      subagents,
      getThreadId: () => deps.refs.sessions?.threadId() ?? "",
    }),
  });
  return buildContext({
    refs: deps.refs,
    registry: deps.registry,
    emit: deps.emit,
    triggerShutdown: (reason) => void deps.shutdown(reason),
    subagents,
  });
}

function createCommandDispatcher(deps: {
  ctx: WorkerContext;
  lifecycle: { isShuttingDown: () => boolean };
  status: WorkerStatus;
}): (cmd: WorkerCommand) => Promise<void> {
  const { ctx, lifecycle, status } = deps;
  return async (cmd: WorkerCommand): Promise<void> => {
    const { id } = cmd;
    if (lifecycle.isShuttingDown()) {
      responseFailure(id, String(cmd.type ?? "unknown"), "pai-cli worker is shutting down");
      return;
    }
    if (!OBSERVER_COMMANDS.has(cmd.type)) status.lastBusyAt = Date.now();
    const handler = workerHandlers.get(cmd.type);
    if (handler === undefined) {
      const unknown = cmd as { type?: unknown };
      const name = typeof unknown.type === "string" ? unknown.type : "unknown";
      responseFailure(id, name, `Unknown command: ${name}`);
      return;
    }
    await handler(ctx, cmd, id);
  };
}

export async function runWorker(): Promise<void> {
  takeOverStdout();
  const writer = createFrameWriter(getRawStdoutWrite());
  const refs: WorkerRefs = {};
  const status: WorkerStatus = { lastBusyAt: Date.now() };
  const registry = createInflightRegistry();
  const shutdownProbe = { active: false };
  const subagents = new SubagentRegistry({
    getSession: () => refs.sessions?.get()?.session,
    isShuttingDown: () => shutdownProbe.active,
    writeStderr,
  });
  const lifecycle = createLifecycle({ writer, registry, refs, subagents, shutdownProbe });
  const { shutdown } = lifecycle;

  const emit = (frame: HubFrame | WorkerHeartbeatFrame): void => {
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
  startHeartbeat({ emit, refs, registry, status, subagents });
  const ctx = await setupWorkerServices({ refs, registry, emit, shutdown, subagents });

  const handleCommand = createCommandDispatcher({ ctx, lifecycle, status });

  attachStdinLoop({ emit, handleCommand, onEnd: () => void shutdown("stdin end") });
  attachProcessGuards({ emit, onSignal: (signal) => void shutdown(signal) });

  // Keep the process alive waiting on stdin.
  await new Promise<void>(() => {});
}
