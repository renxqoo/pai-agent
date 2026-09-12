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

/**
 * 对抗处置（adv-fuzz F5/F6）：maxLineBytes 名义是字节、实按 UTF-16 code unit
 * 计——CJK 行（60 字 = 180 字节）能穿过 100「字节」上限，缓冲上界放大 3 倍；
 * 溢出上报按 push 边界触发，同一条被丢的行可因分块方式不同重复上报。
 */
/** Feed chunks through a splitter recording emitted lines + overflow reports. */
function record(
  chunks: string[],
  maxLineBytes: number,
): { lines: string[]; overflowCalls: number } {
  const lines: string[] = [];
  let overflowCalls = 0;
  const splitter = createJsonlSplitter(
    (line) => {
      lines.push(line);
    },
    () => {
      overflowCalls += 1;
    },
    maxLineBytes,
  );
  for (const chunk of chunks) splitter.push(chunk);
  splitter.flush();
  return { lines, overflowCalls };
}

describe("jsonl line cap is byte-true and reports each dropped line once (adversarial)", () => {
  test("症状回归 F6「按 code unit 计」：60 个 CJK 字符（180 字节）对 100 字节上限必须被丢", () => {
    const { lines, overflowCalls } = record([`${"一".repeat(60)}\n`], 100);
    expect(lines).toEqual([]);
    expect(overflowCalls).toBe(1);
  });

  test("症状回归 F5「分块相关重复上报」：同一行无论怎么分块恰好上报一次", () => {
    expect(record(["xxxxxxxxxxxx\n"], 5).overflowCalls).toBe(1); // 整块喂入
    expect(record(["xxxxxx", "xxxxxx", "\n"], 5).overflowCalls).toBe(1); // 分三块
  });

  test("跨块代理对不虚增字节数：块边界劈开代理对时短行不得被误丢", () => {
    // 一对代理对被块边界劈开时，byteLength(a)+byteLength(b) 比拼接后多 2
    // 字节（3+3 的替换编码拼成 4 字节代理对）——增量记账必须校正，否则
    // 35 字节的合法行会在第 39 字节上限下被整行误丢（分块不变性破坏）。
    const line = "ab\ud800\udc00cd"; // 6 units, 8 bytes
    const chunks = ["x\n", "ab\ud800", "\udc00cd"]; // 劈在高/低代理之间：5+5 记账 vs 实际 8
    const { lines, overflowCalls } = record(chunks, 8);
    expect(lines).toEqual(["x", line]);
    expect(overflowCalls).toBe(0);
  });

  test("合法尺寸行不受影响（含多字节）", () => {
    const { lines, overflowCalls } = record(['{"k":"值"}\n'], 100);
    expect(lines).toEqual(['{"k":"值"}']);
    expect(overflowCalls).toBe(0);
  });
});
