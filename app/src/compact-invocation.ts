/**
 * v0.11 prompt-path /compact interception (design.md「恰好一次」exception):
 * a line-start /compact never reaches the model — the hub runs the compact
 * operation instead, with compact timing (the response settles when the
 * operation does, command field stays "prompt"). Same layer and priority as
 * the skill-pointer rewrite, ahead of SDK extension commands.
 */

import type { ImagePayload } from "./protocol.ts";
import type { PaiThread } from "./backend/ports/session.ts";
import type { WorkerContext } from "./worker-context.ts";

/** Lexing: strict line start, case-sensitive — bare "/compact" or
 * "/compact" followed by whitespace. customInstructions is the trailing
 * text trimmed at both ends (interior whitespace kept); an empty remainder
 * means undefined. A non-match ("/compactfoo", leading whitespace,
 * "/COMPACT") returns undefined: the message passes through as an ordinary
 * prompt. */
export function parseCompactInvocation(
  message: string,
): { customInstructions: string | undefined } | undefined {
  if (message === "/compact") return { customInstructions: undefined };
  if (!message.startsWith("/compact")) return undefined;
  const rest = message.slice("/compact".length);
  if (!/^\s/.test(rest)) return undefined;
  const instructions = rest.trim();
  return { customInstructions: instructions.length > 0 ? instructions : undefined };
}

/** Compact timing, not fire-and-accept: inflight registration mirrors the
 * compact command (abortCompaction; shutdown semantics inherited), the
 * result rides the success response, and a compact() rejection propagates
 * to the dispatcher's catch as the failure response. */
async function runCompactInvocation(deps: {
  ctx: WorkerContext;
  thread: PaiThread;
  id: string | undefined;
  customInstructions: string | undefined;
  images: ImagePayload[] | undefined;
}): Promise<void> {
  const { ctx, thread, id } = deps;
  if (deps.images !== undefined && deps.images.length > 0) {
    ctx.failure(id, "prompt", "Compact command does not accept images");
    return;
  }
  if (thread.session.isCompacting) {
    ctx.failure(id, "prompt", "Compaction already in progress");
    return;
  }
  const inflight = ctx.registerInflight(() => thread.session.abortCompaction());
  try {
    const result = await thread.session.compact(deps.customInstructions);
    ctx.success(id, "prompt", result);
  } finally {
    inflight.unregister();
  }
}

/** The prompt-path interception seam: returns the invocation promise when
 * the message lexically hits AND the backend declares session.compact,
 * otherwise undefined (pass through verbatim — a backend without the bit
 * has no directory entry either, so a typed /compact is just an unknown
 * command). */
export function tryCompactInvocation(deps: {
  ctx: WorkerContext;
  thread: PaiThread;
  message: string;
  images: ImagePayload[] | undefined;
  id: string | undefined;
}): Promise<void> | undefined {
  if (!deps.ctx.capabilities.has("session.compact")) return undefined;
  const invocation = parseCompactInvocation(deps.message);
  if (invocation === undefined) return undefined;
  return runCompactInvocation({
    ctx: deps.ctx,
    thread: deps.thread,
    id: deps.id,
    customInstructions: invocation.customInstructions,
    images: deps.images,
  });
}
