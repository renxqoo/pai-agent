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
import { randomUUID } from "node:crypto";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { type SandboxConfig, foldForComparison } from "../../sandbox-config.ts";

export interface SandboxRuntimeState {
  /** The OS layer is active: bash commands get wrapped. */
  active: boolean;
  /** Why the OS layer is inactive despite an enabled config. */
  degraded?: string;
}

/** v0.10 confirm-rerun wiring (docs/plans/2026-09-10-sandbox-escalation.md
 * §二): injected by the gate when the posture is ask, the spawn is not a
 * subagent, and a dialog-capable UI is present. Absent = keep the v0.7
 * behavior (denial = the command's own failure). */
export interface BashRerunDeps {
  /** Ask the user whether to re-run WITHOUT the sandbox; undefined = no
   * (covers timeout/cancel/unknown/throwing channel — fail-closed). */
  confirmRerun: (command: string) => Promise<"once" | "session" | undefined>;
  /** Session-exemption probe (exact command string). */
  isExempted: (command: string) => boolean;
  /** Record a "this session" grant (exact command string; cap enforced by
   * the caller). */
  onSessionGrant: (command: string) => void;
  /** Effect-space denyRead roots: any file-read deny touching them
   * suppresses the rerun offer (credential reads never re-run). */
  denyReadRoots: string[];
}

/** Probe-validated violation-line grammar (darwin, sandbox-runtime 0.0.75 —
 * plan §十一): policy lines carry the operation and a literal path or
 * destination; unrelated denials (sysctl-read, mach-lookup, …) are noise
 * that even perfectly innocent commands produce. */
const FILE_WRITE_DENY = /deny\(\d+\) file-write\S*\s+(\/\S+)/;
const FILE_READ_DENY = /deny\(\d+\) file-read\S*\s+(\/\S+)/;
const NETWORK_OUTBOUND_DENY = /deny network-outbound \S+/;

export interface ViolationDigest {
  /** A file-write or network-outbound denial: re-running unsandboxed would
   * change the outcome. */
  rerunCandidate: boolean;
  /** A file-read denial touched a denyRead root: never offer the rerun. */
  denyReadHit: boolean;
}

/** Classify raw violation lines against the policy (pure, table-tested). */
export function digestViolationLines(
  lines: readonly string[],
  denyReadRoots: readonly string[],
): ViolationDigest {
  let rerunCandidate = false;
  let denyReadHit = false;
  for (const line of lines) {
    if (FILE_WRITE_DENY.test(line) || NETWORK_OUTBOUND_DENY.test(line)) rerunCandidate = true;
    const readMatch = FILE_READ_DENY.exec(line);
    if (readMatch !== null) {
      const foldedPath = foldForComparison(readMatch[1] ?? "");
      if (denyReadRoots.some((root) => foldedPath.includes(foldForComparison(root)))) {
        denyReadHit = true;
      }
    }
  }
  return { rerunCandidate, denyReadHit };
}

/** Offer the confirm-rerun dialog at all (pure, table-tested): only a
 * non-zero exit (the command itself declared failure) with a policy-relevant
 * denial and no denyRead floor hit, and only when someone can be asked. */
export function shouldOfferRerun(deps: {
  exitCode: number | null;
  digest: ViolationDigest;
  canAsk: boolean;
}): boolean {
  const { exitCode, digest, canAsk } = deps;
  return (
    exitCode !== null && exitCode !== 0 && canAsk && digest.rerunCandidate && !digest.denyReadHit
  );
}

/** Sandbox-denial signature in the command's own failure output. The kernel
 * seatbelt log line can lag the process exit by many seconds under load
 * (e2e-measured >10s), so the rerun CANDIDATE trigger reads the streamed
 * output directly — the signature is best-effort in the fail-open-on-dialogs
 * direction only (an ordinary EPERM failure may offer a pointless rerun the
 * user declines; a sandbox denial is never missed). */
const SANDBOX_DENIAL_SIGNATURE = /operation not permitted|permission denied|not on the allow list/i;

/** Digest one failed run from BOTH evidence channels: the violation store
 * (may lag; precise) and the streamed failure text (instant; best-effort).
 * The denyRead floor consults both — the denied path appears verbatim in
 * the EPERM message. */
