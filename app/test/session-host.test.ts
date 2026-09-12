import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentSession,
  AgentSessionRuntime,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  SessionHost,
  bindThread,
  type Thread,
} from "../src/backend/pi-coding-agent/session-adapter.ts";
import { createInflightState } from "../src/inflight-state.ts";
import { SessionDestroyedError } from "../src/session-destroyed-error.ts";
import { clearSidecarRules, writeSidecarRules } from "../src/sidecar-rules.ts";
import type { PermissionRules } from "../src/rules.ts";

/**
 * Unit coverage for the session-replacement fixes (migration.md F-1/F-2 and
 * the execution-time threadId check): the host is driven with a stub runtime
 * injected into its private thread slot, exercising the real fork/clone/stop
 * queue and the beforeSessionInvalidate mapping without pi internals.
 */

interface ForkResult {
  cancelled: boolean;
  selectedText?: string;
}

function makeHost(sessionId: string): {
  host: SessionHost;
  runtime: {
    hook: (() => void) | undefined;
    forkImpl: () => Promise<ForkResult>;
    disposed: boolean;
    overlap: number;
    active: number;
  };
  setSessionId(id: string): void;
} {
  const runtime = {
    hook: undefined as (() => void) | undefined,
    forkImpl: (() =>
      Promise.resolve<ForkResult>({ cancelled: false })) as () => Promise<ForkResult>,
    disposed: false,
    overlap: 0,
    active: 0,
  };
  const thread: Thread = {
    runtime: {
      setBeforeSessionInvalidate: (cb?: () => void) => {
        runtime.hook = cb;
      },
      fork: () => {
        runtime.active++;
        if (runtime.active > 1) runtime.overlap++;
        return runtime.forkImpl().finally(() => {
          runtime.active--;
        });
      },
      dispose: async () => {
        runtime.disposed = true;
      },
    } as unknown as AgentSessionRuntime,
    // Session shape is deliberately minimal: only the fields the
    // replacement queue reads (sessionId, leaf lookup).
    session: {
      sessionId,
      sessionManager: { getLeafId: () => "leaf-1" },
    } as unknown as AgentSession,
    cwd: "/tmp",
    sessionPath: null,
    unsubscribe: () => {},
  };
  const host = new SessionHost({
    // The model runtime is only touched by spawn(), which these tests bypass.
    modelRuntime: undefined as unknown as ModelRuntime,
    emit: () => {},
    createUi: () => undefined as never,
    onThreadDisposed: () => {},
  });
  (host as unknown as { thread: Thread | undefined }).thread = thread;
  return {
    host,
    runtime,
    setSessionId(id: string): void {
      (thread.session as { sessionId: string }).sessionId = id;
    },
  };
}

describe("F-1: post-teardown fork failure detection", () => {
  test("fork failing AFTER beforeSessionInvalidate maps to SessionDestroyedError", async () => {
    const { host, runtime } = makeHost("s1");
    runtime.forkImpl = () => {
      runtime.hook?.(); // teardownCurrent started
      return Promise.reject(new Error("createRuntime exploded"));
    };
    await expect(host.fork("s1", "e1", "at")).rejects.toBeInstanceOf(SessionDestroyedError);
    expect(host.get()).toBeDefined(); // the worker decides to exit; SessionHost keeps state
  });

  test("fork failing BEFORE any teardown is a plain error (thread survives)", async () => {
    const { host, runtime } = makeHost("s1");
    runtime.forkImpl = () => Promise.reject(new Error("entry not found"));
    const caught = await host.fork("s1", "e1", "at").catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(SessionDestroyedError);
  });

  test("clone gets the same mapping", async () => {
    const { host, runtime } = makeHost("s1");
    runtime.forkImpl = () => {
      runtime.hook?.();
      return Promise.reject(new Error("boom"));
    };
    await expect(host.clone("s1")).rejects.toBeInstanceOf(SessionDestroyedError);
  });
});

describe("F-2: session-replacing operations serialize", () => {
  test("two concurrent forks do not overlap and the second sees the re-keyed id", async () => {
    const { host, runtime, setSessionId } = makeHost("s1");
    let release: (() => void) | undefined;
    const gate = new Promise<ForkResult>((resolve) => {
      release = () => {
        resolve({ cancelled: false });
      };
    });
    // The rebind fires when the first fork's task consumes the gate, not
    // when release() is called (the test releases before the task runs).
    runtime.forkImpl = () =>
      gate.then((result) => {
        setSessionId("forked-id"); // rebind swaps the session id in place
        return result;
      });
    const first = host.fork("s1", "e1", "at");
    const second = host.fork("s1", "e1", "at"); // stale id, queued behind the first
    release?.();
    const firstResult = await first;
    expect(firstResult.previousThreadId).toBe("s1");
    expect(firstResult.thread.session.sessionId).toBe("forked-id");
    await expect(second).rejects.toThrow("Unknown threadId: s1");
    expect(runtime.overlap).toBe(0);
  });

  test("stop waits for an in-flight fork instead of interleaving", async () => {
    const { host, runtime } = makeHost("s1");
    let release: (() => void) | undefined;
    const gate = new Promise<ForkResult>((resolve) => {
      release = () => {
        resolve({ cancelled: false });
      };
    });
    runtime.forkImpl = () => gate;
    const forkP = host.fork("s1", "e1", "at");
    const stopP = host.stop();
    release?.();
    await forkP;
    await stopP;
    expect(host.get()).toBeUndefined();
    expect(runtime.disposed).toBe(true);
    expect(runtime.overlap).toBe(0);
  });

  test("expectedThreadId mismatch on clone rejects with the stale id", async () => {
    const { host } = makeHost("re-keyed");
    await expect(host.clone("old-id")).rejects.toThrow("Unknown threadId: old-id");
  });
});

