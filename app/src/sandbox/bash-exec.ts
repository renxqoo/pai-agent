/**
 * Sandboxed bash operations (sandbox v2 plan §4.4): the per-exec flow.
 * Runs the command INSIDE the OS sandbox (credential-env masked); on
 * failure, digests the evidence, classifies the violation (domain / dir /
 * unclassified), asks through the controller, and re-runs — INSIDE the
 * sandbox with the granted exception whenever the violation was
 * classifiable (a once-grant rides wrapWithSandbox's per-invocation
 * override; session/always ride the live-swapped config), and OUTSIDE only
 * for unclassified denials (the v0.10 fallback, now prefix-granular).
 */

import { randomUUID } from "node:crypto";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { type SandboxController } from "./controller.ts";
import { denyReadRootVariants } from "./config.ts";
import {
  digestFailure,
  extractDeniedHosts,
  extractDeniedWriteDirFromText,
  extractDeniedWriteDirs,
  shouldOfferRerun,
} from "./digest.ts";
import type { SandboxAskChoice, SandboxAskPort } from "./ports.ts";
import {
  configWithExceptions,
  execPreflight,
  maskEnvForSandbox,
  runChild,
  violationLinesFor,
  wrapSandboxCommand,
} from "./runtime.ts";

const RERUN_INSIDE_MARKER = "\n[pai] rerunning with sandbox exception (user-approved)\n";
const RERUN_OUTSIDE_MARKER = "\n[pai] rerunning without sandbox (user-approved)\n";
const DECLINED_MARKER = "[pai] sandbox denied; rerun declined\n";

/** Bounded tail capture (review P4): policy lines live at the end of the
 * output; decoding once at read time avoids split code points. */
const STREAM_TAIL_BYTES = 64 * 1024;

/** One classified violation the evidence supports. */
type BashViolation =
  | { kind: "network-domain"; values: string[] }
  | { kind: "write-dir"; values: string[] }
  | { kind: "unclassified" };

export interface SandboxBashDeps {
  controller: SandboxController;
  /** Dialog adapter bound to THIS exec's UI ctx; undefined = fail-closed. */
  ask: SandboxAskPort | undefined;
  /** Publishes the exec-scoped ask for the pre-connection network callback
   * (set at exec start, cleared in finally; null = no active dialog
   * surface). The binding owns the slot. */
  onActive?: (ask: SandboxAskPort | null) => void;
}

/** Everything one exec (and its potential rerun) carries. */
interface ExecRun {
  command: string;
  cwd: string;
  signal: AbortSignal | undefined;
  timeout: number | undefined;
  env: NodeJS.ProcessEnv;
  emit: (data: Buffer) => void;
}

export function createSandboxedBashOperations(deps: SandboxBashDeps): BashOperations {
  const { controller, ask, onActive } = deps;
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      onActive?.(ask ?? null);
      try {
        return await execOnce({ controller, ask }, { command, cwd, onData, signal, timeout, env });
      } finally {
        onActive?.(null);
      }
    },
  };
}

