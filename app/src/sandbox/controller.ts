/**
 * Sandbox controller (sandbox v2 plan §三/§4.4): the per-conversation state
 * machine. Owns the snapshot, the OS-runtime observability state, and the
 * session grant store; resolves write/edit violations through the four-way
 * AskPort with in-flight dedupe; keeps the hard floors (protected paths,
 * denyRead∩write) out of the confirmable flow.
 *
 * The package stays host-decoupled: dialogs and persistence arrive through
 * ports; the backend binding adapts them to pi ctx / the worker→host frame.
 */

import {
  type SandboxConfig,
  type SandboxFsPolicy,
  type SandboxSnapshot,
  pathWithin,
  readViolation,
} from "./config.ts";
import {
  BASH_PREFIX_CAP,
  DOMAIN_CAP,
  WRITE_DIR_CAP,
  WRITE_PATTERN_CAP,
  addCapped,
  type SandboxSessionGrants,
  freshSessionGrants,
} from "./grants.ts";
import {
  type ContainmentOracle,
  type SandboxAskChoice,
  type SandboxAskKind,
  type SandboxAskPort,
  type SandboxGrantPersister,
} from "./ports.ts";
import { globMatches } from "../rules.ts";
import {
  alwaysGrantFor,
  classifyWriteWithGrants,
  commandPrefixGranted,
  suggestPrefixes,
} from "./policy.ts";

/** Why the OS layer is (not) wrapping bash — set by the binding at
 * session_start; read by get_sandbox_state and the oracle. */
export interface SandboxRuntimeState {
  /** The OS layer is active: bash commands get wrapped. */
  active: boolean;
  /** Why the OS layer is inactive despite an enabled config. */
  degraded?: string;
}

export interface SandboxControllerOptions {
  cwd: string;
  snapshot: SandboxSnapshot;
  /** Grandchild spawns never escalate (social-engineering floor). */
  subagent: boolean;
  /** "Always allow" sink (best-effort; the session copy is applied first). */
  persist: SandboxGrantPersister;
  /** Live OS-runtime policy swap (the binding wires updateSandboxRuntime);
   * undefined in tests — grants still apply to the JS-side classification. */
  syncRuntime?: (config: SandboxConfig, sessionCwd: string) => void;
}

export interface SandboxBlock {
  block: true;
  reason: string;
}

export class SandboxController {
  readonly grants: SandboxSessionGrants = freshSessionGrants();
  runtime: SandboxRuntimeState = { active: false };
  private readonly inflight = new Map<string, Promise<SandboxAskChoice>>();

  // Field-wise mutable by design: onSnapshotRebuilt/setSubagent swap parts in
  // place (the controller instance lives as long as the conversation).
  private readonly options: SandboxControllerOptions;

  constructor(options: SandboxControllerOptions) {
    this.options = options;
  }

  get cwd(): string {
    return this.options.cwd;
  }

  get subagent(): boolean {
    return this.options.subagent;
  }

  get snapshot(): SandboxSnapshot {
    return this.options.snapshot;
  }

  /** Snapshot rebuild (fork/clone/rebind): the config swaps, session grants
   * SURVIVE — they belong to the conversation continuity (plan §4.3, review
   * P15; v0.10's clear-on-rebuild ruling is superseded). A spawn may also
   * re-anchor the cwd (grandchild task cwd can differ from the worker's). */
  onSnapshotRebuilt(next: SandboxSnapshot, cwd?: string): void {
    this.options.snapshot = next;
    if (cwd !== undefined) this.options.cwd = cwd;
  }

  /** Spawn-time truth: a grandchild worker learns its subagent-ness only at
   * thread start (the SessionHost exists before the shaping arrives). */
  setSubagent(value: boolean): void {
    this.options.subagent = value;
  }

  /** Adopt the parent conversation's lineage (plan §4.6): posture is applied
   * through the snapshot (binding), in-sandbox grants land cap-respecting;
   * bashPrefixes NEVER arrive here (escape privileges do not propagate). */
  adoptLineage(lineage: { writeDirs: string[]; writePatterns: string[]; domains: string[] }): void {
    for (const dir of lineage.writeDirs) addCapped(this.grants.writeDirs, WRITE_DIR_CAP, dir);
    for (const pattern of lineage.writePatterns) {
      addCapped(this.grants.writePatterns, WRITE_PATTERN_CAP, pattern);
    }
    for (const domain of lineage.domains) addCapped(this.grants.domains, DOMAIN_CAP, domain);
  }

  /** Session teardown observable (binding calls this at session_shutdown):
   * the OS runtime is gone — the oracle must not report containment and the
   * network callback must deny until the next session_start re-arms it
   * (review R10: do not lean on upstream handler serialization). */
  onRuntimeDown(): void {
    this.runtime = { active: false };
    this.networkCallbackActive = false;
  }

  /** Bind the OS-runtime policy swap (the binding wires updateSandboxRuntime
   * at session_start; tests stay unwired and JS-side only). */
  setRuntimeSync(fn: (config: SandboxConfig, sessionCwd: string) => void): void {
    this.options.syncRuntime = fn;
  }

