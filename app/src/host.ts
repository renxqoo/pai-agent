/**
 * pai-cli host: the process Electron talks to. Owns the Electron-facing
 * JSONL protocol, answers global commands locally (auth, models, thread
 * listing) with its own ModelRuntime, and delegates every thread-scoped
 * command to the worker pool (one worker process per live conversation,
 * design.md migration §1). Stdout is the protocol channel; takeOverStdout
 * keeps stray writes off it.
 */

import { ModelRuntime, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createJsonlSplitter } from "./jsonl.ts";
import type { HubCommand, HubFrame, ResponseFrame, SessionModel } from "./protocol.ts";
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

export async function runHost(argv: string[]): Promise<void> {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
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
    return;
  }

  takeOverStdout();
  const writer = createFrameWriter(getRawStdoutWrite());

  let pool: WorkerPool | undefined;
  let shuttingDown = false;
  // In-flight long operations (auth): shutdown aborts them and waits for
  // their responses to be emitted, so every accepted command keeps its
  // exactly-one response guarantee (no auth.json lock is left mid-critical-
  // section either).
  interface InflightOp {
    abort: () => void;
    done: Promise<void>;
  }
  const inflightOps = new Map<number, InflightOp>();
  let inflightSeq = 0;
  const registerInflight = (abort: () => void): { done: () => void; unregister: () => void } => {
    const seq = ++inflightSeq;
    let markDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    inflightOps.set(seq, { abort, done });
    return {
      done: markDone,
      unregister: () => {
        markDone();
        inflightOps.delete(seq);
      },
    };
  };

  // Contract: heartbeat runs for the whole process lifetime, so it starts
  // before the (potentially slow) model runtime setup. Re-entry does not
  // shortcut the first shutdown; it must run to completion.
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    writeStderr(`pai-cli shutting down: ${reason}\n`);
    for (const op of Array.from(inflightOps.values())) op.abort();
    await Promise.allSettled(Array.from(inflightOps.values()).map((op) => op.done));
    await pool?.shutdownAll();
    await writer.flush().catch(() => {});
    process.exit(0);
  };

  const emit = (frame: HubFrame): void => {
    writer.write(`${JSON.stringify(frame)}\n`).catch((error: unknown) => {
      // stdout is gone (client disconnected): frames can no longer be
      // delivered. Contract: report to stderr and exit via the normal path.
      writeStderr(`pai-cli stdout write failed: ${String(error)}\n`);
      void shutdown("stdout write failed");
    });
  };
  const emitRaw = (line: string): void => {
    writer.write(`${line}\n`).catch((error: unknown) => {
      writeStderr(`pai-cli stdout write failed: ${String(error)}\n`);
      void shutdown("stdout write failed");
    });
  };

  const heartbeat = setInterval(() => emit({ type: "heartbeat" }), HEARTBEAT_INTERVAL_MS);
  process.on("exit", () => clearInterval(heartbeat));

  const modelRuntime = await ModelRuntime.create();
  pool = new WorkerPool({ emitFrame: emit, emitRaw, writeStderr });

  const success = (id: string | undefined, command: string, data?: unknown): ResponseFrame => ({
    id,
    type: "response",
    command,
    success: true,
    ...(data !== undefined ? { data } : {}),
  });
  const failure = (id: string | undefined, command: string, error: string): ResponseFrame => ({
    id,
    type: "response",
    command,
    success: false,
    error,
  });

  const resolveModel = (provider: string, modelId: string): SessionModel | undefined =>
    modelRuntime
      .getAvailableSnapshot()
      .find((model) => model.provider === provider && model.id === modelId);

  const handleCommand = async (cmd: HubCommand, line: string): Promise<void> => {
    const id = cmd.id;
    if (shuttingDown) {
      emit(failure(id, String(cmd.type ?? "unknown"), "pai-cli is shutting down"));
      return;
    }
    switch (cmd.type) {
      case "thread/start": {
        let model: SessionModel | undefined;
        if (cmd.provider !== undefined) {
          model = resolveModel(cmd.provider, cmd.modelId ?? "");
          if (!model) {
            emit(failure(id, cmd.type, `Model not found: ${cmd.provider}/${cmd.modelId}`));
            return;
          }
        }
        await pool?.startThread(cmd, model);
        return;
      }

      case "thread/resume": {
        await pool?.resumeThread(cmd);
        return;
      }

      case "thread/stop": {
        await pool?.stopThread(cmd.threadId, cmd.id, cmd.type);
        return;
      }

      case "thread/list": {
        emit(success(id, cmd.type, { threads: pool?.listEntries() ?? [] }));
        return;
      }

      case "thread/list_saved": {
        const sessions = await SessionManager.list(cmd.cwd ?? process.cwd());
        emit(success(id, cmd.type, { sessions }));
        return;
      }

      case "get_models": {
        emit(success(id, cmd.type, { models: modelRuntime.getAvailableSnapshot() }));
        return;
      }

      case "set_model": {
        // Model resolution lives here (single source of truth; the host's
        // snapshot is always fresh, a spawned-earlier worker's is not).
        if (!pool?.hasThread(cmd.threadId)) {
          emit(failure(id, cmd.type, `Unknown threadId: ${cmd.threadId}`));
          return;
        }
        const model = resolveModel(cmd.provider, cmd.modelId);
        if (!model) {
          emit(failure(id, cmd.type, `Model not found: ${cmd.provider}/${cmd.modelId}`));
          return;
        }
        await pool.sendToThread(
          cmd,
          JSON.stringify({
            type: "set_model",
            threadId: cmd.threadId,
            model,
            ...(id !== undefined ? { id } : {}),
          }),
        );
        return;
      }

      case "auth/list": {
        const credentials = await modelRuntime.listCredentials();
        emit(
          success(
            id,
            cmd.type,
            // providerId -> provider: one naming convention on the wire.
            { credentials: credentials.map((c) => ({ provider: c.providerId, type: c.type })) },
          ),
        );
        return;
      }

      case "auth/set_api_key": {
        if (typeof cmd.provider !== "string" || cmd.provider.length === 0) {
          emit(failure(id, cmd.type, "provider must be a non-empty string"));
          return;
        }
        if (typeof cmd.apiKey !== "string" || cmd.apiKey.length === 0) {
          emit(failure(id, cmd.type, "apiKey must be a non-empty string"));
          return;
        }
        // Validate against the builtin catalog (credential-independent):
        // getAvailableSnapshot() only lists providers that already have
        // credentials, so it cannot gate the very act of adding one.
        // models.json custom providers are out of scope for v0.2 (their
        // credentials live in models.json, not auth.json).
        const provider = builtinProviders().find((p) => p.id === cmd.provider);
        if (provider === undefined) {
          // Reject before touching auth.json: an unknown provider would
          // otherwise persist a garbage credential entry.
          emit(failure(id, cmd.type, `Unknown provider: ${cmd.provider}`));
          return;
        }
        // Ambient-only providers omit apiKey.login and cannot take a stored key.
        if (provider.auth.apiKey?.login === undefined) {
          emit(failure(id, cmd.type, `Provider does not support stored API keys: ${cmd.provider}`));
          return;
        }
        // Never silently overwrite a different credential type (e.g. an
        // OAuth subscription login) — that would destroy it.
        const existing = (await modelRuntime.listCredentials()).find(
          (c) => c.providerId === cmd.provider,
        );
        if (existing !== undefined && existing.type !== "api_key") {
          emit(
            failure(id, cmd.type, `Provider has a ${existing.type} credential; remove it first`),
          );
          return;
        }
        // Security: the key must never appear in any frame, including the
        // error path — the bridge only ever answers the FIRST secret prompt
        // (some providers ask select/text for extra fields, e.g. bedrock or
        // cloudflare account IDs; answering those with the key would leak it
        // into error messages or persist it into wrong fields), and every
        // emitted error message is redacted as defense in depth.
        // login("api_key") persists through the provider's sanctioned flow —
        // setRuntimeApiKey alone is runtime-only and would not survive a
        // host restart. Workers pick the stored key up on their next
        // credential read (auth.json is stat-checked on every read).
        let keyAnswered = false;
        const abort = new AbortController();
        const inflight = registerInflight(() => abort.abort());
        try {
          await modelRuntime.login(cmd.provider, "api_key", {
            signal: abort.signal,
            prompt: async (p) => {
              if (p.type === "secret" && !keyAnswered) {
                keyAnswered = true;
                return cmd.apiKey;
              }
              throw new Error(
                `Provider requires additional interactive input (${p.type}); not supported by auth/set_api_key`,
              );
            },
            notify: () => {},
          });
        } catch (error) {
          emit(
            failure(
              id,
              cmd.type,
              String(error instanceof Error ? error.message : error).replaceAll(
                cmd.apiKey,
                "[redacted]",
              ),
            ),
          );
          return;
        } finally {
          inflight.unregister();
        }
        emit(success(id, cmd.type, { provider: cmd.provider }));
        return;
      }

      case "auth/remove_key": {
        if (typeof cmd.provider !== "string" || cmd.provider.length === 0) {
          emit(failure(id, cmd.type, "provider must be a non-empty string"));
          return;
        }
        // logout deletes the WHOLE stored credential (removeRuntimeApiKey
        // only clears the runtime overlay), so guard the type: this command
        // must not destroy an OAuth credential.
        const existing = (await modelRuntime.listCredentials()).find(
          (c) => c.providerId === cmd.provider,
        );
        if (existing !== undefined && existing.type !== "api_key") {
          emit(
            failure(
              id,
              cmd.type,
              `Provider has a ${existing.type} credential; only api_key credentials can be removed with auth/remove_key`,
            ),
          );
          return;
        }
        await modelRuntime.logout(cmd.provider);
        emit(success(id, cmd.type));
        return;
      }

      case "ui_response": {
        // Exactly one ack from the host; the payload is broadcast to all
        // live workers and the owning one resolves its dialog.
        pool?.broadcastUiResponse(cmd);
        emit(success(id, cmd.type));
        return;
      }

      default: {
        // Thread-scoped commands: raw-line passthrough to the owning worker
        // (shape is identical on both sides of the host<->worker protocol).
        const scoped = cmd as { type: string; threadId?: string };
        if (typeof scoped.threadId !== "string") {
          const name = typeof cmd.type === "string" ? cmd.type : "unknown";
          emit(failure(id, name, `Unknown command: ${name}`));
          return;
        }
        await pool?.sendToThread(cmd as { type: string; threadId: string; id?: string }, line);
      }
    }
  };

  // --- stdin JSONL loop -----------------------------------------------------

  const splitter = createJsonlSplitter(
    (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (error) {
        emit(
          failure(
            undefined,
            "parse",
            `Failed to parse command: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      if (!isCommandShape(message)) {
        emit(failure(undefined, "parse", "Command must be a JSON object"));
        return;
      }
      const command = message;
      void handleCommand(command, line).catch((error: unknown) => {
        emit(
          failure(command.id, command.type, error instanceof Error ? error.message : String(error)),
        );
      });
    },
    (lineLength) => {
      emit(failure(undefined, "parse", `Command line exceeds ${lineLength} byte limit; dropped`));
    },
  );

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => splitter.push(chunk));
  process.stdin.on("end", () => {
    splitter.flush();
    void shutdown("stdin end");
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  process.on("uncaughtException", (error) => {
    emit({ type: "hub_error", scope: "uncaughtException", error: String(error?.stack ?? error) });
  });
  process.on("unhandledRejection", (reason) => {
    emit({ type: "hub_error", scope: "unhandledRejection", error: String(reason) });
  });

  // Keep the process alive waiting on stdin.
  await new Promise<void>(() => {});
}
