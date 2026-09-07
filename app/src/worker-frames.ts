/**
 * Worker frame relay: classifies worker stdout lines (prefix dispatch +
 * strict response-head match) and applies their effects — heartbeat state,
 * verbatim forwarding, hub_error tagging, pending/internal reconciliation,
 * and control-response table updates BEFORE forwarding (design §4).
 */

import { CONTROL_COMMANDS, type ResponseHead, matchResponseHead } from "./frame-classify.ts";
import type { HubFrame, UiResponseCmd, WorkerHeartbeatFrame } from "./protocol.ts";
import { type RetireIntent, type WorkerHandle } from "./worker-process.ts";
import type { ThreadTable } from "./thread-table.ts";
import { copySidecarRules } from "./sidecar-rules.ts";

export interface InternalWaiter {
  onResponse: (frame: Record<string, unknown>) => void;
  onClosed: () => void;
}

/** Broadcast a ui_response to live workers, one internal ack id each: the
 * owning worker resolves its dialog by requestId; the rest ignore it. */
export function broadcastUiResponseToWorkers(deps: {
  cmd: UiResponseCmd;
  workers: WorkerHandle[];
  registerInternal: (worker: WorkerHandle, waiter: InternalWaiter) => string;
  forgetInternal: (worker: WorkerHandle, id: string) => void;
}): void {
  const { cmd, workers } = deps;
  const payload = JSON.stringify({
    type: "ui_response",
    requestId: cmd.requestId,
    payload: cmd.payload,
  });
  for (const worker of workers) {
    const id = deps.registerInternal(worker, {
      onResponse: () => {},
      onClosed: () => {},
    });
    void worker.writeLine(payload.replace(/^\{/, `{"id":"${id}",`)).catch(() => {
      deps.forgetInternal(worker, id);
    });
  }
}

export interface FrameRelayDeps {
  table: ThreadTable;
  internalIds: Map<string, InternalWaiter>;
  emitFrame: (frame: HubFrame) => void;
  emitRaw: (line: string) => void;
  writeStderr: (text: string) => void;
  killWorker: (worker: WorkerHandle, intent: RetireIntent) => Promise<void>;
}

export function onWorkerLine(deps: FrameRelayDeps, worker: WorkerHandle, line: string): void {
  if (line.startsWith('{"type":"heartbeat"')) {
    onHeartbeat(deps, worker, JSON.parse(line) as WorkerHeartbeatFrame);
    return;
  }
  if (
    line.startsWith('{"type":"event"') ||
    line.startsWith('{"type":"ui_request"') ||
    line.startsWith('{"type":"subagent_event"')
  ) {
    deps.emitRaw(line);
    return;
  }
  if (line.startsWith('{"type":"hub_error"')) {
    forwardHubError(deps, worker, line);
    return;
  }
  const head = matchResponseHead(line);
  if (head !== undefined) {
    onWorkerResponse(deps, worker, { line, head });
    return;
  }
  onUnclassifiedLine(deps, worker, line);
}

function onHeartbeat(
  deps: FrameRelayDeps,
  worker: WorkerHandle,
  frame: WorkerHeartbeatFrame,
): void {
  worker.lastHeartbeatAt = Date.now();
  worker.idleMs = frame.idleMs;
  worker.streaming = frame.streaming;
  worker.subagents = frame.subagents ?? 0;
  if (frame.sessionPath !== worker.sessionPath) {
    // First persist, or a fork/clone path change: keep occupancy exact.
    deps.table.reoccupy(worker, frame.sessionPath);
  }
}

function forwardHubError(deps: FrameRelayDeps, worker: WorkerHandle, line: string): void {
  const frame = JSON.parse(line) as { type: "hub_error"; scope: string; error: string };
  deps.emitFrame({
    type: "hub_error",
    ...(worker.threadId !== "" ? { threadId: worker.threadId } : {}),
    scope: frame.scope,
    error: frame.error,
  });
}

/** Parse fallback (design §3): numeric/non-string ids serialize outside the
 * strict head prefixes and must still classify — dropping them would make a
 * healthy worker look like a spawn timeout. */
function onUnclassifiedLine(deps: FrameRelayDeps, worker: WorkerHandle, line: string): void {
  let parsed: { type?: unknown } | undefined;
  try {
    parsed = JSON.parse(line) as { type?: unknown };
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined && parsed.type === "response") {
    onWorkerResponse(deps, worker, { line, head: null });
    return;
  }
  if (
    parsed !== undefined &&
    (parsed.type === "event" ||
      parsed.type === "ui_request" ||
      parsed.type === "hub_error" ||
      parsed.type === "subagent_event")
  ) {
    // Known shapes with unexpected key order still forward verbatim.
    deps.emitRaw(line);
    return;
  }
  deps.writeStderr(`pai-cli worker sent an unclassified frame; ignored: ${line.slice(0, 200)}\n`);
}

interface ResponseFrameShape {
  id?: string;
  command?: string;
  success?: boolean;
  data?: Record<string, unknown>;
}

function resolveResponseFrame(
  line: string,
  head: ResponseHead | null,
): { frame: ResponseFrameShape; head: ResponseHead } {
  if (head === null) {
    // Strict head match failed (escaped id or unusual shape): parse fully.
    const parsed = JSON.parse(line) as ResponseFrameShape;
    return {
      frame: parsed,
      head: {
        id: typeof parsed.id === "string" ? parsed.id : undefined,
        command: typeof parsed.command === "string" ? parsed.command : "",
      },
    };
  }
  const partial: ResponseFrameShape = { id: head.id, command: head.command };
  if (!CONTROL_COMMANDS.has(head.command)) return { frame: partial, head };
  // Control responses are small: parse fully for the table update.
  return { frame: JSON.parse(line) as ResponseFrameShape, head };
}

function onWorkerResponse(
  deps: FrameRelayDeps,
  worker: WorkerHandle,
  message: { line: string; head: ResponseHead | null },
): void {
  const resolved = resolveResponseFrame(message.line, message.head);
  const { id } = resolved.head;
  const waiter = id !== undefined ? deps.internalIds.get(id) : undefined;
  const isInternal = waiter !== undefined;
  if (id !== undefined && !isInternal) worker.pendingIds.delete(id);

  if (CONTROL_COMMANDS.has(resolved.head.command)) {
    // Table updates run BEFORE the response is forwarded or the internal
    // waiter resolves (design §4: routing must be ready for the next
    // command the client sends against the response).
    applyControlEffects(deps, worker, { command: resolved.head.command, frame: resolved.frame });
  }

  if (isInternal && waiter !== undefined) {
    deps.internalIds.delete(id ?? "");
    worker.internalIds.delete(id ?? "");
    waiter.onResponse(resolved.frame as Record<string, unknown>);
    return;
  }
  deps.emitRaw(message.line);
}

function applyControlEffects(
  deps: FrameRelayDeps,
  worker: WorkerHandle,
  control: {
    command: string;
    frame: { success?: boolean; data?: Record<string, unknown> };
  },
): void {
  const { command, frame } = control;
  if (frame.success === true && frame.data !== undefined) {
    if (command === "thread/start" || command === "thread/resume") {
      deps.table.registerLive(worker, frame.data, (from, to) => {
        deps.writeStderr(`pai-cli worker resumed to a different session id (${from} -> ${to})\n`);
        // Wake re-key (unpersisted empty session): rules follow the id.
        if (!copySidecarRules(from, to)) {
          deps.writeStderr(
            `pai-cli could not copy permission rules across the id change (${from} -> ${to}); the thread falls back to the global rules\n`,
          );
        }
      });
    } else {
      deps.table.rekeyFork(worker, frame.data);
    }
  } else if (
    frame.success !== true &&
    (command === "thread/start" || command === "thread/resume")
  ) {
    // Initial start/resume failed: no conversation exists; reclaim the worker.
    void deps.killWorker(worker, "stop");
  }
  if (command === "thread/stop" && worker.retireIntent === "stop") {
    worker.retiring = true;
    worker.stdin.end();
  }
}
