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
import { type SandboxConfig, denyEntryMatches, foldForComparison } from "../../sandbox-config.ts";

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
   * (covers timeout/cancel/unknown/throwing channel — fail-closed). The
   * exec's abort signal settles the dialog immediately when provided
   * (agent turn abort, direct-bash wall clock / abort_bash). */
  confirmRerun: (command: string, signal?: AbortSignal) => Promise<"once" | "session" | undefined>;
  /** Session-exemption probe (exact command string). */
  isExempted: (command: string) => boolean;
  /** Record a "this session" grant (exact command string; cap enforced by
   * the caller). */
  onSessionGrant: (command: string) => void;
  /** Session cwd (relative denyRead entries resolve against it). */
  cwd: string;
  /** Raw denyRead policy entries (glob-aware, for violation-line paths). */
  denyReadEntries: string[];
  /** denyRead roots in both observable forms (effect space + lexical, for
   * the failure-text floor). */
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
  /** Evidence of a denyRead-policy hit: the rerun is NEVER offered. ANY
   * file-read denial counts — denyRead is the ONLY read policy, so a
   * file-read deny IS a denyRead hit regardless of path attribution (globs,
   * relative echoes defeat root matching); write denials whose target
   * matches a denyRead ENTRY (denyEntryMatches, glob-aware) floor too. */
  denyReadHit: boolean;
}

