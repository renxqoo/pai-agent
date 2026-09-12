/**
 * In-flight retention for get_inflight (design.md v0.14): the three facts a
 * client that missed the event stream needs in order to converge on the
 * current turn — the turn's persistent prefix boundary (entry id recorded at
 * agent_start), the tail of every running tool call's streamed output, and
 * the tail of a direct bash execution.
 *
 * Bounded by construction: per-stream byte caps keep the newest tail and mark
 * `truncated`; a settled call / ended turn drops its entries immediately.
 * Nothing here is durable state — the session file stays the only truth for
 * everything that finished. The tracker is fed from the single event-pump
 * subscription (session-adapter) plus the direct-bash path (bash-commands);
 * it never reads the session.
 */

import type { InflightBashState, InflightToolOutput } from "./protocol.ts";
import { tailBytes } from "./truncate.ts";

/** 在途保留面的形状唯一真相在 protocol.ts（get_inflight 的线形状）；此处只做别名，
 * 与 subagent-registry 的 SnapshotEntry 同一手法。 */
export type { InflightToolOutput };
export type InflightBash = InflightBashState;

export interface InflightSnapshot {
  turnStartEntryId: string | null;
  turnStartedAt: number | null;
  toolOutputs: readonly InflightToolOutput[];
  bash: InflightBash | null;
}

/** Retained tail per running tool call / direct bash (head is dropped). */
export const INFLIGHT_OUTPUT_CAP_BYTES = 64 * 1024;
/** Concurrent running calls tracked per conversation (oldest evicted). */
export const INFLIGHT_MAX_TRACKED_CALLS = 8;
/** Concurrent direct-bash executions tracked (claims beyond the cap are
 * rejected by beginBash; api.md 的并发直执行语义要求 per-id 保留，上界与
 * 工具调用表对称）。 */
export const INFLIGHT_MAX_TRACKED_BASH = 8;

interface RetainedTail {
  text: string;
  truncated: boolean;
}

export interface InflightState {
  /** 轮首采集：持久前缀边界（leaf 条目 id）+ 该时刻（客户端跨重载续算计时）。 */
  beginTurn(leafId: string | null, at: number): void;
  endTurn(): void;
  noteToolStart(callId: string): void;
  /** Cumulative snapshot from the SDK's tool update callback (replace, never
   * append). Takes the RAW snapshot: the tail pre-truncation needs the cap,
   * and the cap lives on this state instance (single truth). */
  noteToolUpdate(callId: string, partialResult: unknown): void;
  noteToolEnd(callId: string): void;
  /** id = 命令帧 id（bash_execution_update 帧携带）；并发直执行互不覆盖。
   * 认领语义：槽被占用（同 id 已在跑）或表满时返回 false，不覆盖、不逐出——
   * 表中条目全部运行中，逐出会同时丢掉在途面与无 id 并发的准入信号。 */
  beginBash(id: string, command: string): boolean;
  /** true = 该 id 的直执行仍在跑（无 id 并发的准入判据）。 */
  isBashRunning(id: string): boolean;
  /** bash_execution_update delta (append: the wire carries real deltas here). */
  noteBashOutput(id: string, delta: string): void;
  endBash(id: string): void;
  snapshot(): InflightSnapshot;
}

/** 按字节封顶保尾（CJK/emoji 不会被劈成半个字符）。输入可能是 SDK 的全量
 * 累积快照：先按 code unit 数预切（≤ capBytes 字节的尾巴必然落在最后
 * capBytes 个 code unit 内——每个 unit 至少 1 字节），使每事件成本 O(cap)
 * 而非 O(全量)。 */
function retainTail(text: string, capBytes: number): RetainedTail {
  const window = text.length > capBytes ? text.slice(-capBytes) : text;
  if (text.length <= capBytes && Buffer.byteLength(window, "utf8") <= capBytes) {
    return { text, truncated: false };
  }
  return { text: tailBytes(window, capBytes), truncated: true };
}

function emptyTail(): RetainedTail {
  return { text: "", truncated: false };
}

/** 超限驱逐最旧（Map 迭代序即写入序；既有 key 重写不改变位置）。 */
function evictBeyond<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done === true) return;
    map.delete(oldest.value);
  }
}

function snapshotOf(parts: {
  turnStartEntryId: string | null;
  turnStartedAt: number | null;
  calls: Map<string, { tail: RetainedTail; startedAt: number }>;
  bashEntries: Map<string, { command: string; tail: RetainedTail; startedAt: number }>;
}): InflightSnapshot {
  const { turnStartEntryId, turnStartedAt, calls, bashEntries } = parts;
  const toolOutputs: InflightToolOutput[] = [];
  for (const [callId, entry] of calls) {
    toolOutputs.push({
      callId,
      output: entry.tail.text,
      truncated: entry.tail.truncated,
      startedAt: entry.startedAt,
    });
  }
  // 读口是单面（客户端横幅/live 事件同为单面）：取最新仍在跑的直执行；
  // bash === null ⇔ 无任何直执行在跑（客户端收尾探测的判据）。
  let bash: InflightBash | null = null;
  for (const entry of bashEntries.values()) {
    bash = {
      command: entry.command,
      output: entry.tail.text,
      truncated: entry.tail.truncated,
      startedAt: entry.startedAt,
    };
  }
  return { turnStartEntryId, turnStartedAt, toolOutputs, bash };
}

