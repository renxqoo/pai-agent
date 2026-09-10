/**
 * OS runtime adapter (sandbox v2 plan §4.4/§一): wraps
 * @anthropic-ai/sandbox-runtime (sandbox-exec on macOS, bubblewrap on
 * Linux). One runtime per worker PROCESS (the SDK manager is a process
 * singleton); sessions initialize/reset it through their lifecycle.
 *
 * W3 upgrades over the v0.10 extraction (all micro-repro verified on
 * darwin, sandbox-runtime 0.0.75 — docs/plans/2026-09-10-sandbox-v2.md §一):
 * - the network ASK callback fires pre-connection with the host extracted;
 * - updateConfig is LIVE for the proxy (no re-init needed for grants);
 * - wrapWithSandbox accepts a per-invocation customConfig (once-grants can
 *   re-run INSIDE the sandbox).
 *
 * Degradation contract: an unsupported platform or a failed initialize
 * leaves bash UNSANDBOXED (fail-open) with the reason recorded and one
 * stderr warning — the in-process write/edit/read hard checks never depend
 * on this runtime and stay enforced. (The permission gate's oracle reads
 * this state and falls back to per-command asks — never silent fail-open.)
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { globMatches } from "../rules.ts";
import type { SandboxConfig } from "./config.ts";
import type { SandboxRuntimeState } from "./controller.ts";
import { isPolicyRelevantLine, sandboxDenialSignature } from "./digest.ts";

export function sandboxPlatformSupported(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

/** Map filesystem entries for the runtime: sandbox-runtime resolves "." and
 * relative entries against the PROCESS cwd at initialize time — but the
 * gate's semantics are SESSION cwd (the worker process runs from the app
 * root, not the conversation directory). Glob entries pass through
 * verbatim (the runtime owns glob semantics, e.g. ".env.*" basenames); the
 * runtime expands "~" entries itself. */
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

function runtimeConfigFor(
  config: SandboxConfig,
  sessionCwd: string,
): {
  network: SandboxConfig["network"];
  filesystem: {
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
} {
  return {
    network: config.network,
    filesystem: {
      denyRead: entriesForRuntime(config.filesystem.denyRead, sessionCwd),
      allowWrite: entriesForRuntime(config.filesystem.allowWrite, sessionCwd),
      denyWrite: entriesForRuntime(config.filesystem.denyWrite, sessionCwd),
    },
  };
}

/** Pre-connection network ask: the proxy consults this for hosts matching
 * neither allowlist; undefined = deny unmatched (subagent semantics). */
export type NetworkAskCallback = (host: string, port: number | undefined) => Promise<boolean>;

/** Initialize the process-wide runtime; returns the resulting state. The
 * log monitor (third initialize arg) is REQUIRED for deny detection:
 * without it the violation store stays empty and no rerun can ever be
 * offered (fail-closed toward the v0.7 behavior). */
export async function initializeSandboxRuntime(deps: {
  config: SandboxConfig;
  sessionCwd: string;
  writeStderr: (text: string) => void;
  ask?: NetworkAskCallback;
}): Promise<SandboxRuntimeState> {
  const { config, sessionCwd, writeStderr, ask } = deps;
  if (!sandboxPlatformSupported()) {
    const reason = `sandbox unavailable on ${process.platform}`;
    writeStderr(
      `pai-cli sandbox: ${reason}; bash runs unsandboxed (write/edit/read checks stay on)\n`,
    );
    return { active: false, degraded: reason };
  }
  try {
    await SandboxManager.initialize(
      runtimeConfigFor(config, sessionCwd),
      ask === undefined ? undefined : ({ host, port }) => ask(host, port),
      true, // enableLogMonitor: seatbelt/seccomp violation capture
    );
    return { active: true };
  } catch (error) {
    const reason = `sandbox initialization failed: ${error instanceof Error ? error.message : String(error)}`;
    writeStderr(
      `pai-cli sandbox: ${reason}; bash runs unsandboxed (write/edit/read checks stay on)\n`,
    );
    return { active: false, degraded: reason };
  }
}

/** Live policy swap (micro-repro verified: the proxy consults the new
 * config on the next connection — grants take effect without re-init). */
export function updateSandboxRuntime(config: SandboxConfig, sessionCwd: string): void {
  SandboxManager.updateConfig(runtimeConfigFor(config, sessionCwd));
}

export async function resetSandboxRuntime(): Promise<void> {
  try {
    await SandboxManager.reset();
  } catch {
    // Cleanup errors are irrelevant: the process is heading down anyway.
  }
}

/** Build a COMPLETE runtime config with once-grant exceptions merged into
 * the base (the wrap override is Partial only at the top level — a partial
 * section would DROP denyRead/denyWrite for the rerun, opening credential
 * reads; sections are therefore always whole). */
export function configWithExceptions(
  base: SandboxConfig,
  cwd: string,
  exceptions: { domains?: string[]; writeDirs?: string[] },
): ReturnType<typeof runtimeConfigFor> {
  const merged: SandboxConfig = {
    ...base,
    network:
      exceptions.domains === undefined
        ? base.network
        : {
            allowedDomains: [...new Set([...base.network.allowedDomains, ...exceptions.domains])],
            deniedDomains: base.network.deniedDomains,
          },
    filesystem:
      exceptions.writeDirs === undefined
        ? base.filesystem
        : {
            ...base.filesystem,
            allowWrite: [...new Set([...base.filesystem.allowWrite, ...exceptions.writeDirs])],
          },
  };
  return runtimeConfigFor(merged, cwd);
}

/** Wrap one command string (only meaningful while the runtime is active).
 * `custom` implements once-grants: a re-run that stays INSIDE the sandbox
 * with exactly the asked-for domains/directories opened (build it with
 * configWithExceptions). The commandId attributes violations to THIS
 * invocation — keys compare on their first 100 characters upstream, so a
 * unique id per exec is mandatory (a rerun must not inherit earlier
 * events). */
export async function wrapSandboxCommand(
  command: string,
  commandId: string,
  custom?: ReturnType<typeof configWithExceptions>,
): Promise<string> {
  return SandboxManager.wrapWithSandbox(command, undefined, custom, undefined, {
    commandId,
    commandText: command,
  });
}

/** Sandbox-denial env sentinel: the variable stays visible to the command,
 * the real value never enters the sandboxed child (plan §4.5). */
export const ENV_SENTINEL = "pai-sandboxed";

/** Glob-match variable NAMES against the configured mask patterns (the
 * shared linear glob from rules.ts — no regex, no backtracking). */
export function maskEnvForSandbox(
  env: NodeJS.ProcessEnv | undefined,
  patterns: readonly string[],
): NodeJS.ProcessEnv {
  if (env === undefined || patterns.length === 0) return env ?? {};
  const masked: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    masked[name] =
      value !== undefined && patterns.some((pattern) => globMatches(pattern, name))
        ? ENV_SENTINEL
        : value;
  }
  return masked;
}

