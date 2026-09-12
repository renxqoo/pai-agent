import { describe, expect, test } from "bun:test";
import { handleAbortBash, handleBash, parseBashTimeoutMs } from "../src/bash-commands.ts";
import { DialogBroker as RealDialogBroker } from "../src/dialogs.ts";
import { createInflightState } from "../src/inflight-state.ts";

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

/** 守卫测试装置：哨兵异常证明「过了守卫、进了权限门」。 */
function makeGuardCtx(runningIdless: boolean) {
  const inflight = createInflightState();
  if (runningIdless) inflight.beginBash("", "first");
  const frames: Array<{ command: string; error: string }> = [];
  const thread = { session: {}, cwd: "/w", sessionPath: undefined, inflight };
  const ctx = {
    requireThread: () => thread,
    sessions: { getInjectedRules: () => null },
    failure: (_id: unknown, command: string, error: string) => {
      frames.push({ command, error });
    },
    checkPermission: () => {
      throw new Error("sentinel: reached the permission gate");
    },
  } as never;
  return { ctx, frames };
}

describe("handleBash admission (v0.14 concurrent id-less guard)", () => {
  test("症状回归「并发无 id 直执行共享单槽互相清态」：第二条无 id 并发被准入拒绝", async () => {
    const { ctx, frames } = makeGuardCtx(true);
    await handleBash(ctx, { type: "bash", threadId: "t1", command: "second" });
    expect(frames).toEqual([
      { command: "bash", error: "concurrent direct bash requires a command id" },
    ]);
  });

  test("空闲会话的无 id 直执行不受影响（首条照常进入权限门）", async () => {
    const { ctx, frames } = makeGuardCtx(false);
    // 进入权限门即抛出测试哨兵（守卫未拦截的证据）
    await expect(
      handleBash(ctx, { type: "bash", threadId: "t1", command: "first" }),
    ).rejects.toThrow("sentinel: reached the permission gate");
    expect(frames).toEqual([]);
  });

  test("症状回归「守卫与登记之间的异步窗」：首条卡在权限弹窗时到达的第二条无 id 也必须被拒", async () => {
    // worker 是 void handleCommand 并发分发：首条无 id bash 挂在 confirmBashPermission
    // （弹窗最长 300s）尚未 beginBash 时，第二条无 id 到达。准入判据必须在此窗口内
    // 已经生效，否则两条都会进 runDirectBash，第二条覆盖首条在途面、先结束者清掉
    // 对方的活面。
    const inflight = createInflightState();
    const frames: Array<{ command: string; error: string }> = [];
    let releasePermission: ((allowed: boolean) => void) | undefined;
    const permissionGate = new Promise<boolean>((resolve) => {
      releasePermission = resolve;
    });
    const thread = { session: {}, cwd: "/w", sessionPath: undefined, inflight };
    const ctx = {
      requireThread: () => thread,
      sessions: { getInjectedRules: () => null },
      failure: (_id: unknown, command: string, error: string) => {
        frames.push({ command, error });
      },
      checkPermission: () => permissionGate,
    } as never;
    const first = handleBash(ctx, { type: "bash", threadId: "t1", command: "first" });
    // 首条已过准入守卫、正卡在权限门；此刻第二条无 id 并发到达
    const second = handleBash(ctx, { type: "bash", threadId: "t1", command: "second" });
    await Promise.resolve();
    expect(frames).toEqual([
      { command: "bash", error: "concurrent direct bash requires a command id" },
    ]);
    releasePermission?.(false);
    await Promise.allSettled([first, second]);
  });
});

/**
 * 对抗处置（adv-fixes/lifecycle 双路确认）：fork/clone 的 rebindThread 会就地
 * 换掉 thread.inflight 与 thread.session，而 worker 是 void handleCommand 并发
 * 分发——挂在权限门的直执行命令若晚绑定 thread，其 finally 的 endBash 会
 * 释放在**新代**状态上（偷掉新命令的槽），已过权限的命令还会对**新会话**
 * 执行。准入时必须捕获 inflight/session 引用，全路径用捕获值。
 */
