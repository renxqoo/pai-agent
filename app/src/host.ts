/**
 * pai-cli host: the process Electron talks to. Owns the Electron-facing
 * JSONL protocol, answers global commands locally (auth, models, thread
 * listing) with its own ModelRuntime, and delegates every thread-scoped
 * command to the worker pool (one worker process per live conversation,
 * design.md migration §1). This file is bootstrap only — command behavior
 * is in host-commands.ts / host-auth.ts. Stdout is the protocol channel;
 * takeOverStdout keeps stray writes off it.
 */

import { ModelRuntime, VERSION } from "@earendil-works/pi-coding-agent";
import { createJsonlSplitter } from "./jsonl.ts";
import type { HubCommand, HubFrame } from "./protocol.ts";
import { responseFailure } from "./frames.ts";
import { createInflightRegistry } from "./inflight-registry.ts";
import { handlePassthrough, hostHandlers, type HostDeps } from "./host-commands.ts";
import {
  createFrameWriter,
  getRawStdoutWrite,
  takeOverStdout,
  writeStderr,
} from "./stdout-guard.ts";
import { WorkerPool } from "./worker-pool.ts";

const HEARTBEAT_INTERVAL_MS = 1_000;

function isCommandShape(message: unknown): message is HubCommand {
  return typeof message === "object" && message !== null && !Array.isArray(message);
}

/** --version / --help short-circuit; returns true when handled. */
function tryHandleVersionFlags(argv: string[]): boolean {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return true;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      `${[
        "pai-cli: multi-session host for the pi coding agent",
        "",
        "Usage: pai [--version]",
        "",
        "Speaks JSONL on stdin/stdout. Protocol: docs/design.md, README.md.",
      ].join("\n")}\n`,
    );
    return true;
  }
  return false;
}

interface HostEmitters {
  emit: (frame: HubFrame) => void;
  emitRaw: (line: string) => void;
  onWriteFailure: (error: unknown) => void;
}

function createEmitters(
  write: (text: string) => Promise<void>,
  onWriteFailure: (error: unknown) => void,
): HostEmitters {
  const writeLine = (text: string): void => {
    write(`${text}\n`).catch(onWriteFailure);
  };
  return {
    emit: (frame) => writeLine(JSON.stringify(frame)),
    emitRaw: (line) => writeLine(line),
    onWriteFailure,
  };
}

/** Parse + dispatch one stdin line; parse failures become parse responses. */
/** Contract: heartbeat runs for the whole process lifetime, so it starts
 * before the (potentially slow) model runtime setup. */
function startHeartbeat(emitters: HostEmitters, poolRef: { pool?: WorkerPool }): void {
  const heartbeat = setInterval(() => {
    const subagents = poolRef.pool?.inFlightSubagents() ?? 0;
    emitters.emit({
      type: "heartbeat",
      ...(subagents > 0 ? { subagents } : {}),
    });
  }, HEARTBEAT_INTERVAL_MS);
  process.on("exit", () => clearInterval(heartbeat));
}

