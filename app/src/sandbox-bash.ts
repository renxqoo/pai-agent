/**
 * OS-level bash sandbox (docs/plans/2026-09-09-sandbox.md §2): wraps command
 * execution through @anthropic-ai/sandbox-runtime (sandbox-exec on macOS,
 * bubblewrap on Linux), modeled on pi's examples/extensions/sandbox. One
 * runtime per worker PROCESS (the SDK manager is a process singleton);
 * sessions initialize/reset it through their lifecycle.
 *
 * Degradation contract: an unsupported platform or a failed initialize
 * leaves bash UNSANDBOXED (fail-open) with the reason recorded for
 * get_sandbox_state and one stderr warning — the in-process write/edit/read
 * hard checks never depend on this runtime and stay enforced.
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig } from "./sandbox-config.ts";

export interface SandboxRuntimeState {
  /** The OS layer is active: bash commands get wrapped. */
  active: boolean;
  /** Why the OS layer is inactive despite an enabled config. */
  degraded?: string;
}

export function sandboxPlatformSupported(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

/**
 * Map filesystem entries for the runtime: sandbox-runtime resolves "." and
 * relative entries against the PROCESS cwd at initialize time — but the
 * gate's semantics are SESSION cwd (the worker process runs from the app
 * root, not the conversation directory). Glob entries pass through
 * verbatim (the runtime owns glob semantics, e.g. ".env.*" basenames); the
 * runtime expands "~" entries itself.
 */
function entriesForRuntime(entries: string[], sessionCwd: string): string[] {
  return entries.map((entry) => {
    if (entry === ".") {
      try {
        return realpathSync(sessionCwd);
      } catch {
        return sessionCwd;
      }
    }
    if (entry.includes("*")) return entry;
    if (entry.startsWith("~")) return entry;
    if (entry.startsWith("/")) return entry;
    return join(sessionCwd, entry);
  });
}

/** Initialize the process-wide runtime; returns the resulting state. */
export async function initializeSandboxRuntime(
  config: SandboxConfig,
  sessionCwd: string,
  writeStderr: (text: string) => void,
): Promise<SandboxRuntimeState> {
  if (!sandboxPlatformSupported()) {
    const reason = `sandbox unavailable on ${process.platform}`;
    writeStderr(
      `pai-cli sandbox: ${reason}; bash runs unsandboxed (write/edit/read checks stay on)\n`,
    );
    return { active: false, degraded: reason };
  }
  try {
    await SandboxManager.initialize({
      network: config.network,
      filesystem: {
        denyRead: entriesForRuntime(config.filesystem.denyRead, sessionCwd),
        allowWrite: entriesForRuntime(config.filesystem.allowWrite, sessionCwd),
        denyWrite: entriesForRuntime(config.filesystem.denyWrite, sessionCwd),
      },
    });
    return { active: true };
  } catch (error) {
    const reason = `sandbox initialization failed: ${error instanceof Error ? error.message : String(error)}`;
    writeStderr(
      `pai-cli sandbox: ${reason}; bash runs unsandboxed (write/edit/read checks stay on)\n`,
    );
    return { active: false, degraded: reason };
  }
}

export async function resetSandboxRuntime(): Promise<void> {
  try {
    await SandboxManager.reset();
  } catch {
    // Cleanup errors are irrelevant: the process is heading down anyway.
  }
}

/** Wrap one command string (only meaningful while the runtime is active). */
async function wrapCommand(command: string): Promise<string> {
  return SandboxManager.wrapWithSandbox(command);
}

/** Spawn the wrapped command as a detached process group; abort/timeout
 * kill the whole group (bash children included); both streams feed onData. */
function runSandboxedChild(deps: {
  wrapped: string;
  cwd: string;
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ exitCode: number | null }> {
  const { wrapped, cwd, onData, signal, timeout, env } = deps;
  return new Promise((resolve, reject) => {
    // The wrap is a bash -c profile invocation: "bash" is structural here
    // (settings' shellPath applies to the unsandboxed twin only).
    const child = spawn("bash", ["-c", wrapped], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(env !== undefined ? { env } : {}),
    });
    const timedOut = { flag: false };
    const kill = armGroupKill(child, timeout, timedOut);
    let settled = false;
    const idle = { timer: undefined as ReturnType<typeof setTimeout> | undefined };
    const onAbort = (): void => {
      kill.now();
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      kill.clear();
      signal?.removeEventListener("abort", onAbort);
      if (idle.timer !== undefined) clearTimeout(idle.timer);
      action();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    wireChildStreams({ child, onData, signal, timeout, timedOut, idle, settle, resolve, reject });
  });
}

/** Stream/close wiring incl. the 100ms idle-after-exit fallback for quiet
 * inherited handles (`sleep 300 &`) that would delay `close` forever —
 * pi's local ops uses the same fallback (batch-2 review P2). */
function wireChildStreams(deps: {
  child: ReturnType<typeof spawn>;
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  timedOut: { flag: boolean };
  idle: { timer: ReturnType<typeof setTimeout> | undefined };
  settle: (action: () => void) => void;
  resolve: (value: { exitCode: number | null }) => void;
  reject: (reason: Error) => void;
}): void {
  const { child, onData, signal, timeout, timedOut, idle, settle, resolve, reject } = deps;
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (error) => {
    settle(() => reject(error));
  });
  child.on("exit", (code) => {
    idle.timer = setTimeout(() => {
      settle(() => resolve({ exitCode: code }));
    }, 100);
  });
  child.on("close", (code) => {
    settle(() => {
      if (signal?.aborted) reject(new Error("aborted"));
      else if (timedOut.flag) reject(new Error(`timeout:${timeout}`));
      else resolve({ exitCode: code });
    });
  });
}

/** Timeout arming + whole-process-group kill (bash children included). */
function armGroupKill(
  child: ReturnType<typeof spawn>,
  timeout: number | undefined,
  timedOut: { flag: boolean },
): { clear: () => void; now: () => void } {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const now = (): void => {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };
  if (timeout !== undefined && timeout > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut.flag = true;
      now();
    }, timeout * 1000);
  }
  return {
    clear: () => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    },
    now,
  };
}

export function createSandboxedBashOperations(): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (existsSync(cwd) === false) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }
      // A signal aborted before entry must not let the command run at all
      // (batch-2 review P6) — the addEventListener below would never fire.
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      const wrapped = await wrapCommand(command);
      return runSandboxedChild({ wrapped, cwd, onData, signal, timeout, env });
    },
  };
}