function makeParkedThread() {
  const executeLog: string[] = [];
  const makeSession = (id: string) => ({
    sessionId: id,
    sessionManager: { getCwd: () => "/w" },
    recordBashResult: () => {},
    abortBash: () => {},
    executeBash: () => {
      executeLog.push(id);
      return new Promise<unknown>(() => {}); // parks forever; test releases via endBash
    },
    extensionRunner: { emitUserBash: async () => ({}) },
  });
  const gen1 = makeSession("s1");
  const gen2 = makeSession("s2");
  const thread = {
    session: gen1,
    cwd: "/w",
    sessionPath: undefined,
    inflight: createInflightState(),
  };
  return { thread, gen1, gen2, executeLog };
}

/** One macrotask: lets parked promises (permission gate / executeBash) settle. */
function nextTick(): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, 0);
  });
}

function makeParkedCtx(thread: ReturnType<typeof makeParkedThread>["thread"]) {
  const failures: string[] = [];
  const permGates: Array<(v: { block?: boolean }) => void> = [];
  const ctx = {
    requireThread: () => thread,
    sessions: { getInjectedRules: () => null },
    bashTimeoutMs: 0,
    registerInflight: () => ({ unregister: () => {} }),
    checkPermission: () =>
      new Promise<{ block?: boolean }>((r) => {
        permGates.push(r);
      }),
    failure: (_i: unknown, _c: string, error: string) => failures.push(error),
    success: () => {},
  } as never;
  return { ctx, failures, permGates, flush: nextTick };
}

describe("handleBash × fork/rebind cross-generation (adversarial)", () => {
  test("症状回归「晚到 endBash 偷新代槽」：rebind 后旧命令的结算不得影响新代", async () => {
    const { thread, gen2, executeLog } = makeParkedThread();
    const { ctx, permGates, failures, flush } = makeParkedCtx(thread);

    // bash1（无 id）挂在权限门，持有第 1 代的 "" 槽
    const bash1 = handleBash(ctx, { type: "bash", threadId: "s1", command: "one" });
    await flush();
    expect(thread.inflight.isBashRunning("")).toBe(true);
    const gen1Inflight = thread.inflight;

    // fork rebind：全新 inflight 状态 + 全新会话对象
    thread.inflight = createInflightState();
    thread.session = gen2;

    // bash2（无 id）在新代准入并通过权限门，进入执行（停在 executeBash）
    const bash2 = handleBash(ctx, { type: "bash", threadId: "s1", command: "two" });
    await flush();
    permGates[1]?.({});
    await flush();
    expect(thread.inflight.isBashRunning("")).toBe(true);
    expect(thread.inflight).not.toBe(gen1Inflight);

    // bash1 的弹窗此刻才被拒：其 finally 只能释放在第 1 代（被弃用）状态上
    permGates[0]?.({ block: true, reason: "denied" });
    await flush();
    expect(thread.inflight.isBashRunning("")).toBe(true); // 新代的槽必须仍在
    expect(thread.inflight.snapshot().bash).not.toBe(null);

    // bash2 仍在跑：第三条无 id 必须被新代准入拒绝（守卫不被绕过）
    const bash3 = handleBash(ctx, { type: "bash", threadId: "s1", command: "three" });
    await flush();
    expect(failures).toContain("concurrent direct bash requires a command id");
    expect(executeLog).toEqual(["s2"]); // bash3 从未执行
    await bash3;
    await bash1;
    // bash2 永远停在 executeBash：显式结束它以免悬挂 promise 告警
    thread.inflight.endBash("");
    await Promise.race([bash2, flush()]);
  });

  test("症状回归「已过权限的命令对 rebind 后的新会话执行」：执行必须用准入时捕获的会话", async () => {
    const { thread, gen2, executeLog } = makeParkedThread();
    const { ctx, permGates, flush } = makeParkedCtx(thread);
    void handleBash(ctx, { type: "bash", threadId: "s1", command: "one" });
    await flush();
    // rebind 发生在权限通过之后：该命令必须仍对旧会话 s1 执行
    thread.inflight = createInflightState();
    thread.session = gen2;
    permGates[0]?.({});
    await flush();
    expect(executeLog).toEqual(["s1"]);
    thread.inflight.endBash("");
  });
});

