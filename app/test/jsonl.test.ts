import { describe, expect, test } from "bun:test";
import { createJsonlSplitter, MAX_LINE_BYTES } from "../src/jsonl.ts";

function collect(): { lines: string[]; splitter: ReturnType<typeof createJsonlSplitter> } {
  const lines: string[] = [];
  return { lines, splitter: createJsonlSplitter((line) => lines.push(line)) };
}

describe("jsonl splitter", () => {
  test("single complete line", () => {
    const { lines, splitter } = collect();
    splitter.push('{"a":1}\n');
    expect(lines).toEqual(['{"a":1}']);
  });
  test("multiple lines in one chunk", () => {
    const { lines, splitter } = collect();
    splitter.push('{"a":1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
  test("partial line across chunks is joined", () => {
    const { lines, splitter } = collect();
    splitter.push('{"a":');
    splitter.push("1}");
    splitter.push("\n");
    expect(lines).toEqual(['{"a":1}']);
  });
  test("trailing CR is stripped", () => {
    const { lines, splitter } = collect();
    splitter.push('{"a":1}\r\n');
    expect(lines).toEqual(['{"a":1}']);
  });
  test("empty lines are ignored", () => {
    const { lines, splitter } = collect();
    splitter.push('\n\n{"a":1}\n\n');
    expect(lines).toEqual(['{"a":1}']);
  });
  test("U+2028 and U+2029 do not split", () => {
    const { lines, splitter } = collect();
    splitter.push('{"a":"x\u2028y\u2029z"}\n');
    expect(lines).toEqual(['{"a":"x\u2028y\u2029z"}']);
  });
  test("LF inside a JSON string is preserved (not a delimiter before it)", () => {
    // Raw newline inside a JSON string is invalid JSON, but the splitter's
    // contract is transport-level: only \n boundaries split records.
    const { lines, splitter } = collect();
    splitter.push('{"a":"x\ny"}\n');
    expect(lines).toEqual(['{"a":"x', 'y"}']);
  });
  test("flush emits trailing line without newline", () => {
    const { lines, splitter } = collect();
    splitter.push('{"a":1}\n{"b":2}');
    expect(lines).toEqual(['{"a":1}']);
    splitter.flush();
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
  test("flush with empty buffer emits nothing", () => {
    const { lines, splitter } = collect();
    splitter.flush();
    splitter.push("\n");
    splitter.flush();
    expect(lines).toEqual([]);
  });
  test("flush strips trailing CR on remainder", () => {
    const { lines, splitter } = collect();
    splitter.push('{"a":1}\r');
    splitter.flush();
    expect(lines).toEqual(['{"a":1}']);
  });
});

describe("jsonl splitter: oversized line protection", () => {
  test("line without LF beyond limit is dropped and reported", () => {
    const lines: string[] = [];
    const overflows: number[] = [];
    const guarded = createJsonlSplitter(
      (line) => lines.push(line),
      (limit) => overflows.push(limit),
    );
    guarded.push(`${"x".repeat(1024)}\n`);
    guarded.push("y".repeat(MAX_LINE_BYTES + 1));
    guarded.push("\n");
    guarded.push('{"ok":1}\n');
    expect(lines).toEqual(["x".repeat(1024), '{"ok":1}']);
    expect(overflows).toEqual([MAX_LINE_BYTES]);
  });
  test("oversized complete line dropped without emitting", () => {
    const lines: string[] = [];
    const overflows: number[] = [];
    const splitter = createJsonlSplitter(
      (line) => lines.push(line),
      (limit) => overflows.push(limit),
    );
    splitter.push(`{"pad":"${"y".repeat(MAX_LINE_BYTES)}"}\n`);
    splitter.push('{"after":1}\n');
    expect(lines).toEqual(['{"after":1}']);
    expect(overflows.length).toBe(1);
  });
});