  /** Effective FS policy = config + implicit protected paths (kept out of
   * the reported config — batch-2 review P8). */
  filesystem(): SandboxFsPolicy {
    const { config, protectedPaths } = this.options.snapshot;
    return {
      ...config.filesystem,
      denyWrite: [...config.filesystem.denyWrite, ...protectedPaths],
    };
  }

  /** Session grants ∪ the file's persistent grants section — the decision
   * face everywhere grants are consulted (plan §4.3: grants are a global
   * additive relaxation; deny floors still apply upstream). */
  grantsView(): SandboxSessionGrants {
    // The deny posture is v0.7 wholesale hard-blocking (invariant 6): no
    // grant — file or session — relaxes anything while it holds (review R2).
    if (this.snapshot.config.onViolation !== "ask") return freshSessionGrants();
    const file = this.snapshot.config.grants;
    return {
      writeDirs: new Set([...this.grants.writeDirs, ...file.writeDirs]),
      // writePatterns stay session-only by ruling (credential-shaped files
      // re-ask every session) — the file grants section has no such key.
      writePatterns: new Set(this.grants.writePatterns),
      domains: new Set([...this.grants.domains, ...file.domains]),
      bashPrefixes: new Set([...this.grants.bashPrefixes, ...file.bashPrefixes]),
    };
  }

  runtimeConfig(): SandboxConfig {
    const { config } = this.options.snapshot;
    const grants = this.grantsView();
    return {
      ...config,
      network: {
        allowedDomains: [...new Set([...config.network.allowedDomains, ...grants.domains])],
        deniedDomains: config.network.deniedDomains,
      },
      // Built on this.filesystem() — the implicit protected paths stay in
      // denyWrite for EVERY policy swap and once-rerun (review R1: a sync
      // that dropped them would re-expose both sandbox.json files to bash
      // writes through the default "." allow-root).
      filesystem: {
        denyRead: this.filesystem().denyRead,
        allowWrite: [...new Set([...this.filesystem().allowWrite, ...grants.writeDirs])],
        denyWrite: this.filesystem().denyWrite.filter((entry) => !grants.writePatterns.has(entry)),
      },
    };
  }

  /** Push the grant-overlaid policy to the OS runtime (called after any
   * runtime-relevant grant lands and at binding mount). */
  syncRuntimeNow(): void {
    this.options.syncRuntime?.(this.runtimeConfig(), this.cwd);
  }

  /** Read tool decision: denyRead matches hard-block; everything else passes. */
  readDecision(resolvedPath: string): SandboxBlock | undefined {
    const reason = readViolation(this.filesystem(), this.cwd, resolvedPath);
    return reason === undefined ? undefined : { block: true, reason };
  }

  /** Write/edit tool decision: grant overlay → hard floors → four-way ask.
   * `ask === undefined` (no dialog-capable UI) settles fail-closed. */
  async writeDecision(
    resolvedPath: string,
    ask: SandboxAskPort | undefined,
    signal?: AbortSignal,
  ): Promise<SandboxBlock | undefined> {
    const filesystem = this.filesystem();
    const {
      clean,
      violation,
      ask: grantAsk,
    } = classifyWriteWithGrants({
      policy: filesystem,
      cwd: this.cwd,
      resolvedPath,
      grants: this.grantsView(),
    });
    // Credential trees are NEVER writable, clean classification included
    // (review R5: the open posture's "~" allow-root would otherwise make
    // ~/.ssh/* silently writable — tightening, safe direction).
    const readFloor = readViolation(filesystem, this.cwd, resolvedPath);
    if (readFloor !== undefined) return { block: true, reason: readFloor };
    if (clean || violation === undefined) return undefined;
    if (!this.confirmable(resolvedPath, filesystem) || ask === undefined) {
      return { block: true, reason: violation.reason };
    }
    const grant = grantAsk ?? ({ kind: "write-dir", value: resolvedPath } as const);
    const choice = await this.dedupedAsk(
      ask,
      { kind: grant.kind, value: grant.value, detail: `target ${resolvedPath}` },
      signal,
    );
    if (choice === "deny") return { block: true, reason: violation.reason };
    this.applyChoice(grant.kind, grant.value, choice);
    return undefined;
  }

  /** The permission gate's containment view (plan §4.4 B): sandboxed bash is
   * silent; writes the sandbox would let through need no advisory ask. */
  oracle(): ContainmentOracle {
    return {
      silentBash: () => this.runtime.active && this.snapshot.config.enabled,
      classifyWrite: (resolvedPath) =>
        classifyWriteWithGrants({
          policy: this.filesystem(),
          cwd: this.cwd,
          resolvedPath,
          grants: this.grantsView(),
        }).clean
          ? "clean"
          : "violation",
    };
  }

  /** Pre-connection network ask (the OS proxy callback, plan §4.4 E). The
   * session grant store is consulted FIRST — the instant truth that makes
   * "session/always then never ask again" independent of updateConfig
   * liveness. ask === undefined = no dialog-capable surface (subagent /
   * mid-exec without UI / deny posture): deny the connection. */
  /** Whether bash escalation dialogs are offerable at all: the ask posture
   * and a non-subagent spawn (v0.10 bashRerunDeps gating, generalized). */
  bashAskable(): boolean {
    return this.snapshot.config.onViolation === "ask" && !this.subagent;
  }

