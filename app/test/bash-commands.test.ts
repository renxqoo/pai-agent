import { describe, expect, test } from "bun:test";
import { parseBashTimeoutMs } from "../src/bash-commands.ts";

/**
 * v0.6 bash wall clock parsing (design.md v0.6): table-driven matrix —
 * undefined falls back, 0 disables, bounds on both sides, garbage shapes
 * named-fail.
 */

const cases: Array<{ value: unknown; expected: "ok" | "error"; timeoutMs?: number }> = [
  { value: undefined, expected: "ok", timeoutMs: undefined },
  { value: 0, expected: "ok", timeoutMs: 0 },
  { value: 1, expected: "ok", timeoutMs: 1 },
  { value: 500, expected: "ok", timeoutMs: 500 },
  { value: 86_400_000, expected: "ok", timeoutMs: 86_400_000 },
  { value: 86_400_001, expected: "error" },
  { value: -1, expected: "error" },
  { value: 1.5, expected: "error" },
  { value: Number.NaN, expected: "error" },
  { value: Number.POSITIVE_INFINITY, expected: "error" },
  { value: "1000", expected: "error" },
  { value: null, expected: "error" },
  { value: true, expected: "error" },
];

describe("parseBashTimeoutMs (v0.6)", () => {
  for (const { value, expected, timeoutMs } of cases) {
    test(`${JSON.stringify(value)} -> ${expected}${timeoutMs !== undefined ? ` (${timeoutMs})` : ""}`, () => {
      const parsed = parseBashTimeoutMs(value);
      if (expected === "ok") {
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(parsed.timeoutMs).toBe(timeoutMs);
      } else {
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.error).toContain("timeoutMs must be an integer");
      }
    });
  }
});