/** Tool-call retention ops over one shared table (the createInflightState
 * composition splits these out to stay under the per-function size budget). */
function toolCallOps(
  calls: Map<string, { tail: RetainedTail; startedAt: number }>,
  capBytes: number,
  now: () => number,
): Pick<InflightState, "noteToolStart" | "noteToolUpdate" | "noteToolEnd"> {
  return {
    noteToolStart(callId) {
      if (callId.length === 0) return;
      calls.set(callId, { tail: emptyTail(), startedAt: now() });
      evictBeyond(calls, INFLIGHT_MAX_TRACKED_CALLS);
    },
    noteToolUpdate(callId, partialResult) {
      const entry = calls.get(callId);
      if (entry === undefined) return;
      calls.set(callId, {
        tail: retainTail(textOfToolSnapshot(partialResult, capBytes), capBytes),
        startedAt: entry.startedAt,
      });
    },
    noteToolEnd(callId) {
      calls.delete(callId);
    },
  };
}

export function createInflightState(
  capBytes: number = INFLIGHT_OUTPUT_CAP_BYTES,
  now: () => number = Date.now,
): InflightState {
  const calls = new Map<string, { tail: RetainedTail; startedAt: number }>();
  const bashEntries = new Map<string, { command: string; tail: RetainedTail; startedAt: number }>();
  let turnStartEntryId: string | null = null;
  let turnStartedAt: number | null = null;

  return {
    beginTurn(leafId, at) {
      turnStartEntryId = leafId;
      // 垃圾时刻降级为 null（客户端只在有值时续算计时）
      turnStartedAt = Number.isFinite(at) ? at : null;
    },
    endTurn() {
      // 只收轮自己的在途面：直执行 bash 的生命周期由 beginBash/endBash 独立管理
      // （模型轮与 `!` 命令并发时，轮结算不得清掉仍在跑的 bash 面）。
      turnStartEntryId = null;
      turnStartedAt = null;
      calls.clear();
    },
    ...toolCallOps(calls, capBytes, now),
    beginBash(id, command) {
      if (bashEntries.has(id)) return false;
      if (bashEntries.size >= INFLIGHT_MAX_TRACKED_BASH) return false;
      bashEntries.set(id, { command, tail: emptyTail(), startedAt: now() });
      return true;
    },
    noteBashOutput(id, delta) {
      const entry = bashEntries.get(id);
      if (entry === undefined) return;
      const next = retainTail(entry.tail.text + delta, capBytes);
      // 粘滞：bash 走 append-delta 路径，头部一旦丢弃就再也回不来——标志
      // 必须对整条流成立，任何落回 cap 余量的小 delta 都不得翻回 false。
      entry.tail = { text: next.text, truncated: entry.tail.truncated || next.truncated };
    },
    endBash(id) {
      bashEntries.delete(id);
    },
    isBashRunning(id) {
      return bashEntries.has(id);
    },
    snapshot() {
      return snapshotOf({ turnStartEntryId, turnStartedAt, calls, bashEntries });
    },
  };
}

/**
 * Tail-pre-truncated text of a tool update snapshot (`{content: string |
 * [{type:"text", text}]}` — the SDK's CUMULATIVE snapshot shape; every event
 * re-carries the whole output). Walks blocks from the END and stops as soon
 * as the taken suffix strictly exceeds capBytes — the head is never joined
 * nor measured, so per-event cost is O(cap) instead of O(full output).
 * Returned value is a block-aligned suffix of the full join: > capBytes when
 * anything was dropped (retainTail then reports `truncated` exactly), or the
 * full text when nothing was. Display semantics stay in the client; the host
 * only needs plain bytes for the retained tail.
 */
export function textOfToolSnapshot(partialResult: unknown, capBytes: number): string {
  const { content } = asRecord(partialResult);
  if (typeof content === "string") {
    // Units slice keeps this O(cap): cap+3 units are always > capBytes bytes.
    return content.length > capBytes ? content.slice(-(capBytes + 3)) : content;
  }
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  let bytes = 0;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const { text } = asRecord(content[index]);
    if (typeof text !== "string") continue;
    parts.push(text);
    bytes += Buffer.byteLength(text, "utf8");
    // (parts.length - 1) "\n" separators: the taken suffix's exact byte size.
    if (bytes + parts.length - 1 > capBytes) break;
  }
  return parts.toReversed().join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
