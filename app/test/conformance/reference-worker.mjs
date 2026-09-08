// Reference worker for the public worker contract v1 (docs/worker-contract.md):
// the minimal compliant implementation external backend authors copy from.
// Speaks the internal host<->worker protocol: hello handshake, 1Hz heartbeat
// truth, exactly-one response per id'd command, event frames with snapshot
// stripping, stdin EOF graceful exit 0. Scripted model behavior via
// REF_WORKER_REPLY (default deterministic text). Malformed variants are
// selected with REF_WORKER_MODE (no-hello | bad-version) for the rejection
// scenarios.

import { randomUUID } from "node:crypto";

const WORKER_PROTOCOL_VERSION = 1;
const BACKEND_ID = process.env.PAI_BACKEND ?? "reference";
const MODE = process.env.REF_WORKER_MODE ?? "ok";
const REPLY = process.env.REF_WORKER_REPLY ?? "reference worker reply";

const state = {
  threadId: "",
  sessionPath: null,
  streaming: false,
  startedAt: Date.now(),
};

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function success(id, command, data) {
  write({
    type: "response",
    ...(id !== undefined ? { id } : {}),
    command,
    success: true,
    ...(data !== undefined ? { data } : {}),
  });
}

function failure(id, command, error) {
  write({ type: "response", ...(id !== undefined ? { id } : {}), command, success: false, error });
}

function emitEvent(event) {
  write({ type: "event", threadId: state.threadId, event });
}

/** One scripted round: assistant message with stripped deltas + settle. */
function runRound(message) {
  state.streaming = true;
  emitEvent({ type: "agent_start" });
  emitEvent({ type: "message_start", message: { role: "assistant" } });
  const reply = `${REPLY}: ${message}`;
  const mid = Math.ceil(reply.length / 2);
  for (const part of [reply.slice(0, mid), reply.slice(mid)]) {
    // message_update MUST NOT carry the cumulative snapshot (message / partial).
    emitEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: part },
      usage: { totalTokens: 16 },
    });
  }
  emitEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: reply }],
      usage: { totalTokens: 16 },
    },
  });
  emitEvent({ type: "agent_end", messages: [], willRetry: false });
  emitEvent({ type: "agent_settled" });
  state.streaming = false;
}

function handleCommand(cmd) {
  const { id, type } = cmd;
  switch (type) {
    case "thread/start":
      state.threadId = `ref-${randomUUID().slice(0, 8)}`;
      success(id, type, {
        threadId: state.threadId,
        cwd: cmd.cwd ?? process.cwd(),
        sessionPath: null,
      });
      return;
    case "thread/stop":
      state.threadId = "";
      success(id, type);
      return;
    case "prompt":
      // Fire-and-accept: the response means ACCEPTED; the reply rides events.
      success(id, type);
      runRound(cmd.message);
      return;
    case "abort":
      state.streaming = false;
      emitEvent({ type: "agent_settled" });
      success(id, type);
      return;
    case "get_state":
      success(id, type, {
        model: undefined,
        thinkingLevel: "off",
        isStreaming: state.streaming,
        isCompacting: false,
        sessionId: state.threadId,
        sessionName: null,
        sessionFile: null,
        messageCount: 0,
      });
      return;
    case "get_commands":
      success(id, type, { commands: [] });
      return;
    case "ui_response":
      success(id, type);
      return;
    case "grant_result":
      success(id, type, { granted: cmd.granted === true });
      return;
    default:
      failure(id, String(type), `Reference worker does not implement ${String(type)}`);
  }
}

// --- boot ------------------------------------------------------------------

if (MODE !== "no-hello") {
  write({
    type: "hello",
    protocolVersion: MODE === "bad-version" ? 99 : WORKER_PROTOCOL_VERSION,
    backendId: MODE === "bad-backend" ? "mismatched-backend" : BACKEND_ID,
    capabilities: [],
  });
}

const heartbeat = setInterval(() => {
  write({
    type: "heartbeat",
    idleMs: Date.now() - state.startedAt,
    streaming: state.streaming,
    sessionPath: state.sessionPath,
  });
}, 1000);
process.on("exit", () => clearInterval(heartbeat));

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      try {
        handleCommand(JSON.parse(line));
      } catch (error) {
        write({ type: "response", command: "parse", success: false, error: String(error) });
      }
    }
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});