  /** True once the binding registered the pre-connection network callback:
   * network denials were then already adjudicated (asked or auto-denied) —
   * the post-failure digest path must not re-ask them. */
  networkCallbackActive = false;

  async networkAsk(host: string, ask: SandboxAskPort | undefined): Promise<boolean> {
    if (ask === undefined) return false;
    // Deny floors first and glob-aware (review R3: a wildcard deny entry
    // must outrank every grant, not just exact-string matches).
    if (
      this.snapshot.config.network.deniedDomains.some((pattern) => globMatches(pattern, host)) ||
      !this.bashAskable()
    ) {
      return false;
    }
    if (this.grantsView().domains.has(host)) return true;
    const choice = await this.dedupedAsk(ask, {
      kind: "network-domain",
      value: host,
      detail: host,
    });
    if (choice === "deny") return false;
    this.applyChoice("network-domain", host, choice);
    if (choice !== "once") this.syncRuntimeNow();
    return true;
  }

  /** Post-failure bash escalation (plan §4.3 bash rows). A prefix-granted
   * command skips the ask (every composed segment must be covered); the
   * four-way ask otherwise mints the SUGGESTED per-segment prefixes on
   * session/always (≤5, Claude's compound-approval precedent). */
  async bashEscalationDecision(
    command: string,
    ask: SandboxAskPort | undefined,
  ): Promise<{ rerun: true } | { rerun: false }> {
    if (ask === undefined) return { rerun: false };
    // Posture first (review R2): the deny posture suppresses even granted
    // prefixes — v0.7 wholesale hard-blocking, no exemption surface.
    if (!this.bashAskable()) return { rerun: false };
    if (commandPrefixGranted(command, this.grantsView().bashPrefixes)) {
      return { rerun: true };
    }
    const choice = await this.dedupedAsk(ask, {
      kind: "bash-escalation",
      value: command,
      detail: command,
    });
    if (choice === "deny") return { rerun: false };
    if (choice !== "once") {
      for (const prefix of suggestPrefixes(command)) {
        this.applyChoice("bash-escalation", prefix, choice);
      }
    }
    return { rerun: true };
  }

  /** Hard floors decide confirmability (v0.10 semantics, unchanged): the
   * ask posture, no subagent, no protected-path target, no denyRead hit. */
  private confirmable(resolvedPath: string, filesystem: SandboxFsPolicy): boolean {
    if (this.snapshot.config.onViolation !== "ask" || this.subagent) return false;
    if (this.snapshot.protectedPaths.some((entry) => pathWithin(resolvedPath, entry))) {
      return false;
    }
    // Credential trees stay out of the click-to-allow flow; a write that
    // classifies clean keeps passing (the floor only tightens dialogs).
    return readViolation(filesystem, this.cwd, resolvedPath) === undefined;
  }

  /** One ask per grant key while in flight: concurrent identical violations
   * inherit the first dialog's outcome (queue-inheritance). */
  private dedupedAsk(
    ask: SandboxAskPort,
    request: { kind: SandboxAskKind; value: string; detail: string },
    signal?: AbortSignal,
  ): Promise<SandboxAskChoice> {
    const key = `${request.kind}:${request.value}`;
    const pending = this.inflight.get(key);
    if (pending !== undefined) return pending;
    const settled = ask(
      { kind: request.kind, value: request.value, detail: request.detail },
      signal === undefined ? undefined : { signal },
    )
      .catch(() => "deny" as const)
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, settled);
    return settled;
  }

  /** Record a choice's session grant (and, for Always kinds, hand the rule
   * to the persister — the session copy applies immediately). */
  private applyChoice(
    kind: "write-dir" | "write-pattern" | "network-domain" | "bash-escalation",
    value: string,
    choice: SandboxAskChoice,
  ): void {
    if (choice !== "session" && choice !== "always") return;
    if (kind === "write-dir") addCapped(this.grants.writeDirs, WRITE_DIR_CAP, value);
    if (kind === "write-pattern") addCapped(this.grants.writePatterns, WRITE_PATTERN_CAP, value);
    if (kind === "network-domain") addCapped(this.grants.domains, DOMAIN_CAP, value);
    if (kind === "bash-escalation") addCapped(this.grants.bashPrefixes, BASH_PREFIX_CAP, value);
    const persistedKind = alwaysGrantFor(kind);
    if (choice === "always" && persistedKind !== undefined) {
      this.options.persist.persist({ kind: persistedKind, value });
    }
  }

  /** Post-approval application of a CLASSIFIED bash violation (domain/dir):
   * the values land in the store, the runtime policy swaps, and the rerun
   * stays inside the sandbox. Returns the customConfig for a once-grant. */
  applyBashGrant(
    kind: "network-domain" | "write-dir",
    values: readonly string[],
    choice: SandboxAskChoice,
  ): void {
    if (choice === "once") return;
    for (const value of values) this.applyChoice(kind, value, choice);
    this.syncRuntimeNow();
  }
}
