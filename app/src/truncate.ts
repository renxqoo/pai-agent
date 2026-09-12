/**
 * Byte-capped string truncation shared by the subagent relay paths
 * (review B-P3-6): the marker stays INSIDE the cap so capped text never
 * exceeds its budget, and surrogate pairs are never split (a lone half
 * would surface as replacement characters downstream).
 */

export function truncateBytes(text: string, cap: number, marker: string): string {
  if (Buffer.byteLength(text, "utf8") <= cap) return text;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  // The marker is best-effort: when it is WIDER than the cap the result
  // degrades to a plain head cut — the byte cap holds unconditionally (a
  // bare marker would exceed it). A marker of exactly cap bytes still fits
  // (empty head + marker).
  const markerFits = markerBytes <= cap;
  const budget = markerFits ? cap - markerBytes : cap;
  let sliced = text.slice(0, budget);
  while (Buffer.byteLength(sliced, "utf8") > budget) {
    sliced = sliced.slice(0, -1);
  }
  const last = sliced.codePointAt(sliced.length - 1);
  if (last !== undefined && last >= 0xd800 && last <= 0xdbff) {
    sliced = sliced.slice(0, -1); // trailing high surrogate: its half is cut
  }
  return markerFits ? `${sliced}${marker}` : sliced;
}

/** Tail byte slicing with surrogate-pair safety (no marker). One pass over
 * the cap-sized window: the last `cap` CODE UNITS always contain any tail of
 * ≤ cap bytes (each unit carries at least one byte), so the cut point is
 * found by walking whole code points off the front, never by re-scanning. */
/** UTF-8 width of a code point below the astral plane (no nested ternaries). */
function utf8Bytes(cp: number): number {
  if (cp >= 0x800) return 3;
  if (cp >= 0x80) return 2;
  return 1;
}

export function tailBytes(text: string, cap: number): string {
  if (cap <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= cap) return text;
  const window = text.slice(-cap);
  let drop = 0; // code units to drop from the window's front
  let removed = 0; // utf-8 bytes removed so far
  const excess = Buffer.byteLength(window, "utf8") - cap;
  while (removed < excess) {
    const cp = window.codePointAt(drop);
    if (cp === undefined) break;
    removed += cp > 0xffff ? 4 : utf8Bytes(cp);
    drop += cp > 0xffff ? 2 : 1;
  }
  let sliced = window.slice(drop);
  const first = sliced.codePointAt(0);
  if (first !== undefined && first >= 0xdc00 && first <= 0xdfff) {
    sliced = sliced.slice(1); // leading low surrogate: its half is cut
  }
  return sliced;
}
