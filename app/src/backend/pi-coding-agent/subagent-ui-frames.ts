/**
 * Bounded retention of grandchild ui_request frames (design.md v0.14): the
 * get_pending_dialogs rebuild source. Two bounds — a per-grandchild entry cap
 * (a never-answered burst is a protocol violation, same treatment as a
 * malformed frame; expired entries are pruned at admission so the cap counts
 * only answerable dialogs) and a read-face TTL (the grandchild's own dialog
 * timeout never notifies the parent; without the TTL every reload would
 * resurrect a dead dialog).
 */

/** Per-grandchild cap on retained ui_request frames (bounded retention). */
export const MAX_PENDING_UI_FRAMES = 16;
/** Per-frame byte cap: dialogs are small prompts (title/message); a larger
 * frame is a protocol violation. Makes the retention bound byte-true, not
 * just count-true: the table's worst case is 16 × this cap per grandchild. */
export const MAX_PENDING_UI_FRAME_BYTES = 64 * 1024;
/** Read-face TTL: hide retained frames older than any grandchild-side dialog
 * timeout (300s confirm cap + slack). */
export const PENDING_DIALOG_TTL_MS = 600_000;

export interface RetainedUiFrame {
  frame: Record<string, unknown>;
  at: number;
}

/** true = the raw ui_request line exceeds the per-frame byte cap (caller
 * treats it as a protocol violation — same treatment as a malformed frame). */
export function pendingUiFrameTooLarge(line: string): boolean {
  return Buffer.byteLength(line, "utf8") > MAX_PENDING_UI_FRAME_BYTES;
}

/** The full admission decision for one inbound ui_request line, so every
 * bound (requestId shape, live-count, frame bytes) lives beside its
 * constants. Pure: the caller owns the map mutation and the fatal handling. */
export function retainUiFrame(
  frames: Map<string, RetainedUiFrame>,
  candidate: { line: string; requestId: unknown },
  now: number,
): { ok: true; requestId: string } | { ok: false; reason: string } {
  const { line, requestId } = candidate;
  // A ui_request the client could never answer (ui_response routes by
  // requestId) is malformed — relaying it would surface a dialog that no
  // response and no reload can settle.
  if (typeof requestId !== "string" || requestId.length === 0) {
    return { ok: false, reason: "grandchild sent a malformed ui_request" };
  }
  if (exceedsPendingUiCap(frames, requestId, now)) {
    return { ok: false, reason: "grandchild exceeded the pending dialog cap" };
  }
  if (pendingUiFrameTooLarge(line)) {
    return { ok: false, reason: "grandchild exceeded the pending dialog frame size cap" };
  }
  return { ok: true, requestId };
}

/** true = admitting this frame would exceed the cap (caller treats it as a
 * protocol violation). Expired entries are pruned first — they are dead
 * dialogs (the grandchild-side timeout never notifies the parent), so the
 * cap must count only genuinely answerable frames; counting stale entries
 * would kill a healthy task on its 17th dialog while the read face reports
 * zero pending. Re-arming a known requestId never trips the cap. */
export function exceedsPendingUiCap(
  frames: Map<string, RetainedUiFrame>,
  requestId: string,
  now: number,
): boolean {
  for (const [id, entry] of Array.from(frames)) {
    if (now - entry.at > PENDING_DIALOG_TTL_MS) frames.delete(id);
  }
  return frames.size >= MAX_PENDING_UI_FRAMES && !frames.has(requestId);
}

/** TTL-filtered read face (arrival order); routing table untouched. */
export function pendingUiFrameList(
  frames: Map<string, RetainedUiFrame>,
  now: number,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const entry of frames.values()) {
    if (now - entry.at <= PENDING_DIALOG_TTL_MS) out.push(entry.frame);
  }
  return out;
}