export function digestFailure(deps: {
  lines: readonly string[];
  failureText: string;
  denyReadRoots: readonly string[];
}): ViolationDigest {
  const { lines, failureText, denyReadRoots } = deps;
  const fromLines = digestViolationLines(lines, denyReadRoots);
  const foldedText = foldForComparison(failureText);
  const floorFromText = denyReadRoots.some((root) => foldedText.includes(foldForComparison(root)));
  return {
    rerunCandidate: fromLines.rerunCandidate || SANDBOX_DENIAL_SIGNATURE.test(failureText),
    denyReadHit: fromLines.denyReadHit || floorFromText,
  };
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

/** Initialize the process-wide runtime; returns the resulting state. The
 * log monitor (third initialize arg) is REQUIRED for v0.10 deny detection:
 * without it the violation store stays empty and no rerun can ever be
 * offered (fail-closed toward v0.7 behavior). */
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
    await SandboxManager.initialize(
      {
        network: config.network,
        filesystem: {
          denyRead: entriesForRuntime(config.filesystem.denyRead, sessionCwd),
          allowWrite: entriesForRuntime(config.filesystem.allowWrite, sessionCwd),
          denyWrite: entriesForRuntime(config.filesystem.denyWrite, sessionCwd),
        },
      },
      undefined,
      true, // enableLogMonitor: seatbelt/seccomp violation capture (v0.10)
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

export async function resetSandboxRuntime(): Promise<void> {
  try {
    await SandboxManager.reset();
  } catch {
    // Cleanup errors are irrelevant: the process is heading down anyway.
  }
}

/** Wrap one command string (only meaningful while the runtime is active).
 * The commandId attributes violations to THIS invocation — keys compare on
 * their first 100 characters upstream, so a unique id per exec is mandatory
 * (a rerun of the same text must not inherit the earlier run's events). */
async function wrapCommand(command: string, commandId: string): Promise<string> {
  return SandboxManager.wrapWithSandbox(command, undefined, undefined, undefined, {
    commandId,
    commandText: command,
  });
}

/** Spawn `bash -c <command>` as a detached process group (wrapped sandbox
 * runs and raw confirmed reruns share these mechanics); abort/timeout kill
 * the whole group (bash children included); both streams feed onData. */
function runChild(deps: {
  command: string;
  cwd: string;
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ exitCode: number | null }> {
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

const RERUN_MARKER = "\n[pai] rerunning without sandbox (user-approved)\n";
const DECLINED_MARKER = "[pai] sandbox denied; rerun declined\n";

/** The violation store is best-effort evidence, not a gate: kernel seatbelt
 * lines can lag the process exit by many seconds under load (e2e-measured
 * >10s), so the decision reads the STORED lines after a short settle window
 * and independently consults the instant streamed-failure text (see
 * digestFailure). Ordinary failed commands pay at most QUICK_SETTLE_MS. */
const QUICK_SETTLE_MS = 300;
const VIOLATION_POLL_MS = 25;

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

/** Lines recorded for this commandId within the quick settle window. */
async function violationLinesFor(commandId: string): Promise<string[]> {
  const store = SandboxManager.getSandboxViolationStore();
  const deadline = Date.now() + QUICK_SETTLE_MS;
  for (;;) {
    const lines = store.getViolationsForCommand(commandId).map((violation) => violation.line);
    if (lines.length > 0 || Date.now() >= deadline) return lines;
    await sleep(VIOLATION_POLL_MS);
  }
}

/** Entry guards shared by every exec: a missing cwd and a pre-aborted
 * signal must both fail before anything is spawned (batch-2 review P6). */
function execPreflight(cwd: string, signal: AbortSignal | undefined): void {
  if (existsSync(cwd) === false) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }
  if (signal?.aborted) {
    throw new Error("aborted");
  }
}

export function createSandboxedBashOperations(rerun?: BashRerunDeps): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      execPreflight(cwd, signal);
      const commandId = `pai-${randomUUID()}`;
      const wrapped = await wrapCommand(command, commandId);
      let streamed = "";
      const capturingOnData = (data: Buffer): void => {
        streamed += data.toString("utf8");
        onData(data);
      };
      const first = await runChild({
        command: wrapped,
        cwd,
        onData: capturingOnData,
        signal,
        timeout,
        env,
      });
      if (rerun === undefined) return first;
      if (first.exitCode === 0 || first.exitCode === null) return first;
      const lines = await violationLinesFor(commandId);
      const digest = digestFailure({
        lines,
        failureText: streamed,
        denyReadRoots: rerun.denyReadRoots,
      });
      if (!shouldOfferRerun({ exitCode: first.exitCode, digest, canAsk: true })) {
        return first;
      }
      if (rerun.isExempted(command)) {
        onData(Buffer.from(RERUN_MARKER));
        return runChild({ command, cwd, onData, signal, timeout, env });
      }
      let choice: "once" | "session" | undefined;
      try {
        choice = await rerun.confirmRerun(command);
      } catch {
        choice = undefined; // a throwing dialog channel settles fail-closed
      }
      if (choice === undefined) {
        onData(Buffer.from(DECLINED_MARKER));
        return first;
      }
      onData(Buffer.from(RERUN_MARKER));
      if (choice === "session") rerun.onSessionGrant(command);
      return runChild({ command, cwd, onData, signal, timeout, env });
    },
  };
}