async function execOnce(
  deps: { controller: SandboxController; ask: SandboxAskPort | undefined },
  call: {
    command: string;
    cwd: string;
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ exitCode: number | null }> {
  const { controller, ask } = deps;
  const { command, cwd, onData, signal, timeout, env } = call;
  execPreflight(cwd, signal);
  const chunks: Buffer[] = [];
  const emit = (data: Buffer): void => {
    chunks.push(data);
    onData(data);
  };
  const tail = (): string => {
    const whole = Buffer.concat(chunks);
    const sliced =
      whole.length > STREAM_TAIL_BYTES ? whole.subarray(whole.length - STREAM_TAIL_BYTES) : whole;
    return sliced.toString("utf8");
  };
  const masked = maskEnvForSandbox(
    env ?? process.env,
    controller.snapshot.config.credentials.maskEnvVars,
  );
  const run: ExecRun = { command, cwd, signal, timeout, env: masked, emit };
  const first = await runInside(run, controller);
  if (first.exitCode === 0 || first.exitCode === null) return { exitCode: first.exitCode };
  // Posture gate (v0.10 bashRerunDeps semantics, generalized): no dialogs
  // outside the ask posture or from subagent spawns — denial stays failure.
  if (ask === undefined || !controller.bashAskable()) return { exitCode: first.exitCode };
  return resolveFailure({ controller, ask, run, first, failureText: tail() });
}

/** Run once inside the sandbox. A fresh commandId per invocation — upstream
 * violation attribution keys compare on the first 100 characters, so a
 * rerun must never inherit the earlier run's events. `exceptions` carries
 * a once-grant as a COMPLETE config (see configWithExceptions). */
async function runInside(
  run: ExecRun,
  controller: SandboxController,
  exceptions?: { domains?: string[]; writeDirs?: string[] },
): Promise<{ exitCode: number | null; commandId: string }> {
  const commandId = `pai-${randomUUID()}`;
  const custom =
    exceptions === undefined
      ? undefined
      : configWithExceptions(controller.runtimeConfig(), run.cwd, exceptions);
  const wrapped = await wrapSandboxCommand(run.command, commandId, custom);
  const result = await runChild({
    command: wrapped,
    cwd: run.cwd,
    onData: run.emit,
    signal: run.signal,
    timeout: run.timeout,
    env: run.env,
  });
  return { ...result, commandId };
}

/** Post-failure resolution: digest evidence → hard floors → classified ask
 * (in-sandbox rerun) → unclassified fallback (outside rerun, prefixes). */
async function resolveFailure(deps: {
  controller: SandboxController;
  ask: SandboxAskPort;
  run: ExecRun;
  first: { exitCode: number | null; commandId: string };
  failureText: string;
}): Promise<{ exitCode: number | null }> {
  const { controller, ask, run, first, failureText } = deps;
  const decline = (): { exitCode: number | null } => {
    run.emit(Buffer.from(DECLINED_MARKER));
    return { exitCode: first.exitCode };
  };
  const lines = await violationLinesFor(first.commandId, failureText);
  const { filesystem } = controller.snapshot.config;
  const digest = digestFailure({
    lines,
    failureText,
    commandText: run.command,
    denyReadEntries: [...filesystem.denyRead],
    denyReadRoots: denyReadRootVariants(filesystem, controller.cwd),
    cwd: controller.cwd,
  });
  if (!shouldOfferRerun({ exitCode: first.exitCode, digest, canAsk: true })) {
    return { exitCode: first.exitCode };
  }
  if (run.signal?.aborted) return decline();
  // The pre-connection callback already adjudicated network denials in
  // main threads (asked and answered, or auto-denied) — never re-ask.
  const violation = classifyViolation(lines, failureText);
  if (violation.kind === "network-domain" && controller.networkCallbackActive) {
    return { exitCode: first.exitCode };
  }
  if (violation.kind === "unclassified") return rerunOutside({ controller, ask, run, decline });
  return rerunInsideGranted({ controller, ask, run, violation, decline });
}

/** v0.10 fallback: the unclassified denial re-runs OUTSIDE the sandbox
 * (user-approved full trust — the twin keeps the real environment). */
async function rerunOutside(deps: {
  controller: SandboxController;
  ask: SandboxAskPort;
  run: ExecRun;
  decline: () => { exitCode: number | null };
}): Promise<{ exitCode: number | null }> {
  const { controller, ask, run, decline } = deps;
  const decision = await controller.bashEscalationDecision(run.command, ask);
  if (!decision.rerun || run.signal?.aborted) return decline();
  run.emit(Buffer.from(RERUN_OUTSIDE_MARKER));
  return runChild({
    command: run.command,
    cwd: run.cwd,
    onData: run.emit,
    signal: run.signal,
    timeout: run.timeout,
  });
}

/** Classified violation: ask, record the grant, re-run INSIDE the sandbox
 * (a once-grant rides the per-invocation override; session/always ride the
 * live-swapped config). */
async function rerunInsideGranted(deps: {
  controller: SandboxController;
  ask: SandboxAskPort;
  run: ExecRun;
  violation: Exclude<BashViolation, { kind: "unclassified" }>;
  decline: () => { exitCode: number | null };
}): Promise<{ exitCode: number | null }> {
  const { controller, ask, run, violation, decline } = deps;
  const choice = await askClassified({ ask, violation, command: run.command, signal: run.signal });
  if (choice === "deny" || run.signal?.aborted) return decline();
  controller.applyBashGrant(violation.kind, violation.values, choice);
  run.emit(Buffer.from(RERUN_INSIDE_MARKER));
  if (choice !== "once") return runInside(run, controller);
  const exceptions = { domains: violation.values } as { domains?: string[]; writeDirs?: string[] };
  if (violation.kind === "write-dir") {
    exceptions.writeDirs = violation.values;
    exceptions.domains = undefined;
  }
  const rerun = await runInside(run, controller, exceptions);
  return { exitCode: rerun.exitCode };
}

function classifyViolation(lines: readonly string[], failureText: string): BashViolation {
  const hosts = extractDeniedHosts(lines);
  if (hosts.length > 0) return { kind: "network-domain", values: hosts };
  const dirs = new Set(extractDeniedWriteDirs(lines));
  const fromText = extractDeniedWriteDirFromText(failureText);
  if (fromText !== undefined) dirs.add(fromText);
  if (dirs.size > 0) return { kind: "write-dir", values: [...dirs] };
  return { kind: "unclassified" };
}

async function askClassified(deps: {
  ask: SandboxAskPort;
  violation: Exclude<BashViolation, { kind: "unclassified" }>;
  command: string;
  signal: AbortSignal | undefined;
}): Promise<SandboxAskChoice> {
  const { ask, violation, command, signal } = deps;
  try {
    return await ask(
      { kind: violation.kind, value: violation.values[0] ?? "", detail: `command ${command}` },
      signal === undefined ? undefined : { signal },
    );
  } catch {
    return "deny"; // a throwing dialog channel settles fail-closed
  }
}