/** Classify raw violation lines against the policy (pure, table-tested). */
export function digestViolationLines(
  lines: readonly string[],
  denyReadEntries: readonly string[],
  cwd: string,
): ViolationDigest {
  let rerunCandidate = false;
  let denyReadHit = false;
  for (const line of lines) {
    const writeMatch = FILE_WRITE_DENY.exec(line);
    if (writeMatch !== null || NETWORK_OUTBOUND_DENY.test(line)) rerunCandidate = true;
    if (FILE_READ_DENY.test(line)) {
      // Attribution-free: the OS layer logs literal paths, which glob and
      // relative denyRead entries can never match — any read deny floors.
      denyReadHit = true;
    }
    if (writeMatch !== null) {
      // Write into a denyRead entry floors too (credential trees stay out of
      // the click-to-allow flow — same rule as the write-tool layer, P2).
      const target = writeMatch[1] ?? "";
      if (denyReadEntries.some((entry) => denyEntryMatches(entry, cwd, target))) {
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

/** Sandbox-denial signature in the command's own failure output. Kernel
 * seatbelt log lines lag the process exit by MANY SECONDS under load
 * (e2e-measured >10s, occasionally >15s) and unified-log coalescing can drop
 * repeats entirely — a line-gated offer would be unusably flaky. The
 * signature is therefore FIRST-CLASS candidate evidence (instant); the
 * read/write ambiguity it carries is compensated by a THREE-channel denyRead
 * floor below. */
const SANDBOX_DENIAL_SIGNATURE = /operation not permitted|permission denied|not on the allow list/i;

/** Digest one failed run from BOTH evidence channels: the violation store
 * (precise but lagging) and text (instant but non-discriminating).
 *
 * denyRead floor — three text-ish channels plus the precise line channel:
 * 1. ANY file-read violation line (denyRead is the only read policy);
 * 2. write-line targets matching a denyRead ENTRY (denyEntryMatches, glob);
 * 3. the FAILURE text naming a denyRead root (tools echo the path — both
 *    forms via denyReadRootVariants);
 * 4. the COMMAND text naming a denyRead root (relative-echo shapes like
 *    `cd ~/.ssh && cat id_rsa` carry the root in the command string).
 * Residual leak: a path fully synthesized with the root substring absent
 * from command AND error output — deliberate extreme obfuscation, with the
 * full command still shown to the user before any approval. */
export function digestFailure(deps: {
  lines: readonly string[];
  failureText: string;
  commandText: string;
  /** Raw denyRead policy ENTRIES (glob-aware) — matched against
   * violation-line paths via denyEntryMatches. */
  denyReadEntries: readonly string[];
  /** denyRead roots in both observable forms (effect space + lexical) for
   * the text floors. */
  denyReadRoots: readonly string[];
  cwd: string;
}): ViolationDigest {
  const { lines, failureText, commandText, denyReadEntries, denyReadRoots, cwd } = deps;
  const fromLines = digestViolationLines(lines, denyReadEntries, cwd);
  // Text floors match roots AND raw entries: commands carry the literal
  // entry form ("cd ~/.ssh && cat id_rsa" — the tilde form never expands).
  const rootCandidates = [...denyReadRoots, ...denyReadEntries];
  const hitRootIn = (text: string): boolean => {
    const folded = foldForComparison(text);
    return rootCandidates.some((root) => folded.includes(foldForComparison(root)));
  };
  return {
    rerunCandidate: fromLines.rerunCandidate || SANDBOX_DENIAL_SIGNATURE.test(failureText),
    denyReadHit: fromLines.denyReadHit || hitRootIn(failureText) || hitRootIn(commandText),
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
 * the whole group (bash children included); both streams feed onData.
 * Live group ids register in LIVE_CHILD_GROUPS so worker shutdown sweeps
 * them (review P6): a detached, unsupervised child — especially a confirmed
 * UNSANDBOXED rerun — must not outlive the worker that owned it. */
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

/** Violation-line settle windows (review P1/P4): kernel seatbelt lines lag
 * the process exit — noise lines instantly, policy lines >10s under load.
 * A failure WITHOUT the denial signature waits QUICK_SETTLE_MS (ordinary
 * failures pay ~nothing); a signature-shaped failure waits up to
 * DISCRIMINATING_SETTLE_MS for a policy line, because the text cannot
 * discriminate a write denial (rerunnable) from a read denial (denyRead
 * floor — NEVER rerunnable). No policy line by the deadline = no offer
 * (fail-closed to v0.7 behavior). */
const QUICK_SETTLE_MS = 300;
const DISCRIMINATING_SETTLE_MS = 15_000;
const VIOLATION_POLL_MS = 25;

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

/** Policy-relevant lines (read OR write) for this commandId within the
 * applicable settle window. */
async function violationLinesFor(commandId: string, failureText: string): Promise<string[]> {
  const store = SandboxManager.getSandboxViolationStore();
  const deadline =
    Date.now() +
    (SANDBOX_DENIAL_SIGNATURE.test(failureText) ? DISCRIMINATING_SETTLE_MS : QUICK_SETTLE_MS);
  for (;;) {
    const lines = store.getViolationsForCommand(commandId).map((violation) => violation.line);
    const relevant = lines.some(
      (line) =>
        FILE_WRITE_DENY.test(line) || FILE_READ_DENY.test(line) || NETWORK_OUTBOUND_DENY.test(line),
    );
    if (relevant || Date.now() >= deadline) return lines;
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

/** Post-failure confirm-rerun resolution (review P1/P2 hardening):
 * 1. exemption FIRST (a session grant already adjudicated this exact
 *    command; it must not re-pay the evidence wait — but still only
 *    auto-reruns for denial-shaped failures, so an ordinary failure of a
 *    previously-approved command never double-executes);
 * 2. evidence: wait for a discriminating policy line (signature extends
 *    the patience); no positive write/network evidence = no offer;
 * 3. abort settles everything fail-closed: an aborted signal before the
 *    dialog, after its answer, and before the rerun spawn declines the
 *    rerun — an aborted run must never spawn an unkillable unsandboxed
 *    child (attaching a listener to an already-aborted signal never fires). */
async function resolveRerun(deps: {
  rerun: BashRerunDeps;
  command: string;
  commandId: string;
  failureText: string;
  exitCode: number;
  signal: AbortSignal | undefined;
  run: () => Promise<{ exitCode: number | null }>;
  emit: (text: string) => void;
}): Promise<{ exitCode: number | null }> {
  const { rerun, command, commandId, failureText, exitCode, signal, run, emit } = deps;
  const decline = (): { exitCode: number | null } => {
    emit(DECLINED_MARKER);
    return { exitCode };
  };
  const denialShaped = SANDBOX_DENIAL_SIGNATURE.test(failureText);
  if (denialShaped && rerun.isExempted(command)) {
    if (signal?.aborted) return decline();
    emit(RERUN_MARKER);
    return run();
  }
  const lines = await violationLinesFor(commandId, failureText);
  const digest = digestFailure({
    lines,
    failureText,
    commandText: command,
    denyReadEntries: rerun.denyReadEntries,
    denyReadRoots: rerun.denyReadRoots,
    cwd: rerun.cwd,
  });
  if (!shouldOfferRerun({ exitCode, digest, canAsk: true })) return { exitCode };
  if (signal?.aborted) return decline();
  let choice: "once" | "session" | undefined;
  try {
    choice = await rerun.confirmRerun(command, signal);
  } catch {
    choice = undefined; // a throwing dialog channel settles fail-closed
  }
  if (choice === undefined || signal?.aborted) return decline();
  emit(RERUN_MARKER);
  if (choice === "session") rerun.onSessionGrant(command);
  return run();
}

export function createSandboxedBashOperations(rerun?: BashRerunDeps): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      execPreflight(cwd, signal);
      const commandId = `pai-${randomUUID()}`;
      const wrapped = await wrapCommand(command, commandId);
      // Bounded tail capture (review P4): policy lines live at the end of
      // the output; decoding once at read time avoids split code points.
      const STREAM_TAIL_BYTES = 64 * 1024;
      const chunks: Buffer[] = [];
      const capturingOnData = (data: Buffer): void => {
        chunks.push(data);
        onData(data);
      };
      const failureText = (): string => {
        const whole = Buffer.concat(chunks);
        const tail =
          whole.length > STREAM_TAIL_BYTES
            ? whole.subarray(whole.length - STREAM_TAIL_BYTES)
            : whole;
        return tail.toString("utf8");
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
      return resolveRerun({
        rerun,
        command,
        commandId,
        failureText: failureText(),
        exitCode: first.exitCode,
        signal,
        run: () => runChild({ command, cwd, onData, signal, timeout, env }),
        emit: (text) => onData(Buffer.from(text)),
      });
    },
  };
}