/** Violation-line settle windows (review P1/P4): kernel seatbelt lines lag
 * the process exit — noise lines instantly, policy lines >10s under load.
 * A failure WITHOUT the denial signature waits QUICK_SETTLE_MS (ordinary
 * failures pay ~nothing); a signature-shaped failure waits up to
 * DISCRIMINATING_SETTLE_MS for a policy line, because the text cannot
 * discriminate a write denial (rerunnable) from a read denial (denyRead
 * floor — NEVER rerunnable). No policy line by the deadline = no offer
 * (fail-closed to the v0.7 behavior). */
const QUICK_SETTLE_MS = 300;
const DISCRIMINATING_SETTLE_MS = 15_000;
const VIOLATION_POLL_MS = 25;

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

/** Policy-relevant lines (read OR write) for this commandId within the
 * applicable settle window. */
export async function violationLinesFor(commandId: string, failureText: string): Promise<string[]> {
  const store = SandboxManager.getSandboxViolationStore();
  const deadline =
    Date.now() + (sandboxDenialSignature(failureText) ? DISCRIMINATING_SETTLE_MS : QUICK_SETTLE_MS);
  for (;;) {
    const lines = store.getViolationsForCommand(commandId).map((violation) => violation.line);
    const relevant = lines.some((line) => isPolicyRelevantLine(line));
    if (relevant || Date.now() >= deadline) return lines;
    await sleep(VIOLATION_POLL_MS);
  }
}

/** Entry guards shared by every exec: a missing cwd and a pre-aborted
 * signal must both fail before anything is spawned (batch-2 review P6). */
export function execPreflight(cwd: string, signal: AbortSignal | undefined): void {
  if (existsSync(cwd) === false) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }
  if (signal?.aborted) {
    throw new Error("aborted");
  }
}

/** Spawn `bash -c <command>` as a detached process group (wrapped sandbox
 * runs and raw confirmed reruns share these mechanics); abort/timeout kill
 * the whole group (bash children included); both streams feed onData.
 * Live group ids register in LIVE_CHILD_GROUPS so worker shutdown sweeps
 * them (review P6): a detached, unsupervised child — especially a
 * confirmed UNSANDBOXED rerun — must not outlive the worker. */
const LIVE_CHILD_GROUPS = new Set<number>();
process.on("exit", () => {
  for (const pgid of LIVE_CHILD_GROUPS) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

export interface ChildRunResult {
  exitCode: number | null;
}

export function runChild(deps: {
  command: string;
  cwd: string;
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<ChildRunResult> {
  const { command, cwd, onData, signal, timeout, env } = deps;
  return new Promise((resolve, reject) => {
    // The wrap is a bash -c profile invocation: "bash" is structural here
    // (settings' shellPath applies to the unsandboxed twin only).
    const child = spawn("bash", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(env !== undefined ? { env } : {}),
    });
    if (child.pid !== undefined) LIVE_CHILD_GROUPS.add(child.pid);
    const timedOut = { flag: false };
    const kill = armGroupKill(child, timeout, timedOut);
    const unregister = (): void => {
      if (child.pid !== undefined) LIVE_CHILD_GROUPS.delete(child.pid);
    };
    let settled = false;
    const idle = { timer: undefined as ReturnType<typeof setTimeout> | undefined };
    const onAbort = (): void => {
      kill.now();
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      unregister();
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
  resolve: (value: ChildRunResult) => void;
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
