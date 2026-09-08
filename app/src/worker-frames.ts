/**
 * Worker frame relay: classifies worker stdout lines (prefix dispatch +
 * strict response-head match) and applies their effects — heartbeat state,
 * verbatim forwarding, hub_error tagging, pending/internal reconciliation,
 * and control-response table updates BEFORE forwarding (design §4).
 */

import { CONTROL_COMMANDS, type ResponseHead, matchResponseHead } from "./frame-classify.ts";
import type {
  HubFrame,
  UiResponseCmd,
  WorkerGrantFrame,
  WorkerHeartbeatFrame,
  WorkerHelloFrame,
} from "./protocol.ts";
import { WORKER_PROTOCOL_VERSION } from "./protocol.ts";
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
  /** v0.6 global subagent cap arbitration (migration §3 addendum). */
  onGrant: (worker: WorkerHandle, frame: WorkerGrantFrame) => void;
  /** Lease renewal on heartbeats that still report subagents. */
  renewGrants: (worker: WorkerHandle) => void;
  /** Worker-scoped internal-id registry key (see WorkerPool.internalKey). */
  internalKey: (worker: WorkerHandle, id: string) => string;
  /** v0.8 worker contract: the backend id the host expects in hello. */
  expectedBackendId: string;
}

export function onWorkerLine(deps: FrameRelayDeps, worker: WorkerHandle, line: string): void {
  if (line.startsWith('{"type":"hello"')) {
    onHello(deps, worker, JSON.parse(line) as WorkerHelloFrame);
    return;
  }
  if (!worker.greeted) {
    // Worker contract v1: hello must be the first frame. Anything else
    // before it is a spawn-time contract violation — reject through the
    // spawning-failure recycle (no thread_died, pending ids failed once).
    rejectUngreeted(deps, worker, line);
    return;
  }
  if (line.startsWith('{"type":"heartbeat"')) {
    onHeartbeat(deps, worker, JSON.parse(line) as WorkerHeartbeatFrame);
    return;
  }
  if (line.startsWith('{"type":"grant"')) {
    deps.onGrant(worker, JSON.parse(line) as WorkerGrantFrame);
    return;
  }
  if (
    line.startsWith('{"type":"event"') ||
    line.startsWith('{"type":"ui_request"') ||
    line.startsWith('{"type":"subagent_event"') ||
    line.startsWith('{"type":"subagent_message"')
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

function onHello(deps: FrameRelayDeps, worker: WorkerHandle, frame: WorkerHelloFrame): void {
  if (worker.spawnError !== undefined) {
    // Already rejected (or dying): the handshake is monotonic — a second,
    // valid-looking hello during the kill window must not resurrect it.
    return;
  }
  if (worker.greeted) {
    deps.writeStderr("pai-cli worker sent a duplicate hello frame; ignored\n");
    return;
  }
  if (frame.protocolVersion !== WORKER_PROTOCOL_VERSION) {
    rejectHello(
      deps,
      worker,
      `worker hello protocol version mismatch (got ${String(frame.protocolVersion)}, want ${WORKER_PROTOCOL_VERSION})`,
    );
    return;
  }
  if (frame.backendId !== deps.expectedBackendId) {
    rejectHello(
      deps,
      worker,
      `worker hello backend mismatch (got ${frame.backendId}, want ${deps.expectedBackendId})`,
    );
    return;
  }
  worker.greeted = true;
}

/** Spawn-time contract violation: mark and recycle via the spawn-failure
 * path — close reconciliation synthesizes the failure(s), the occupancy
 * table (if any) is reclaimed, no thread_died is emitted. */
function rejectHello(deps: FrameRelayDeps, worker: WorkerHandle, reason: string): void {
  worker.spawnError = reason;
  void deps.killWorker(worker, "none");
}

function rejectUngreeted(deps: FrameRelayDeps, worker: WorkerHandle, line: string): void {
  worker.spawnError = "worker did not send the hello frame first";
  deps.writeStderr(
    `pai-cli worker contract violation: pre-hello frame; rejected: ${line.slice(0, 120)}\n`,
  );
  void deps.killWorker(worker, "none");
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
  if (worker.subagents > 0) deps.renewGrants(worker);
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
      parsed.type === "subagent_event" ||
      parsed.type === "subagent_message" ||
      parsed.type === "grant")
  ) {
    // Known shapes with unexpected key order: relay frames forward verbatim;
    // grant frames carry no ordering contract, the ledger just decides.
    if (parsed.type === "grant") {
      deps.onGrant(worker, parsed as WorkerGrantFrame);
    } else {
      deps.emitRaw(line);
    }
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
  const waiter = id !== undefined ? deps.internalIds.get(deps.internalKey(worker, id)) : undefined;
  const isInternal = waiter !== undefined;
  if (id !== undefined && !isInternal) worker.pendingIds.delete(id);

  if (CONTROL_COMMANDS.has(resolved.head.command)) {
    // Table updates run BEFORE the response is forwarded or the internal
    // waiter resolves (design §4: routing must be ready for the next
    // command the client sends against the response).
    applyControlEffects(deps, worker, { command: resolved.head.command, frame: resolved.frame });
  }

  if (isInternal && waiter !== undefined) {
    deps.internalIds.delete(deps.internalKey(worker, id ?? ""));
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