function attachStdinLoop(deps: {
  emitters: HostEmitters;
  handleCommand: (cmd: HubCommand, line: string) => Promise<void>;
  onEnd: () => void;
}): void {
  const { emitters, handleCommand } = deps;
  const onLine = (line: string): void => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      emitters.emit(
        responseFailure(
          undefined,
          "parse",
          `Failed to parse command: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }
    if (!isCommandShape(message)) {
      emitters.emit(responseFailure(undefined, "parse", "Command must be a JSON object"));
      return;
    }
    const command = message;
    void handleCommand(command, line).catch((error: unknown) => {
      emitters.emit(
        responseFailure(
          command.id,
          command.type,
          error instanceof Error ? error.message : String(error),
        ),
      );
    });
  };
  const onOverflow = (lineLength: number): void => {
    emitters.emit(
      responseFailure(undefined, "parse", `Command line exceeds ${lineLength} byte limit; dropped`),
    );
  };
  const splitter = createJsonlSplitter(onLine, onOverflow);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => splitter.push(chunk));
  process.stdin.on("end", () => {
    splitter.flush();
    deps.onEnd();
  });
}

function attachProcessGuards(deps: {
  emitters: HostEmitters;
  onSignal: (signal: string) => void;
}): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => deps.onSignal(signal));
  }
  process.on("uncaughtException", (error) => {
    deps.emitters.emit({
      type: "hub_error",
      scope: "uncaughtException",
      error: String(error?.stack ?? error),
    });
  });
  process.on("unhandledRejection", (reason) => {
    deps.emitters.emit({ type: "hub_error", scope: "unhandledRejection", error: String(reason) });
  });
}

interface HostLifecycle {
  shutdown: (reason: string) => Promise<void>;
  isShuttingDown: () => boolean;
}

/** Shutdown is re-entry safe and runs to completion once (contract). */
function createLifecycle(deps: {
  writer: ReturnType<typeof createFrameWriter>;
  registry: ReturnType<typeof createInflightRegistry>;
  pool: { shutdownAll(): Promise<void> };
}): HostLifecycle {
  let shuttingDown = false;
  return {
    async shutdown(reason: string): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      writeStderr(`pai-cli shutting down: ${reason}\n`);
      await deps.registry.abortAll();
      await deps.pool.shutdownAll().catch(() => {});
      await deps.writer.flush().catch(() => {});
      process.exit(0);
    },
    isShuttingDown: () => shuttingDown,
  };
}

export async function runHost(argv: string[]): Promise<void> {
  if (tryHandleVersionFlags(argv)) return;
  takeOverStdout();
  const writer = createFrameWriter(getRawStdoutWrite());
  const registry = createInflightRegistry();
  const poolRef: { pool?: WorkerPool } = {};
  const lifecycle = createLifecycle({
    writer,
    registry,
    pool: { shutdownAll: () => poolRef.pool?.shutdownAll() ?? Promise.resolve() },
  });
  const { shutdown } = lifecycle;
  const emitters = createEmitters(
    (text) => writer.write(text),
    (error) => {
      // stdout is gone (client disconnected): frames can no longer be
      // delivered. Contract: report to stderr and exit via the normal path.
      writeStderr(`pai-cli stdout write failed: ${String(error)}\n`);
      void shutdown("stdout write failed");
    },
  );
  startHeartbeat(emitters, poolRef);
  const { deps } = await setupHostServices({ emitters, registry, poolRef });

  const handleCommand = async (cmd: HubCommand, line: string): Promise<void> => {
    const { id } = cmd;
    if (lifecycle.isShuttingDown()) {
      emitters.emit(responseFailure(id, String(cmd.type ?? "unknown"), "pai-cli is shutting down"));
      return;
    }
    const handler = hostHandlers.get(cmd.type);
    if (handler !== undefined) {
      await handler(deps, cmd, id);
      return;
    }
    await handlePassthrough(deps, cmd, line);
  };

  attachStdinLoop({ emitters, handleCommand, onEnd: () => void shutdown("stdin end") });
  attachProcessGuards({ emitters, onSignal: (signal) => void shutdown(signal) });

  // Keep the process alive waiting on stdin.
  await new Promise<void>(() => {});
}

/** Model runtime + pool construction; returns the handler dependency set. */
async function setupHostServices(deps: {
  emitters: HostEmitters;
  registry: ReturnType<typeof createInflightRegistry>;
  poolRef: { pool?: WorkerPool };
}): Promise<{ deps: HostDeps }> {
  const modelRuntime = await ModelRuntime.create();
  const pool = new WorkerPool({
    emitFrame: deps.emitters.emit,
    emitRaw: deps.emitters.emitRaw,
    writeStderr,
  });
  deps.poolRef.pool = pool;
  return {
    deps: {
      pool,
      modelRuntime,
      emit: deps.emitters.emit,
      registerInflight: deps.registry.register,
    },
  };
}
