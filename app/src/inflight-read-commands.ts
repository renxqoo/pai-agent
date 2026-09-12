/**
 * v0.14 convergence reads (design.md v0.14): the three read-only commands a
 * client pulls to converge after missing events — the current turn's
 * in-flight facts (get_inflight), the subagent snapshot (get_subagents), and
 * the dialogs awaiting an answer (get_pending_dialogs). All three are
 * observer commands: read-only, no events, no idle-timer reset, and they
 * answer the empty form when there is nothing in flight (never an error).
 */

import type {
  GetInflightCmd,
  GetInflightPayload,
  GetPendingDialogsCmd,
  GetSubagentsCmd,
  PendingDialogEntry,
} from "./protocol.ts";
import type { PendingSubagentDialog } from "./subagent-registry.ts";
import type { WorkerContext } from "./worker-context.ts";

/** One worker command handler (registered by type in worker-commands.ts). */
type Handler = (
  ctx: WorkerContext,
  cmd: { type: string; threadId?: unknown },
  id: string | undefined,
) => Promise<void>;

export const handleGetInflight: Handler = (ctx, cmd, id) => {
  const inflight = cmd as GetInflightCmd & { id?: string };
  const thread = ctx.requireThread(inflight.threadId, "get_inflight", id);
  if (!thread) return Promise.resolve();
  const snapshot = thread.inflight.snapshot();
  const payload: GetInflightPayload = {
    turnStartEntryId: snapshot.turnStartEntryId,
    turnStartedAt: snapshot.turnStartedAt,
    message: thread.session.agent.state.streamingMessage ?? null,
    toolOutputs: snapshot.toolOutputs,
    bash: snapshot.bash,
  };
  ctx.success(id, "get_inflight", payload);
  return Promise.resolve();
};

export const handleGetSubagents: Handler = (ctx, cmd, id) => {
  const subagents = cmd as GetSubagentsCmd & { id?: string };
  const thread = ctx.requireThread(subagents.threadId, "get_subagents", id);
  if (!thread) return Promise.resolve();
  ctx.success(id, "get_subagents", { subagents: [...ctx.subagentSnapshot()] });
  return Promise.resolve();
};

export const handleGetPendingDialogs: Handler = (ctx, cmd, id) => {
  const dialogs = cmd as GetPendingDialogsCmd & { id?: string };
  const thread = ctx.requireThread(dialogs.threadId, "get_pending_dialogs", id);
  if (!thread) return Promise.resolve();
  // Worker-scoped: this worker hosts one conversation. Two sources merge into
  // one queue — the broker's own asks, and the grandchild relays (their live
  // frames bypass the broker, so the registry's retained frames are the only
  // rebuild source after a reload).
  // Broker asks of a PREVIOUS session on this worker (navigate_tree / fork
  // rebind) must not leak into the current conversation's read — filter to
  // the serving threadId; their settle path is unaffected.
  const entries: PendingDialogEntry[] = ctx.broker
    .pendingAll()
    .filter((entry) => entry.threadId === String(dialogs.threadId))
    .map((entry) => ({
      requestId: entry.requestId,
      threadId: entry.threadId,
      method: entry.request.method,
      payload: entry.request,
    }));
  for (const pending of ctx.subagentPendingDialogs()) {
    const entry = subagentDialogEntry(pending, dialogs.threadId);
    if (entry !== null) entries.push(entry);
  }
  ctx.success(id, "get_pending_dialogs", { dialogs: entries });
  return Promise.resolve();
};

/** Rebuild entry for a grandchild relay: same shape the live relay emits —
 * parent threadId, payload carrying subagentId/agent, frame headers stripped.
 * Frames without a string method cannot be normalized client-side; drop. */
function subagentDialogEntry(
  pending: PendingSubagentDialog,
  parentThreadId: string,
): PendingDialogEntry | null {
  const { type: _type, requestId: _requestId, threadId: _threadId, ...payload } = pending.frame;
  const { method } = pending.frame;
  if (typeof method !== "string" || method.length === 0) return null;
  // payload 保留 method：与 broker 条目同形（api.md「完整字段体」口径）
  return {
    requestId: pending.requestId,
    threadId: parentThreadId,
    method,
    payload: { ...payload, method, subagentId: pending.subagentId, agent: pending.agent },
  };
}
