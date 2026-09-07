/**
 * pai-cli worker: one conversation per process (design.md migration §1).
 * Speaks the thread-scoped subset of the v0.3 protocol on stdin/stdout to
 * the pai-cli host. Global commands (auth, models, thread listing) live in
 * the host. Stdout is the protocol channel; takeOverStdout keeps stray
 * writes off it.
 */

import { type AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DialogBroker } from "./dialogs.ts";
import { checkPermission } from "./permission-gate.ts";
import { createJsonlSplitter } from "./jsonl.ts";
import {
  type HubFrame,
  type ImagePayload,
  OBSERVER_COMMANDS,
  type ResponseFrame,
  type WorkerCommand,
  type WorkerHeartbeatFrame,
} from "./protocol.ts";
import {
  createFrameWriter,
  getRawStdoutWrite,
  takeOverStdout,
  writeStderr,
} from "./stdout-guard.ts";
import { SessionDestroyedError, type Thread } from "./session-host.ts";
import { SessionHost } from "./session-host.ts";
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

function isCommandShape(message: unknown): message is WorkerCommand {
  return typeof message === "object" && message !== null && !Array.isArray(message);
}

export async function runWorker(): Promise<void> {
  takeOverStdout();
  const writer = createFrameWriter(getRawStdoutWrite());

  let broker: DialogBroker | undefined;
  let sessions: SessionHost | undefined;
  let shuttingDown = false;
  /** Idle timer baseline: reset by non-observer commands and by activity
   * (streaming/compaction/dialogs/in-flight ops) on each heartbeat tick. */
  let lastBusyAt = Date.now();
  // In-flight long operations (bash, compact): shutdown aborts them and
  // waits for their responses to be emitted, so every accepted command
  // keeps its exactly-one response guarantee.
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

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    writeStderr(`pai-cli worker shutting down: ${reason}\n`);
    for (const op of Array.from(inflightOps.values())) op.abort();
    await Promise.allSettled(Array.from(inflightOps.values()).map((op) => op.done));
    broker?.settleAll();
    await sessions?.dispose();
    await writer.flush().catch(() => {});
    process.exit(0);
  };

  const emit = (frame: HubFrame | WorkerHeartbeatFrame): void => {
    writer.write(`${JSON.stringify(frame)}\n`).catch((error: unknown) => {
      // stdout is gone (host closed the pipe): frames can no longer be
      // delivered. Contract: report to stderr and exit via the normal path.
      writeStderr(`pai-cli worker stdout write failed: ${String(error)}\n`);
      void shutdown("stdout write failed");
    });
  };

  // Heartbeat carries the worker-side truth (design.md migration §3): the
  // host retires/kills workers from these fields and never guesses.
  const heartbeat = setInterval(() => {
    const session = sessions?.get()?.session;
    if (
      session?.isStreaming === true ||
      session?.isCompacting === true ||
      (broker?.pendingCount() ?? 0) > 0 ||
      inflightOps.size > 0
    ) {
      lastBusyAt = Date.now();
    }
    const frame: WorkerHeartbeatFrame = {
      type: "heartbeat",
      idleMs: Date.now() - lastBusyAt,
      streaming: session?.isStreaming === true,
      sessionPath: session?.sessionFile ?? null,
    };
    emit(frame);
  }, HEARTBEAT_INTERVAL_MS);
  process.on("exit", () => clearInterval(heartbeat));

  const modelRuntime = await ModelRuntime.create();
  broker = new DialogBroker((frame) => emit(frame));
  sessions = new SessionHost(
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
    const thread = sessions?.get();
    if (!thread || thread.session.sessionId !== threadId) {
      emit(failure(id, command, `Unknown threadId: ${threadId}`));
      return undefined;
    }
    return thread;
  };

  const handleCommand = async (cmd: WorkerCommand): Promise<void> => {
    const id = cmd.id;
    if (shuttingDown) {
      emit(failure(id, String(cmd.type ?? "unknown"), "pai-cli worker is shutting down"));
      return;
    }
    if (!OBSERVER_COMMANDS.has(cmd.type)) lastBusyAt = Date.now();
    switch (cmd.type) {
      case "thread/start": {
        const thread = await sessions?.start({
          cwd: cmd.cwd ?? process.cwd(),
          trusted: cmd.trusted === true,
          ...(cmd.model !== undefined ? { model: cmd.model } : {}),
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

      case "thread/resume": {
        const thread = await sessions?.resume({
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
        await sessions?.stop();
        emit(success(id, cmd.type));
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
        // Model was resolved by the host against its always-fresh snapshot
        // (design.md migration §1); the worker applies it as-is.
        await thread.session.setModel(cmd.model);
        emit(success(id, cmd.type, { model: cmd.model }));
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
          result = await sessions?.fork(cmd.entryId, cmd.position ?? "before");
        } catch (error) {
          if (error instanceof SessionDestroyedError) {
            // Teardown already disposed the session (migration.md F-1):
            // the thread cannot continue. Fail the command, then exit —
            // the host turns this into thread_died.
            emit(failure(id, cmd.type, error.message));
            void shutdown("session destroyed by failed fork");
            return;
          }
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
          result = await sessions?.clone();
        } catch (error) {
          if (error instanceof SessionDestroyedError) {
            emit(failure(id, cmd.type, error.message));
            void shutdown("session destroyed by failed clone");
            return;
          }
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
