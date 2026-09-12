import { describe, expect, test } from "bun:test";
import {
  createInflightState,
  INFLIGHT_MAX_TRACKED_CALLS,
  INFLIGHT_MAX_TRACKED_BASH,
  INFLIGHT_OUTPUT_CAP_BYTES,
  textOfToolSnapshot,
} from "../src/inflight-state.ts";
import { tailBytes } from "../src/truncate.ts";

/**
 * v0.14 in-flight retention (design.md v0.14): the facts get_inflight serves.
 * Invariants under test: bound by construction (byte cap keeps the tail and
 * marks truncation; capped call table evicts oldest), tool snapshots REPLACE
 * (the SDK hands cumulative snapshots — appending would duplicate output), a
 * settled call / ended turn drops its entries immediately, and the turn
 * boundary is the entry id recorded at agent_start.
 */

describe("inflight retention (v0.14)", () => {
  test("empty form before anything happens", () => {
    const inflight = createInflightState(INFLIGHT_OUTPUT_CAP_BYTES, () => 1_000);
    expect(inflight.snapshot()).toEqual({
      turnStartEntryId: null,
      turnStartedAt: null,
      toolOutputs: [],
      bash: null,
    });
  });

  test("turn boundary: beginTurn pins the leaf id; endTurn drops the turn but keeps a running bash", () => {
    const inflight = createInflightState(INFLIGHT_OUTPUT_CAP_BYTES, () => 1_000);
    inflight.beginTurn("e42", 1_234);
    inflight.noteToolStart("c1");
    inflight.noteToolUpdate("c1", { content: "partial" });
    inflight.beginBash("r9", "ls -la");
    inflight.noteBashOutput("r9", "total 0\n");

    expect(inflight.snapshot().turnStartEntryId).toBe("e42");
    // 轮首时刻与边界同点采集：客户端跨重载续算计时（不再从刷新时刻从 0 起算）
    expect(inflight.snapshot().turnStartedAt).toBe(1_234);
    inflight.endTurn();
    // 症状回归「模型轮先结算 → 并发直执行 bash 的在途面被清」：bash 由 begin/endBash 独立管理
    expect(inflight.snapshot()).toEqual({
      turnStartEntryId: null,
      turnStartedAt: null,
      toolOutputs: [],
      bash: { command: "ls -la", output: "total 0\n", truncated: false, startedAt: 1_000 },
    });
    inflight.endBash("r9");
    expect(inflight.snapshot()).toEqual({
      turnStartEntryId: null,
      turnStartedAt: null,
      toolOutputs: [],
      bash: null,
    });
  });

  test("tool snapshots replace, never append (cumulative SDK payload)", () => {
    const inflight = createInflightState(INFLIGHT_OUTPUT_CAP_BYTES, () => 1_000);
    inflight.noteToolStart("c1");
    inflight.noteToolUpdate("c1", { content: "line 1\n" });
    inflight.noteToolUpdate("c1", { content: "line 1\nline 2\n" });
    expect(inflight.snapshot().toolOutputs).toEqual([
      { callId: "c1", output: "line 1\nline 2\n", truncated: false, startedAt: 1_000 },
    ]);
  });

  test("unknown callId updates are ignored (no ghost entries)", () => {
    const inflight = createInflightState(INFLIGHT_OUTPUT_CAP_BYTES, () => 1_000);
    inflight.noteToolUpdate("ghost", { content: "x" });
    inflight.noteToolEnd("ghost");
    expect(inflight.snapshot().toolOutputs).toEqual([]);
  });

  test("tool end drops the call immediately", () => {
    const inflight = createInflightState(INFLIGHT_OUTPUT_CAP_BYTES, () => 1_000);
    inflight.noteToolStart("c1");
    inflight.noteToolUpdate("c1", { content: "x" });
    inflight.noteToolEnd("c1");
    expect(inflight.snapshot().toolOutputs).toEqual([]);
  });

  test("byte cap keeps the newest tail and marks truncation", () => {
    const inflight = createInflightState(8, () => 2_000);
    inflight.noteToolStart("c1");
    inflight.noteToolUpdate("c1", { content: "0123456789ABCDEF" });
    const [entry] = inflight.snapshot().toolOutputs;
    expect(entry?.output).toBe("89ABCDEF");
    expect(entry?.truncated).toBe(true);
  });

  test("default cap: text at the cap is retained whole and untruncated", () => {
    const inflight = createInflightState(INFLIGHT_OUTPUT_CAP_BYTES, () => 1_000);
    inflight.noteToolStart("c1");
    const exact = "x".repeat(INFLIGHT_OUTPUT_CAP_BYTES);
    inflight.noteToolUpdate("c1", { content: exact });
    const [entry] = inflight.snapshot().toolOutputs;
    expect(entry?.output.length).toBe(INFLIGHT_OUTPUT_CAP_BYTES);
    expect(entry?.truncated).toBe(false);
  });

  test("call table evicts the oldest beyond the cap", () => {
    const inflight = createInflightState(INFLIGHT_OUTPUT_CAP_BYTES, () => 1_000);
    for (let index = 0; index <= INFLIGHT_MAX_TRACKED_CALLS; index += 1) {
      inflight.noteToolStart(`c${index}`);
    }
    const ids = inflight.snapshot().toolOutputs.map((entry) => entry.callId);
    expect(ids).toHaveLength(INFLIGHT_MAX_TRACKED_CALLS);
    expect(ids).not.toContain("c0");
    expect(ids).toContain(`c${INFLIGHT_MAX_TRACKED_CALLS}`);
  });

  test("bash tail appends deltas, is bounded, and ends cleanly", () => {
    const inflight = createInflightState(8, () => 2_000);
    inflight.beginBash("r1", "pytest");
    inflight.noteBashOutput("r1", "012345");
    inflight.noteBashOutput("r1", "6789ABC");
    expect(inflight.snapshot().bash).toEqual({
      command: "pytest",
      output: "56789ABC",
      truncated: true,
      startedAt: 2_000,
    });
    inflight.endBash("r1");
    expect(inflight.snapshot().bash).toBeNull();
  });

  test("bash deltas without a running command are dropped", () => {
    const inflight = createInflightState(INFLIGHT_OUTPUT_CAP_BYTES, () => 1_000);
    inflight.noteBashOutput("orphan", "orphan");
    expect(inflight.snapshot().bash).toBeNull();
  });

  test("症状回归「并发直执行 bash 在途面互相覆盖/提前清态」：per-id 保留，先结束的只清自己", () => {
    const inflight = createInflightState(INFLIGHT_OUTPUT_CAP_BYTES, () => 1_000);
    inflight.beginBash("r1", "sleep 60");
    inflight.beginBash("r2", "echo hi");
    inflight.noteBashOutput("r2", "hi\n");
    // 读口取最新在途条目（客户端是单面横幅，与 live 事件单面同口径）
    expect(inflight.snapshot().bash).toEqual({
      command: "echo hi",
      output: "hi\n",
      truncated: false,
      startedAt: 1_000,
    });
    // 第二条结束不得清掉仍在跑的第一条（单槽 finally endBash 会把在跑的清成 null）
    inflight.endBash("r2");
    expect(inflight.snapshot().bash).toEqual({
      command: "sleep 60",
      output: "",
      truncated: false,
      startedAt: 1_000,
    });
    inflight.endBash("r1");
    expect(inflight.snapshot().bash).toBeNull();
  });

  test("并发 bash 输出按 id 隔离（不串台）", () => {
    const inflight = createInflightState(INFLIGHT_OUTPUT_CAP_BYTES, () => 1_000);
    inflight.beginBash("r1", "first");
    inflight.beginBash("r2", "second");
    inflight.noteBashOutput("r1", "from-first\n");
    inflight.noteBashOutput("r2", "from-second\n");
    expect(inflight.snapshot().bash?.output).toBe("from-second\n");
    inflight.endBash("r2");
    expect(inflight.snapshot().bash?.command).toBe("first");
    expect(inflight.snapshot().bash?.output).toBe("from-first\n");
  });

  test("并发直执行超出上界按最旧驱逐（有界保留）", () => {
    const inflight = createInflightState(INFLIGHT_OUTPUT_CAP_BYTES, () => 1_000);
    for (let index = 0; index <= 8; index += 1) inflight.beginBash(`r${index}`, `cmd-${index}`);
    inflight.endBash("r8");
    // r0 被驱逐后不再出现在读口；仍在跑的 r1..r7 里最新的是 r7
    expect(inflight.snapshot().bash?.command).toBe("cmd-7");
    inflight.endBash("r7");
    expect(inflight.snapshot().bash?.command).toBe("cmd-6");
  });

  test("症状回归「CJK 输出按码元而非字节截断」：尾部按字节封顶且不劈代理对", () => {
    const inflight = createInflightState(9, () => 1_000); // 9 bytes = 3 个 CJK 字符
    inflight.noteToolStart("c1");
    inflight.noteToolUpdate("c1", { content: "x一二三四五" }); // 1 + 15 = 16 bytes
    const [entry] = inflight.snapshot().toolOutputs;
    expect(entry?.output).toBe("三四五");
    expect(entry?.truncated).toBe(true);
    expect(Buffer.byteLength(entry?.output ?? "", "utf8")).toBe(9);
  });

  test("emoji 代理对不被截半（尾字节对齐到字符边界，保最新）", () => {
    const inflight = createInflightState(4, () => 1_000); // 4 bytes 装不下 emoji(4B)+尾字符(1B)
    inflight.noteToolStart("c1");
    inflight.noteToolUpdate("c1", { content: "a\u{1F600}b" }); // 1 + 4 + 1 = 6 bytes
    const [entry] = inflight.snapshot().toolOutputs;
    // 保尾语义：装得下的最新内容是尾字符，绝不输出半个代理对
    expect(entry?.output).toBe("b");
    expect(entry?.truncated).toBe(true);
  });

  test("empty callId is ignored (no keyless entry)", () => {
    const inflight = createInflightState(INFLIGHT_OUTPUT_CAP_BYTES, () => 1_000);
    inflight.noteToolStart("");
    inflight.noteToolUpdate("", "x");
    expect(inflight.snapshot().toolOutputs).toEqual([]);
  });
});

