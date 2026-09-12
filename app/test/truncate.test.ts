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

/** 多字节密集文本下尾部裁剪必须一次定位切点：逐字符回退 + 每步全量重扫
 * byteLength 是 O(cap²)（CJK 下最坏数万次迭代、GB 级字节扫描），会拖垮
 * 每事件热路径（inflight 保留、subagent 尾部）。此测试锁定耗时上界。 */
describe("tailBytes (multibyte hot path)", () => {
  test("大体积 CJK 文本在时间预算内完成且语义正确", () => {
    const text = "汉".repeat(2_000_000); // ~6 MB utf-8
    const cap = 64 * 1024;
    const startedAt = performance.now();
    const out = tailBytes(text, cap);
    const elapsed = performance.now() - startedAt;
    expect(Buffer.byteLength(out, "utf8") <= cap).toBe(true);
    expect(out).toBe("汉".repeat(Math.floor(cap / 3)));
    expect(elapsed).toBeLessThan(50);
  });
});

/** 对抗处置（adv-fuzz F1）：marker 自身宽于 cap 时 budget 归零、返回裸
 * marker——突破字节上限。marker 是尽力而为：放不下时退化为无 marker 的
 * 字节安全切头，上限恒成立。 */
describe("truncateBytes (marker wider than cap)", () => {
  test('cap=2、marker="..."：结果不超 2 字节（不再返回裸 marker）', () => {
    const out = truncateBytes("abcdefgh", 2, "...");
    expect(Buffer.byteLength(out, "utf8") <= 2).toBe(true);
  });
});
