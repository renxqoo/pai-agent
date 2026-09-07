import { describe, expect, test } from "bun:test";
import { tailBytes, truncateBytes } from "../src/truncate.ts";

/**
 * Byte-capped truncation (review B-P3-6): the marker stays inside the cap
 * and surrogate pairs are never split.
 */

describe("truncateBytes", () => {
  test("short text passes through unchanged", () => {
    expect(truncateBytes("hello", 100, "…")).toBe("hello");
  });

  test("marker stays inside the cap", () => {
    const out = truncateBytes("x".repeat(10 * 1024), 1024, "\n[truncated]");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(1024);
    expect(out.endsWith("[truncated]")).toBe(true);
  });

  test("multi-byte text truncates on the byte budget", () => {
    const out = truncateBytes("é".repeat(1024), 1024, "[cut]"); // é = 2 bytes
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(1024);
    expect(out.endsWith("[cut]")).toBe(true);
    expect(out.includes("\uFFFD")).toBe(false);
  });

  test("never splits a surrogate pair (emoji)", () => {
    // 😀 is a surrogate pair (4 bytes); craft text so the naive slice lands
    // between the high and low half.
    const text = `a${"😀".repeat(600)}`;
    const out = truncateBytes(text, 1025, "[cut]");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(1025);
    expect(out.includes("\uFFFD")).toBe(false);
    // The body is well-formed UTF-16: every surrogate is part of a pair.
    const body = out.slice(0, out.indexOf("[cut]"));
    expect(wellFormedUtf16(body)).toBe(true);
  });
});

describe("tailBytes", () => {
  test("short text passes through", () => {
    expect(tailBytes("tail", 100)).toBe("tail");
  });

  test("keeps the tail within the byte cap without lone surrogates", () => {
    const text = `${"😀".repeat(600)}z`;
    const out = tailBytes(text, 128);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(128);
    expect(out.includes("\uFFFD")).toBe(false);
    // No lone leading surrogate either (only complete pairs at the head).
    expect(wellFormedUtf16(out)).toBe(true);
  });
});

/** Every surrogate must be part of a complete pair (no lone halves). */
function wellFormedUtf16(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