describe("textOfToolSnapshot (SDK cumulative snapshot shape)", () => {
  test("joins text blocks", () => {
    expect(
      textOfToolSnapshot({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
  });

  test("accepts a plain string content", () => {
    expect(textOfToolSnapshot({ content: "raw" })).toBe("raw");
  });

  test("garbage shapes degrade to empty string", () => {
    expect(textOfToolSnapshot(null)).toBe("");
    const missing: unknown = undefined;
    expect(textOfToolSnapshot(missing)).toBe("");
    expect(textOfToolSnapshot("x")).toBe("");
    expect(textOfToolSnapshot({})).toBe("");
    expect(textOfToolSnapshot({ content: [{ type: "image", data: "..." }] })).toBe("");
  });
});

/**
 * 并发直执行的准入依赖 beginBash/endBash 槽位表（bash-commands 的守卫以
 * isBashRunning("") 为判据）。bash 表中的条目全部是运行中（endBash 即删），
 * 因此表满时必须拒绝新登记而不是逐出——逐出运行中条目会同时丢掉在途面与
 * 准入信号（守卫被绕过 + 先结束者清掉被逐出者的槽）。
 */
describe("bash slot table: capacity rejects, never evicts a running entry", () => {
  test('症状回归「运行中的无 id 槽被 cap 逐出」：8 条 id 直执行开跑后 isBashRunning("") 仍为 true', () => {
    const inflight = createInflightState(INFLIGHT_OUTPUT_CAP_BYTES, () => 1_000);
    inflight.beginBash("", "idless");
    for (let i = 1; i <= INFLIGHT_MAX_TRACKED_BASH; i++) inflight.beginBash(`b${i}`, `cmd${i}`);
    expect(inflight.isBashRunning("")).toBe(true);
    expect(inflight.isBashRunning("b1")).toBe(true);
  });

  test("表满时新 id 的 beginBash 拒绝登记（返回 false，同 id 重复认领也拒绝）", () => {
    const inflight = createInflightState(INFLIGHT_OUTPUT_CAP_BYTES, () => 1_000);
    for (let i = 1; i <= INFLIGHT_MAX_TRACKED_BASH; i++) {
      expect(inflight.beginBash(`b${i}`, `cmd${i}`)).toBe(true);
    }
    expect(inflight.beginBash("overflow", "cmd")).toBe(false);
    expect(inflight.isBashRunning("overflow")).toBe(false);
    // 认领语义：同 id 已在跑时重复认领被拒（并发分发的第二条不会覆盖第一条）；
    // 槽位保持被 b1 占有——b1 结束释放后才可重新认领
    expect(inflight.beginBash("b1", "replaced")).toBe(false);
    expect(inflight.isBashRunning("b1")).toBe(true);
    inflight.endBash("b1");
    expect(inflight.beginBash("b1", "re-claimed")).toBe(true);
  });
});

/**
 * 对抗处置 F2（adv-fuzz FINDING F2/F2b）：bash 是 append-delta 路径，标志若
 * 对「已保留尾部 + 新 delta」重算，任何落回 cap 余量的小 delta 都会把
 * truncated 翻回 false——头部早已被丢弃。标志必须对整条流粘滞，直到 endBash。
 */
describe("bash tail truncated flag is sticky per stream", () => {
  test("小 delta 落回余量后仍为 true（一二三四y，cap=10）", () => {
    const inflight = createInflightState(10, () => 1_000);
    inflight.beginBash("", "cmd");
    inflight.noteBashOutput("", "一二三四"); // 12 bytes > 10 → 截断
    inflight.noteBashOutput("", "y"); // 保留尾 10B 内放得下 → 不得翻回 false
    const { bash } = inflight.snapshot();
    expect(bash?.truncated).toBe(true);
    expect(bash?.output).toBe("二三四y");
    inflight.endBash("");
    inflight.beginBash("", "cmd");
    inflight.noteBashOutput("", "short");
    expect(inflight.snapshot().bash?.truncated).toBe(false); // endBash 后新流重新计
  });

  test("空 delta 不改变任何事实（含标志）", () => {
    const inflight = createInflightState(8, () => 1_000);
    inflight.beginBash("", "cmd");
    inflight.noteBashOutput("", "0123456789ABC"); // 13B → 截到 "56789ABC"
    inflight.noteBashOutput("", "");
    const { bash } = inflight.snapshot();
    expect(bash?.truncated).toBe(true);
    expect(bash?.output).toBe("56789ABC");
  });
});

/**
 * 处置项①（2026-09-12-perf 方案）：SDK 的 tool_execution_update 携带**累积**
 * 快照——旧实现对每个事件全量 join + 全量测长，「10MB 输出拆万次小更新」是
 * O(N²) join 面。尾部预判：从末块累计字节，一旦已取部分 > cap 即停，结果经
 * retainTail 与旧实现逐字节等价、标志同样精确。
 */

/** 旧实现参考模型：全量 join 再 retainTail（等价性判据的单一真相）。 */
function referenceTail(blocks: string[], cap: number): { output: string; truncated: boolean } {
  const full = blocks.join("\n");
  if (Buffer.byteLength(full, "utf8") <= cap) return { output: full, truncated: false };
  return { output: tailBytes(full, cap), truncated: true };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ["a", "é", "汉", "😀", "", "x\r\ny"];

function randomBlocks(rng: () => number, count: number): string[] {
  const blocks: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const unit = ALPHABET[Math.floor(rng() * ALPHABET.length)] ?? "a";
    blocks.push(unit.repeat(Math.floor(rng() * 60)));
  }
  return blocks;
}

describe("tool snapshot tail pre-truncation (equivalence + budget)", () => {
  test("等价性：种子随机块流 × 多 cap，新实现 ≡ 全量 join + retainTail", () => {
    const rng = mulberry32(0x20260912);
    for (let index = 0; index < 400; index += 1) {
      const blocks = randomBlocks(rng, 1 + Math.floor(rng() * 120));
      for (const cap of [1, 7, 64, 1000]) {
        const inflight = createInflightState(cap, () => 1_000);
        inflight.noteToolStart("c1");
        // 喂累积流（每事件快照 = 前 k 块），最后一事件定终态
        for (let k = 1; k <= blocks.length; k += Math.max(1, Math.floor(blocks.length / 7))) {
          inflight.noteToolUpdate("c1", {
            content: blocks.slice(0, k).map((text) => ({ type: "text", text })),
          });
        }
        inflight.noteToolUpdate("c1", {
          content: blocks.map((text) => ({ type: "text", text })),
        });
        const [got] = inflight.snapshot().toolOutputs;
        const want = referenceTail(blocks, cap);
        if (got?.output !== want.output || got?.truncated !== want.truncated) {
          throw new Error(
            `equivalence broken at case ${index} cap=${cap}: got=${JSON.stringify(got)} want=${JSON.stringify(want)} blocks=${JSON.stringify(blocks)}`,
          );
        }
      }
    }
    expect(true).toBe(true);
  });

  test("string content 形状仍受支持（预判路径含纯字符串快照）", () => {
    const inflight = createInflightState(8, () => 1_000);
    inflight.noteToolStart("c1");
    inflight.noteToolUpdate("c1", { content: "0123456789ABC" });
    const [got] = inflight.snapshot().toolOutputs;
    expect(got?.output).toBe("56789ABC");
    expect(got?.truncated).toBe(true);
  });

  test("症状红灯「累积快照 O(N²)」：1200 事件累积至 ~24MB 在时间预算内", () => {
    const block = "x".repeat(4096);
    const inflight = createInflightState(INFLIGHT_OUTPUT_CAP_BYTES, () => 1_000);
    inflight.noteToolStart("c1");
    const events = 1_200;
    const startedAt = performance.now();
    for (let index = 1; index <= events; index += 1) {
      const blocks = Array.from({ length: index * 5 }, () => ({
        type: "text" as const,
        text: block,
      }));
      inflight.noteToolUpdate("c1", { content: blocks });
    }
    const elapsed = performance.now() - startedAt;
    const [final] = inflight.snapshot().toolOutputs;
    expect(final?.truncated).toBe(true);
    expect(Buffer.byteLength(final?.output ?? "", "utf8") <= INFLIGHT_OUTPUT_CAP_BYTES).toBe(true);
    expect(elapsed).toBeLessThan(300); // 旧实现全量 join ≈ 14GB 级拷贝（实测 ~1s），远超此预算
  }, 20_000);
});