/**
 * 对抗处置（adv-proto）：权限弹窗挂起期到达的 abort_bash 只调
 * session.abortBash()——对尚未进入 executeBash 的命令是 no-op，客户端确认
 * 弹窗后命令照样执行。abort 必须穿透准入窗：立即取消挂起的准入（弹窗按
 * 未确认结算），命令永不执行，response 为明确的 aborted 失败。
 */
describe("abort_bash × admission window (adversarial)", () => {
  interface AdmissionWorld {
    ctx: unknown;
    frames: Array<{ kind: string; command: string; error?: string }>;
    executed: string[];
    aborts: number;
    release: ((allow: boolean) => void) | undefined;
    broker: { pendingCount: () => number };
    flush: () => Promise<void>;
  }

  function makeAdmissionWorld(withRealBroker: boolean): AdmissionWorld {
    const frames: Array<{ kind: string; command: string; error?: string }> = [];
    const executed: string[] = [];
    let aborts = 0;
    let release: ((allow: boolean) => void) | undefined;
    const { DialogBroker } = withRealBroker
      ? { DialogBroker: RealDialogBroker }
      : { DialogBroker: undefined };
    const broker = DialogBroker
      ? new DialogBroker(() => {})
      : { ask: async () => ({ confirmed: true }) };
    const thread = {
      session: {
        sessionId: "s1",
        sessionManager: { getCwd: () => "/w" },
        recordBashResult: () => {},
        abortBash: () => {
          aborts += 1;
        },
        executeBash: async (command: string) => {
          executed.push(command);
          return { output: "", exitCode: 0, cancelled: false, truncated: false };
        },
        extensionRunner: { emitUserBash: async () => ({}) },
      },
      cwd: "/w",
      sessionPath: undefined,
      inflight: createInflightState(),
    };
    const ctx = {
      requireThread: () => thread,
      sessions: {
        containmentOracle: () => ({ silentBash: () => false }),
        getInjectedRules: () => null,
      },
      broker,
      bashTimeoutMs: 0,
      registerInflight: () => ({ unregister: () => {} }),
      checkPermission: (req: { ask?: (title: string, value: string) => Promise<boolean> }) =>
        new Promise<{ block: boolean; reason?: string }>((resolve) => {
          if (withRealBroker && req.ask) {
            // 真实链路：进入权限门即弹窗挂起（abort 经 signal 即时结算它）
            req
              .ask("Run?", "cmd")
              .then((ok) => resolve({ block: !ok, reason: ok ? undefined : "Declined" }));
            return;
          }
          release = (allow: boolean) => {
            if (req.ask) {
              req
                .ask("Run?", "cmd")
                .then((ok) => resolve({ block: !ok, reason: ok ? undefined : "Declined" }));
            } else {
              resolve({ block: !allow, reason: allow ? undefined : "Declined" });
            }
          };
        }),
      failure: (_i: unknown, command: string, error: string) => {
        frames.push({ kind: "failure", command, error });
      },
      success: (_i: unknown, command: string) => {
        frames.push({ kind: "success", command });
      },
    } as never;
    return {
      ctx,
      frames,
      executed,
      get aborts() {
        return aborts;
      },
      release: undefined,
      broker: broker as never,
      flush: nextTick,
      get releaseNow() {
        return release;
      },
    } as never as AdmissionWorld;
  }

  test("症状回归「弹窗期 abort 是 no-op」：abort 后确认弹窗，命令不得执行", async () => {
    const w = makeAdmissionWorld(false);
    const pending = handleBash(w.ctx, { type: "bash", threadId: "s1", command: "sleep 30" });
    await w.flush();
    await handleAbortBash(w.ctx, { type: "abort_bash", threadId: "s1" });
    expect(w.aborts).toBe(1); // 会话级中止照常发出
    w.releaseNow?.(true); // 用户此刻确认弹窗
    await pending;
    expect(w.executed).toEqual([]); // 已 abort 的准入命令永不执行
    expect(w.frames).toContainEqual({
      kind: "failure",
      command: "bash",
      error: "aborted before execution started",
    });
  });

  test("真实 broker 链路：abort 立即结算挂起弹窗，恰好一条失败帧", async () => {
    const w = makeAdmissionWorld(true);
    const pending = handleBash(w.ctx, { type: "bash", threadId: "s1", command: "sleep 30" });
    await w.flush();
    expect(w.broker.pendingCount()).toBe(1); // 弹窗真实挂起
    await handleAbortBash(w.ctx, { type: "abort_bash", threadId: "s1" });
    await w.flush();
    expect(w.broker.pendingCount()).toBe(0); // abort 即结算，不等 300s 超时
    w.releaseNow?.(true); // 晚到的确认：ask 早已 settle
    await pending;
    expect(w.executed).toEqual([]);
    expect(w.frames.filter((f) => f.kind === "failure")).toHaveLength(1);
  });

  test("无挂起准入时 abort 保持既有语义（success + 会话级中止）", async () => {
    const w = makeAdmissionWorld(false);
    await handleAbortBash(w.ctx, { type: "abort_bash", threadId: "s1" });
    expect(w.aborts).toBe(1);
    expect(w.frames).toEqual([{ kind: "success", command: "abort_bash" }]);
  });
});