const PERMISSION_THREAD = "perm-live-read-test";

// Sidecar rules must never touch the developer's real agent dir: bind a
// throwaway one for this file (getAgentDir reads the env per call).
const agentDir = mkdtempSync(join(tmpdir(), "pai-cli-session-host-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

afterAll(() => {
  clearSidecarRules(PERMISSION_THREAD);
});

describe("grandchild gate ruleset is re-read per call (B-P2-5)", () => {
  test("getInjectedRules reflects sidecar changes, not a spawn snapshot", () => {
    const { host } = makeHost("s-1");
    const box = host as unknown as { permissionThreadId: string | undefined };
    box.permissionThreadId = PERMISSION_THREAD;
    const first: PermissionRules = { mode: "ask", bash: { allowPatterns: ["echo *"] } };
    writeSidecarRules(PERMISSION_THREAD, first);
    expect(host.getInjectedRules()).toEqual(first);
    const tightened: PermissionRules = { mode: "ask", bash: { blockPatterns: ["rm *"] } };
    writeSidecarRules(PERMISSION_THREAD, tightened);
    // The old snapshot semantics returned the stale spawn-time object.
    expect(host.getInjectedRules()).toEqual(tightened);
    expect(host.getInjectedRules()).not.toEqual(first);
  });

  test("undefined anchor means no injected rules (normal conversations)", () => {
    const { host } = makeHost("s-2");
    expect(host.getInjectedRules()).toBeUndefined();
  });
});

/**
 * 对抗处置（adv-lifecycle）：rebind 换绑后，挂在旧 sessionId 下的 broker 弹窗
 * 既读面不可见（get_pending_dialogs 按当前 id 过滤）也无 per-thread settle
 * 路径可达——僵尸到自身 300s 超时，期间心跳 busy 阻止 idle retire。换绑时
 * 必须对 previousId 结算（与 stop 的 onThreadDisposed 同一语义）。
 */
describe("rebind settles dialogs under the previous session id", () => {
  test("换绑即结算 previousId；新会话获得全新 inflight 状态", async () => {
    const settled: string[] = [];
    let rebindFn: ((replacement: unknown) => Promise<void>) | undefined;
    const gen1Inflight = createInflightState();
    const thread: Thread = {
      runtime: {
        setRebindSession: (cb: (r: unknown) => Promise<void>) => {
          rebindFn = cb;
        },
      } as unknown as AgentSessionRuntime,
      session: {
        sessionId: "s1",
        sessionFile: undefined,
        subscribe: () => () => {},
        bindExtensions: () => Promise.resolve(),
      } as unknown as AgentSession,
      cwd: "/tmp",
      sessionPath: null,
      unsubscribe: () => {},
      inflight: gen1Inflight,
    };
    await bindThread({
      thread,
      emit: () => {},
      createUi: () => undefined as never,
      threadIdRef: { id: "" },
      writeStderr: () => {},
      settlePrevious: (threadId) => settled.push(threadId),
    });
    expect(rebindFn).toBeDefined();
    const replacement = {
      sessionId: "forked-id",
      sessionFile: undefined,
      subscribe: () => () => {},
      bindExtensions: () => Promise.resolve(),
    };
    await rebindFn?.(replacement);
    expect(settled).toEqual(["s1"]); // 换绑即结算旧 id
    expect(thread.session.sessionId).toBe("forked-id");
    expect(thread.inflight).not.toBe(gen1Inflight); // 全新在途状态
    expect(threadIdOf(thread)).toBe("forked-id");
  });

  test("同 id 换绑（clone 回写同 id）不触发结算", async () => {
    const settled: string[] = [];
    let rebindFn: ((replacement: unknown) => Promise<void>) | undefined;
    const thread: Thread = {
      runtime: {
        setRebindSession: (cb: (r: unknown) => Promise<void>) => {
          rebindFn = cb;
        },
      } as unknown as AgentSessionRuntime,
      session: {
        sessionId: "s1",
        sessionFile: undefined,
        subscribe: () => () => {},
        bindExtensions: () => Promise.resolve(),
      } as unknown as AgentSession,
      cwd: "/tmp",
      sessionPath: null,
      unsubscribe: () => {},
      inflight: createInflightState(),
    };
    const threadIdRef = { id: "s1" };
    await bindThread({
      thread,
      emit: () => {},
      createUi: () => undefined as never,
      threadIdRef,
      writeStderr: () => {},
      settlePrevious: (threadId) => settled.push(threadId),
    });
    await rebindFn?.({ ...thread.session });
    expect(settled).toEqual([]); // id 未变：无旧弹窗需要结算
  });
});

function threadIdOf(thread: Thread): string {
  return thread.session.sessionId;
}
