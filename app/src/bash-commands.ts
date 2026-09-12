/**
 * Direct-execution bash commands (the `bash` / `abort_bash` protocol pair):
 * shared permission gate, the v0.6 server-side wall clock, and the
 * user_bash extension hook. Extracted from worker-commands.ts (one verb,
 * one file). Streaming output rides the normal bash_execution_update event
 * frames; the final BashResult lands in the response.
 */

import type { AbortBashCmd, BashCmd } from "./protocol.ts";
import type { PaiThread } from "./backend/ports/session.ts";
import type { InflightState } from "./inflight-state.ts";
import type { WorkerContext, WorkerHandler } from "./worker-context.ts";

const BASH_CONFIRM_TIMEOUT_MS = 300_000;
const BASH_TIMEOUT_MAX_MS = 86_400_000;

/**
 * Admission-window abort controllers per session id. abort_bash during the
 * permission dialog must cancel the pending admission itself (settle its
 * dialog, never execute) — session.abortBash alone cannot reach a command
 * that has not entered executeBash yet. Entries live only between the claim
 * and the admission's finally (unregistered on every exit path).
 */
const admissionAborts = new Map<string, Set<AbortController>>();

function registerAdmissionAbort(sessionId: string, controller: AbortController): void {
  const set = admissionAborts.get(sessionId);
  if (set === undefined) {
    admissionAborts.set(sessionId, new Set([controller]));
    return;
  }
  set.add(controller);
}

function unregisterAdmissionAbort(sessionId: string, controller: AbortController): void {
  const set = admissionAborts.get(sessionId);
  if (set === undefined) return;
  set.delete(controller);
  if (set.size === 0) admissionAborts.delete(sessionId);
}

/** Abort every admission still parked at this session's permission gate. */
function abortAdmissions(sessionId: string): void {
  const set = admissionAborts.get(sessionId);
  if (set === undefined) return;
  admissionAborts.delete(sessionId);
  for (const controller of Array.from(set)) controller.abort();
}

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
  // api.md allows concurrent direct bash; id-less commands share one slot, so
  // a second concurrent id-less command would corrupt the in-flight face (and
  // its end would clear the first's). The slot must be claimed synchronously
  // at admission — before the permission dialog can park this command for up
  // to BASH_CONFIRM_TIMEOUT_MS — because the worker dispatches commands
  // concurrently; checking without claiming leaves a race window.
  // Capture the inflight state AND the session at admission: a fork/clone
  // rebind can swap both mid-flight (the dialog parks for minutes), and a
  // late-bound `thread.*` would release the slot on — or execute against —
  // the POST-rebind generation. The captured generation is the one this
  // command was admitted under; releasing it after a rebind is a no-op on
  // the discarded state.
  const { inflight, session } = thread;
  const bashId = id ?? "";
  const claimed = inflight.beginBash(bashId, bash.command);
  if (!claimed) {
    ctx.failure(id, "bash", admissionConflictError(inflight, bashId));
    return;
  }
  const admission = new AbortController();
  registerAdmissionAbort(session.sessionId, admission);
  try {
    const outcome = await awaitAdmission({ ctx, bash, session, id, signal: admission.signal });
    if (outcome !== "allowed") return;
    await executeDirectBash({ ctx, bash, session, id, timeoutMs: timeoutParse.timeoutMs });
  } finally {
    unregisterAdmissionAbort(session.sessionId, admission);
    inflight.endBash(bashId);
  }
};

/** Admission failure wording follows the conflict class: an empty-slot
 * conflict means a concurrent id-less command; a non-empty id that is taken
 * is a duplicate id (both commands supplied one) — conflating them misleads
 * the client. A free slot with a rejected claim means the table is full. */
function admissionConflictError(
  inflight: Pick<InflightState, "isBashRunning">,
  bashId: string,
): string {
  if (!inflight.isBashRunning(bashId)) {
    return "too many concurrent direct bash executions (limit reached)";
  }
  return bashId === ""
    ? "concurrent direct bash requires a command id"
    : "bash command id is already in use";
}

/** The admission race: permission gate vs abort_bash. abort_bash during the
 * window (the dialog parks for up to BASH_CONFIRM_TIMEOUT_MS) must cancel
 * the admission itself — the abort resolves the race first, execution never
 * starts, the abort owns the failure frame, and the loser's own denial frame
 * is suppressed (exactly one response per command). */