/**
 * 对抗处置（adv-proto）：带非空 id 的命令撞上同 id 在跑时，失败文案谎称
 * 「缺 command id」——两条命令都带了 id。文案必须按冲突类别区分。
 */
describe("bash admission failure wording (adversarial)", () => {
  test("症状回归「重复非空 id 的误导文案」：id 冲突报 id-in-use 而非缺 id", async () => {
    const inflight = createInflightState();
    const frames: Array<{ command: string; error: string }> = [];
    const thread = { session: {}, cwd: "/w", sessionPath: undefined, inflight };
    const ctx = {
      requireThread: () => thread,
      sessions: { getInjectedRules: () => null },
      failure: (_i: unknown, command: string, error: string) => {
        frames.push({ command, error });
      },
      checkPermission: () => new Promise(() => {}),
    } as never;
    inflight.beginBash("dup-1", "running"); // 同 id 已在跑
    await handleBash(ctx, { type: "bash", threadId: "t1", command: "second" }, "dup-1");
    expect(frames).toEqual([{ command: "bash", error: "bash command id is already in use" }]);
  });

  test('契约锁定「id 空串视同缺省」：id:"" 与无 id 同用 "" 哨兵槽', async () => {
    const inflight = createInflightState();
    const frames: Array<{ command: string; error: string }> = [];
    const thread = { session: {}, cwd: "/w", sessionPath: undefined, inflight };
    const ctx = {
      requireThread: () => thread,
      sessions: { getInjectedRules: () => null },
      failure: (_i: unknown, command: string, error: string) => {
        frames.push({ command, error });
      },
      checkPermission: () => new Promise(() => {}),
    } as never;
    inflight.beginBash("", "running"); // 无 id 直执行已认领 "" 槽
    await handleBash(ctx, { type: "bash", threadId: "t1", command: "second" }, ""); // 显式空串
    expect(frames).toEqual([
      { command: "bash", error: "concurrent direct bash requires a command id" },
    ]);
  });
});
