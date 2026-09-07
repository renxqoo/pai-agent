/**
 * Byte-capped string truncation shared by the subagent relay paths
 * (review B-P3-6): the marker stays INSIDE the cap so capped text never
 * exceeds its budget, and surrogate pairs are never split (a lone half
 * would surface as replacement characters downstream).
 */

export function truncateBytes(text: string, cap: number, marker: string): string {
  if (Buffer.byteLength(text, "utf8") <= cap) return text;
  const budget = Math.max(0, cap - Buffer.byteLength(marker, "utf8"));
  let sliced = text.slice(0, budget);
  while (Buffer.byteLength(sliced, "utf8") > budget) {
    sliced = sliced.slice(0, -1);
  }
  const last = sliced.codePointAt(sliced.length - 1);
  if (last !== undefined && last >= 0xd800 && last <= 0xdbff) {
    sliced = sliced.slice(0, -1); // trailing high surrogate: its half is cut
  }
  return `${sliced}${marker}`;
}

/** Tail byte slicing with surrogate-pair safety (no marker). */
export function tailBytes(text: string, cap: number): string {
  if (Buffer.byteLength(text, "utf8") <= cap) return text;
  let sliced = text.slice(-cap);
  while (Buffer.byteLength(sliced, "utf8") > cap) {
    sliced = sliced.slice(1);
  }
  const first = sliced.codePointAt(0);
  if (first !== undefined && first >= 0xdc00 && first <= 0xdfff) {
    sliced = sliced.slice(1); // leading low surrogate: its half is cut
  }
  return sliced;
}
