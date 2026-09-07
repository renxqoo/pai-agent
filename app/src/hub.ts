/**
 * pai-cli assembly: wires stdout takeover, dialog broker, thread manager, and
 * the stdin command loop. Owns exactly one job — orchestration; all decisions
 * live in the modules it composes (see docs/design.md).
 */

import {
  type AgentSession,
  ModelRuntime,
  SessionManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { DialogBroker } from "./dialogs.ts";
import { checkPermission } from "./permission-gate.ts";
import { createJsonlSplitter } from "./jsonl.ts";
import type { HubCommand, HubFrame, ImagePayload, ResponseFrame } from "./protocol.ts";
import {
  createFrameWriter,
  getRawStdoutWrite,
  takeOverStdout,
  writeStderr,
} from "./stdout-guard.ts";
import { type SessionModel, type Thread, ThreadManager } from "./threads.ts";
import { createUiContext } from "./ui-context.ts";

const HEARTBEAT_INTERVAL_MS = 1_000;
const BASH_CONFIRM_TIMEOUT_MS = 300_000;

function toImages(images: ImagePayload[] | undefined): ImagePayload[] | undefined {
  return images && images.length > 0 ? images : undefined;
}

/** Wire-level image shape validation (design.md v0.3). */
function validateImages(images: ImagePayload[] | undefined): string | undefined {
  if (images === undefined) return undefined;
  if (!Array.isArray(images)) return "images must be an array";
  for (const image of images) {
    if (
      typeof image !== "object" ||
      image === null ||
      image.type !== "image" ||
      typeof image.data !== "string" ||
      typeof image.mimeType !== "string"
    ) {
      return 'each image must be {type:"image", data:string, mimeType:string}';
    }
  }
  return undefined;
}

function isCommandShape(message: unknown): message is HubCommand {
  return typeof message === "object" && message !== null && !Array.isArray(message);
}

export async function runHub(argv: string[]): Promise<void> {
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

  let broker: DialogBroker | undefined;
  let threads: ThreadManager | undefined;
  let shuttingDown = false;
  // In-flight long operations (login, bash, compact): shutdown aborts them
  // and waits for their responses to be emitted, so every accepted command
  // keeps its exactly-one response guarantee (no auth.json lock is left
  // mid-critical-section either).
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
    broker?.settleAll();
    await threads?.stopAll();
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

  const heartbeat = setInterval(() => emit({ type: "heartbeat" }), HEARTBEAT_INTERVAL_MS);
  process.on("exit", () => clearInterval(heartbeat));

  const modelRuntime = await ModelRuntime.create();
  broker = new DialogBroker((frame) => emit(frame));
  threads = new ThreadManager(
    modelRuntime,
    emit,
    (threadId) => createUiContext(threadId, broker, emit),
    (threadId) => broker?.settleThread(threadId),
  );

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

  const requireThread = (
    threadId: string,
    command: string,
    id: string | undefined,
  ): Thread | undefined => {
    const thread = threads?.get(threadId);
    if (!thread) {
      emit(failure(id, command, `Unknown threadId: ${threadId}`));
      return undefined;
    }
    return thread;
  };

  const handleCommand = async (cmd: HubCommand): Promise<void> => {
    const id = cmd.id;
    if (shuttingDown) {
      emit(failure(id, String(cmd.type ?? "unknown"), "pai-cli is shutting down"));
      return;
    }
    switch (cmd.type) {
      case "thread/start": {
        const trusted = cmd.trusted === true;
        const cwd = cmd.cwd ?? process.cwd();
        let model: SessionModel | undefined;
        if (cmd.provider !== undefined) {
          model = threads?.resolveModel(cmd.provider, cmd.modelId ?? "");
          if (!model) {
            emit(failure(id, cmd.type, `Model not found: ${cmd.provider}/${cmd.modelId}`));
            return;
          }
        }
        const thread = await threads?.start({ cwd, trusted, model });
        if (!thread) return;
        emit(
          success(id, cmd.type, {
            threadId: thread.session.sessionId,
            cwd: thread.cwd,
            sessionPath: thread.session.sessionFile ?? null,
          }),
        );
        return;
      }

      case "thread/resume": {
        const thread = await threads?.resume({
          cwd: cmd.cwd,
          trusted: cmd.trusted === true,
          sessionPath: cmd.sessionPath,
        });
        if (!thread) return;
        emit(
          success(id, cmd.type, {
            threadId: thread.session.sessionId,
            cwd: thread.cwd,
            sessionPath: thread.session.sessionFile ?? null,
          }),
        );
        return;
      }

      case "thread/stop": {
        await threads?.stop(cmd.threadId);
        emit(success(id, cmd.type));
        return;
      }

      case "thread/list": {
        emit(success(id, cmd.type, { threads: threads?.list() ?? [] }));
        return;
      }

      case "thread/list_saved": {
        const sessions = await SessionManager.list(cmd.cwd ?? process.cwd());
        emit(success(id, cmd.type, { sessions }));
        return;
      }

      case "prompt": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        const imagesError = validateImages(cmd.images);
        if (imagesError !== undefined) {
          emit(failure(id, cmd.type, imagesError));
          return;
        }
        if (
          cmd.streamingBehavior !== undefined &&
          cmd.streamingBehavior !== "steer" &&
          cmd.streamingBehavior !== "followUp"
        ) {
          emit(failure(id, cmd.type, 'streamingBehavior must be "steer" or "followUp"'));
          return;
        }
        const session: AgentSession = thread.session;
        // Fire-and-accept via the SDK's preflight hook (same strategy
        // as pi's RPC mode): exactly one response at acceptance time;
        // failures before acceptance become the failure response, and
        // failures after acceptance ride the event stream.
        let accepted = false;
        void session
          .prompt(cmd.message, {
            images: toImages(cmd.images),
            ...(cmd.streamingBehavior ? { streamingBehavior: cmd.streamingBehavior } : {}),
            source: "rpc",
            preflightResult: (didSucceed) => {
              if (didSucceed) {
                accepted = true;
                emit(success(id, cmd.type));
              }
            },
          })
          .catch((error: unknown) => {
            if (!accepted) {
              emit(failure(id, cmd.type, error instanceof Error ? error.message : String(error)));
            }
          });
        return;
      }

      case "steer": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        const imagesError = validateImages(cmd.images);
        if (imagesError !== undefined) {
          emit(failure(id, cmd.type, imagesError));
          return;
        }
        await thread.session.steer(cmd.message, toImages(cmd.images));
        emit(success(id, cmd.type));
        return;
      }

      case "follow_up": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        const imagesError = validateImages(cmd.images);
        if (imagesError !== undefined) {
          emit(failure(id, cmd.type, imagesError));
          return;
        }
        await thread.session.followUp(cmd.message, toImages(cmd.images));
        emit(success(id, cmd.type));
        return;
      }

      case "abort": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        await thread.session.abort();
        emit(success(id, cmd.type));
        return;
      }

      case "compact": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        const inflight = registerInflight(() => thread.session.abortCompaction());
        try {
          const result = await thread.session.compact(cmd.customInstructions);
          emit(success(id, cmd.type, result));
        } finally {
          inflight.unregister();
        }
        return;
      }

      case "get_state": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        const session = thread.session;
        emit(
          success(id, cmd.type, {
            model: session.model,
            thinkingLevel: session.thinkingLevel,
            isStreaming: session.isStreaming,
            isCompacting: session.isCompacting,
            sessionId: session.sessionId,
            sessionName: session.sessionName ?? null,
            sessionFile: session.sessionFile ?? null,
            messageCount: session.messages.length,
          }),
        );
        return;
      }

      case "get_messages": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        emit(success(id, cmd.type, { messages: thread.session.messages }));
        return;
      }

      case "set_model": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        const model = threads?.resolveModel(cmd.provider, cmd.modelId);
        if (!model) {
          emit(failure(id, cmd.type, `Model not found: ${cmd.provider}/${cmd.modelId}`));
          return;
        }
        await thread.session.setModel(model);
        emit(success(id, cmd.type, { model }));
        return;
      }

      case "get_models": {
        emit(success(id, cmd.type, { models: modelRuntime.getAvailableSnapshot() }));
        return;
      }

      case "set_thinking_level": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        thread.session.setThinkingLevel(cmd.level);
        emit(success(id, cmd.type));
        return;
      }

      case "get_thinking_levels": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        emit(success(id, cmd.type, { levels: thread.session.getAvailableThinkingLevels() }));
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
        // setRuntimeApiKey alone is runtime-only and would not survive a hub
        // restart.
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

      case "get_entries": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        const sessionManager = thread.session.sessionManager;
        let entries = sessionManager.getEntries();
        if (cmd.since !== undefined) {
          const sinceIndex = entries.findIndex((e) => e.id === cmd.since);
          if (sinceIndex === -1) {
            emit(failure(id, cmd.type, `Entry not found: ${cmd.since}`));
            return;
          }
          entries = entries.slice(sinceIndex + 1);
        }
        emit(success(id, cmd.type, { entries, leafId: sessionManager.getLeafId() }));
        return;
      }

      case "get_tree": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        const sessionManager = thread.session.sessionManager;
        emit(
          success(id, cmd.type, {
            tree: sessionManager.getTree(),
            leafId: sessionManager.getLeafId(),
          }),
        );
        return;
      }

      case "set_session_name": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        const name = cmd.name.trim();
        if (name.length === 0) {
          emit(failure(id, cmd.type, "Session name cannot be empty"));
          return;
        }
        thread.session.setSessionName(name);
        emit(success(id, cmd.type));
        return;
      }

      case "get_session_stats": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        emit(success(id, cmd.type, thread.session.getSessionStats()));
        return;
      }

      case "clear_queue": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        emit(success(id, cmd.type, thread.session.clearQueue()));
        return;
      }

      case "fork": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        let forkError: string | undefined;
        let result:
          | { thread: Thread; previousThreadId: string; selectedText?: string; cancelled: boolean }
          | undefined;
        try {
          result = await threads?.fork(cmd.threadId, cmd.entryId, cmd.position ?? "before");
        } catch (error) {
          forkError = error instanceof Error ? error.message : String(error);
        }
        if (forkError !== undefined || result === undefined) {
          emit(failure(id, cmd.type, forkError ?? "fork failed"));
          return;
        }
        emit(
          success(id, cmd.type, {
            threadId: result.thread.session.sessionId,
            previousThreadId: result.previousThreadId,
            sessionPath: result.thread.session.sessionFile ?? null,
            text: result.selectedText ?? null,
            cancelled: result.cancelled,
          }),
        );
        return;
      }

      case "clone": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        let cloneError: string | undefined;
        let result: { thread: Thread; previousThreadId: string; cancelled: boolean } | undefined;
        try {
          result = await threads?.clone(cmd.threadId);
        } catch (error) {
          cloneError = error instanceof Error ? error.message : String(error);
        }
        if (cloneError !== undefined || result === undefined) {
          emit(failure(id, cmd.type, cloneError ?? "clone failed"));
          return;
        }
        emit(
          success(id, cmd.type, {
            threadId: result.thread.session.sessionId,
            previousThreadId: result.previousThreadId,
            sessionPath: result.thread.session.sessionFile ?? null,
            cancelled: result.cancelled,
          }),
        );
        return;
      }

      case "navigate_tree": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        const result = await thread.session.navigateTree(cmd.targetId, {
          ...(cmd.summarize !== undefined ? { summarize: cmd.summarize } : {}),
          ...(cmd.customInstructions !== undefined
            ? { customInstructions: cmd.customInstructions }
            : {}),
          ...(cmd.replaceInstructions !== undefined
            ? { replaceInstructions: cmd.replaceInstructions }
            : {}),
          ...(cmd.label !== undefined ? { label: cmd.label } : {}),
        });
        emit(success(id, cmd.type, result));
        return;
      }

      case "get_fork_messages": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        emit(success(id, cmd.type, { messages: thread.session.getUserMessagesForForking() }));
        return;
      }

      case "get_commands": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        const session = thread.session;
        const commands: Array<{ name: string; description?: string; source: string }> = [];
        for (const command of session.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: command.invocationName,
            ...(command.description !== undefined ? { description: command.description } : {}),
            source: "extension",
          });
        }
        for (const template of session.promptTemplates) {
          commands.push({
            name: template.name,
            ...(template.description !== undefined ? { description: template.description } : {}),
            source: "prompt",
          });
        }
        for (const skill of session.resourceLoader.getSkills().skills) {
          commands.push({
            name: `skill:${skill.name}`,
            ...(skill.description !== undefined ? { description: skill.description } : {}),
            source: "skill",
          });
        }
        emit(success(id, cmd.type, { commands }));
        return;
      }

      case "bash": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        if (typeof cmd.command !== "string" || cmd.command.length === 0) {
          emit(failure(id, cmd.type, "command must be a non-empty string"));
          return;
        }
        // Direct execution does not go through tool_call: gate it with the
        // same rules/dialog path as the agent's bash tool.
        const check = await checkPermission("bash", cmd.command, async (title, value) => {
          const response = await broker?.ask(
            cmd.threadId,
            { method: "confirm", title, message: value },
            { timeout: BASH_CONFIRM_TIMEOUT_MS },
          );
          return response?.["confirmed"] === true;
        });
        if (check.block) {
          emit(failure(id, cmd.type, check.reason ?? "Blocked by permission rules"));
          return;
        }
        // Mirror pi's RPC mode: extensions may observe or fully replace the
        // execution via the user_bash event.
        const eventResult = await thread.session.extensionRunner.emitUserBash({
          type: "user_bash",
          command: cmd.command,
          excludeFromContext: cmd.excludeFromContext === true,
          cwd: thread.session.sessionManager.getCwd(),
        });
        if (eventResult?.result) {
          thread.session.recordBashResult(cmd.command, eventResult.result, {
            excludeFromContext: cmd.excludeFromContext === true,
          });
          emit(success(id, cmd.type, eventResult.result));
          return;
        }
        const inflight = registerInflight(() => thread.session.abortBash());
        try {
          // Streaming output arrives as bash_execution_update events (carrying
          // this command's id) through the normal event frames.
          const result = await thread.session.executeBash(cmd.command, undefined, {
            excludeFromContext: cmd.excludeFromContext === true,
            id,
            ...(eventResult?.operations !== undefined
              ? { operations: eventResult.operations }
              : {}),
          });
          emit(success(id, cmd.type, result));
        } finally {
          inflight.unregister();
        }
        return;
      }

      case "abort_bash": {
        const thread = requireThread(cmd.threadId, cmd.type, id);
        if (!thread) return;
        thread.session.abortBash();
        emit(success(id, cmd.type));
        return;
      }

      case "ui_response": {
        // Exactly one ack regardless of hit or late/unknown requestId.
        broker?.resolve(cmd.requestId, cmd.payload);
        emit(success(id, cmd.type));
        return;
      }

      default: {
        const unknown = cmd as { type?: unknown };
        const name = typeof unknown.type === "string" ? unknown.type : "unknown";
        emit(failure(id, name, `Unknown command: ${name}`));
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
      void handleCommand(command).catch((error: unknown) => {
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