async function awaitAdmission(deps: {
  ctx: WorkerContext;
  bash: BashCmd;
  session: PaiThread["session"];
  id: string | undefined;
  signal: AbortSignal;
}): Promise<"allowed" | "denied" | "aborted"> {
  const { ctx, bash, session, id, signal } = deps;
  const permission = confirmBashPermission({ ctx, bash, session, id, signal });
  const aborted = new Promise<"aborted">((resolve) => {
    signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  const outcome = await Promise.race([
    permission.then((allowed) => (allowed ? ("allowed" as const) : ("denied" as const))),
    aborted,
  ]);
  if (outcome === "aborted") {
    permission.catch(() => {}); // loser: real errors after abort are moot
    ctx.failure(id, "bash", "aborted before execution started");
  }
  return outcome;
}

/** Post-permission execution: user_bash hook, wall clock, direct execution.
 * Runs against the session captured at admission (rebind-safe). */
async function executeDirectBash(deps: {
  ctx: WorkerContext;
  bash: BashCmd;
  session: PaiThread["session"];
  id: string | undefined;
  timeoutMs: number | undefined;
}): Promise<void> {
  const { ctx, bash, session, id } = deps;
  // Mirror pi's RPC mode: extensions may observe or fully replace the
  // execution via the user_bash event.
  const eventResult = await session.extensionRunner.emitUserBash({
    type: "user_bash",
    command: bash.command,
    excludeFromContext: bash.excludeFromContext === true,
    cwd: session.sessionManager.getCwd(),
  });
  if (eventResult?.result) {
    session.recordBashResult(bash.command, eventResult.result, {
      excludeFromContext: bash.excludeFromContext === true,
    });
    ctx.success(id, "bash", eventResult.result);
    return;
  }
  await runDirectBash(deps, eventResult);
}

/** The non-replaced execution path: wall clock, in-flight face, executeBash. */
async function runDirectBash(
  deps: {
    ctx: WorkerContext;
    bash: BashCmd;
    session: PaiThread["session"];
    id: string | undefined;
    timeoutMs: number | undefined;
  },
  eventResult: { operations?: unknown } | undefined,
): Promise<void> {
  const { ctx, bash, session, id } = deps;
  // v0.6 wall clock: the effective timeout is the command's timeoutMs (0 =
  // disabled) or the PAI_BASH_TIMEOUT_MS default; firing aborts via the same
  // abortBash the client's abort_bash uses, so the result comes back as a
  // normal cancelled:true BashResult (never a failure).
  const effectiveTimeoutMs = deps.timeoutMs ?? ctx.bashTimeoutMs;
  const timeoutTimer =
    effectiveTimeoutMs > 0
      ? setTimeout(() => void session.abortBash(), effectiveTimeoutMs)
      : undefined;
  // Streaming output arrives as bash_execution_update events (carrying this
  // command's id) through the normal event frames.
  const inflight = ctx.registerInflight(() => session.abortBash());
  try {
    const result = await session.executeBash(bash.command, undefined, {
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
  session: PaiThread["session"];
  id: string | undefined;
  signal?: AbortSignal;
}): Promise<boolean> {
  const { ctx, bash, session, id, signal } = deps;
  // v0.12 B: a command the OS sandbox will silently contain needs no
  // advisory ask — the fallback ask auto-allows (allow/block rules above it
  // still win). Degraded/inactive runtime ⇒ oracle false ⇒ ask as before.
  const sandboxSilent = ctx.sessions.containmentOracle?.().silentBash() === true;
  const check = await ctx.checkPermission({
    tool: "bash",
    value: bash.command,
    ask: sandboxSilent
      ? async () => true
      : async (title: string, value: string) => {
          const response = await ctx.broker.ask(
            session.sessionId,
            { method: "confirm", title, message: value },
            { timeout: BASH_CONFIRM_TIMEOUT_MS, ...(signal ? { signal } : {}) },
          );
          return response?.["confirmed"] === true;
        },
    threadId: session.sessionId,
    injectedRules: ctx.sessions.getInjectedRules(),
  });
  if (check.block) {
    // Suppressed when an admission abort already won the race: the abort
    // owns the failure response (exactly one frame per command).
    if (!signal?.aborted) ctx.failure(id, "bash", check.reason ?? "Blocked by permission rules");
    return false;
  }
  return true;
}

export const handleAbortBash: WorkerHandler = (ctx, cmd, id) => {
  const abortBash = cmd as AbortBashCmd & { id?: string };
  const thread = ctx.requireThread(abortBash.threadId, "abort_bash", id);
  if (!thread) return Promise.resolve();
  // Cancel any admission still parked at this session's permission gate
  // first (those dialogs settle as unanswered and never execute), then the
  // session-level abort reaches commands already inside executeBash.
  abortAdmissions(thread.session.sessionId);
  thread.session.abortBash();
  ctx.success(id, "abort_bash");
  return Promise.resolve();
};
