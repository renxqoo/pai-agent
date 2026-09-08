/**
 * Direct-execution bash commands (the `bash` / `abort_bash` protocol pair):
 * shared permission gate, the v0.6 server-side wall clock, and the
 * user_bash extension hook. Extracted from worker-commands.ts (one verb,
 * one file). Streaming output rides the normal bash_execution_update event
 * frames; the final BashResult lands in the response.
 */

import { checkPermission } from "./backend/pi-coding-agent/permission-gate.ts";
import type { AbortBashCmd, BashCmd } from "./protocol.ts";
import type { Thread } from "./backend/pi-coding-agent/session-adapter.ts";
import type { WorkerContext, WorkerHandler } from "./worker-context.ts";

const BASH_CONFIRM_TIMEOUT_MS = 300_000;
const BASH_TIMEOUT_MAX_MS = 86_400_000;

/**
 * v0.6 direct-bash wall clock parsing (design.md v0.6): undefined = fall back
 * to the env default; integers 0..86_400_000 pass (0 = disable for this
 * command); anything else is a named failure. Pure + table-tested.
 */
export function parseBashTimeoutMs(
  value: unknown,
): { ok: true; timeoutMs: number | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, timeoutMs: undefined };
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > BASH_TIMEOUT_MAX_MS
  ) {
    return {
      ok: false,
      error: `timeoutMs must be an integer between 0 and ${BASH_TIMEOUT_MAX_MS} (0 disables the timeout)`,
    };
  }
  return { ok: true, timeoutMs: value };
}

export const handleBash: WorkerHandler = async (ctx, cmd, id) => {
  const bash = cmd as BashCmd & { id?: string };
  const thread = ctx.requireThread(bash.threadId, "bash", id);
  if (!thread) return;
  if (typeof bash.command !== "string" || bash.command.length === 0) {
    ctx.failure(id, "bash", "command must be a non-empty string");
    return;
  }
  const timeoutParse = parseBashTimeoutMs(bash.timeoutMs);
  if (!timeoutParse.ok) {
    ctx.failure(id, "bash", timeoutParse.error);
    return;
  }
  // Direct execution does not go through tool_call: gate it with the same
  // rules/dialog path as the agent's bash tool.
  const allowed = await confirmBashPermission({ ctx, bash, thread, id });
  if (!allowed) return;
  await executeDirectBash({ ctx, bash, thread, id, timeoutMs: timeoutParse.timeoutMs });
};

/** Post-permission execution: user_bash hook, wall clock, direct execution. */
async function executeDirectBash(deps: {
  ctx: WorkerContext;
  bash: BashCmd;
  thread: Thread;
  id: string | undefined;
  timeoutMs: number | undefined;
}): Promise<void> {
  const { ctx, bash, thread, id } = deps;
  // Mirror pi's RPC mode: extensions may observe or fully replace the
  // execution via the user_bash event.
  const eventResult = await thread.session.extensionRunner.emitUserBash({
    type: "user_bash",
    command: bash.command,
    excludeFromContext: bash.excludeFromContext === true,
    cwd: thread.session.sessionManager.getCwd(),
  });
  if (eventResult?.result) {
    thread.session.recordBashResult(bash.command, eventResult.result, {
      excludeFromContext: bash.excludeFromContext === true,
    });
    ctx.success(id, "bash", eventResult.result);
    return;
  }
  // v0.6 wall clock: the effective timeout is the command's timeoutMs (0 =
  // disabled) or the PAI_BASH_TIMEOUT_MS default; firing aborts via the same
  // abortBash the client's abort_bash uses, so the result comes back as a
  // normal cancelled:true BashResult (never a failure).
  const effectiveTimeoutMs = deps.timeoutMs ?? ctx.bashTimeoutMs;
  const timeoutTimer =
    effectiveTimeoutMs > 0
      ? setTimeout(() => void thread.session.abortBash(), effectiveTimeoutMs)
      : undefined;
  // Streaming output arrives as bash_execution_update events (carrying this
  // command's id) through the normal event frames.
  const inflight = ctx.registerInflight(() => thread.session.abortBash());
  try {
    const result = await thread.session.executeBash(bash.command, undefined, {
      excludeFromContext: bash.excludeFromContext === true,
      id,
      ...(eventResult?.operations !== undefined ? { operations: eventResult.operations } : {}),
    });
    ctx.success(id, "bash", result);
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    inflight.unregister();
  }
}

async function confirmBashPermission(deps: {
  ctx: WorkerContext;
  bash: BashCmd;
  thread: Thread;
  id: string | undefined;
}): Promise<boolean> {
  const { ctx, bash, thread, id } = deps;
  const check = await checkPermission({
    tool: "bash",
    value: bash.command,
    ask: async (title: string, value: string) => {
      const response = await ctx.broker.ask(
        thread.session.sessionId,
        { method: "confirm", title, message: value },
        { timeout: BASH_CONFIRM_TIMEOUT_MS },
      );
      return response?.["confirmed"] === true;
    },
    threadId: thread.session.sessionId,
    injectedRules: ctx.sessions.getInjectedRules(),
  });
  if (check.block) {
    ctx.failure(id, "bash", check.reason ?? "Blocked by permission rules");
    return false;
  }
  return true;
}

export const handleAbortBash: WorkerHandler = (ctx, cmd, id) => {
  const abortBash = cmd as AbortBashCmd & { id?: string };
  const thread = ctx.requireThread(abortBash.threadId, "abort_bash", id);
  if (!thread) return Promise.resolve();
  thread.session.abortBash();
  ctx.success(id, "abort_bash");
  return Promise.resolve();
};
