/**
 * Built-in sandbox gate (docs/plans/2026-09-09-sandbox.md §2): the second
 * defense line behind the permission gate. Loaded as an INLINE extension for
 * every thread — trusted or not, main or grandchild — because it only ever
 * restricts.
 *
 * Two enforcement layers, one session snapshot (plan §4):
 * - write/edit/read: in-process hard checks (pure JS) — always enforced when
 *   enabled, independent of the OS runtime;
 * - bash (agent tool + direct execution): OS-level wrapping via
 *   sandbox-runtime when the platform supports it and initialization
 *   succeeded; otherwise fail-open with a visible degraded reason.
 *
 * Layering: the permission gate runs FIRST (advisory rules + dialogs on the
 * original tool input); this gate then enforces. A permission-gate block
 * never reaches this gate; a permission-gate ALLOW still lands here.
 */

import {
  type ExtensionAPI,
  type InlineExtension,
  createBashTool,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { resolveMatchPath } from "../../gate-path.ts";
import {
  type SandboxConfig,
  classifyWriteViolation,
  denyReadRootVariants,
  loadSandboxConfig,
  pathWithin,
  readViolation,
  resolveToolPath,
  sandboxDisabledByEnv,
} from "../../sandbox-config.ts";
import {
  type SandboxRuntimeState,
  type BashRerunDeps,
  createSandboxedBashOperations,
  initializeSandboxRuntime,
  resetSandboxRuntime,
} from "./sandbox-bash.ts";

/** The session-creation snapshot every gate decision (and get_sandbox_state)
 * reads — one truth per session; config changes need a session restart.
 * `protectedPaths` are implicit denyWrite entries (the policy files
 * themselves, incl. the parent conversation's project file for
 * grandchildren) kept OUT of config so get_sandbox_state stays pristine. */
export interface SandboxSnapshot {
  config: SandboxConfig;
  source: "global" | "global+project";
  protectedPaths: string[];
}

/** Session-scoped "don't ask again" grants (v0.10, user ruling): keys are
 * EXACT effect-space paths (write/edit — deliberately unfolded: folding
 * merges distinct files on case-sensitive volumes / mixed normalization,
 * a fail-open collision; same-file variants already unify through realpath)
 * and exact command strings (bash). Cleared whenever the snapshot is rebuilt
 * (fork/clone/rebind); never persisted. Caps keep the sets bounded — past
 * the cap we keep asking. */
export interface SandboxExemptions {
  writePaths: Set<string>;
  bashCommands: Set<string>;
}

export const WRITE_EXEMPTION_CAP = 64;
export const BASH_EXEMPTION_CAP = 32;

export function freshExemptions(): SandboxExemptions {
  return { writePaths: new Set(), bashCommands: new Set() };
}

/** Per-session observable state (get_sandbox_state reads this). */
export interface SandboxGateState {
  snapshot: SandboxSnapshot;
  runtime: SandboxRuntimeState;
  exemptions: SandboxExemptions;
}

const DISABLED_SANDBOX_CONFIG: SandboxConfig = {
  enabled: false,
  onViolation: "deny",
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
};

export function snapshotSandboxConfig(options: {
  trusted: boolean;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  parentProtectedPaths?: string[];
}): SandboxSnapshot {
  const { trusted, cwd } = options;
  const env = options.env ?? process.env;
  const parentProtectedPaths = options.parentProtectedPaths ?? [];
  if (sandboxDisabledByEnv(env)) {
    return { config: DISABLED_SANDBOX_CONFIG, source: "global", protectedPaths: [] };
  }
  const agentDir = getAgentDir();
  const { config, source } = loadSandboxConfig({ agentDir, cwd, trusted });
  // The sandbox's own policy files are ALWAYS denyWrite for the tools
  // (adversarial review P6): the sandboxed writer must not be able to weaken
  // a future session's snapshot. Grandchildren additionally protect the
  // PARENT conversation's project file — their task cwd may be a subdirectory
  // (batch-2 review P3). Entries resolve into EFFECT SPACE (realpath of the
  // deepest existing ancestor): tool paths arrive realpathed, so a lexical
  // entry would miss through any symlinked cwd/agentDir and the confirm
  // flow's hard floor would go confirmable (escalation review P1).
  const protectedPaths = [
    join(agentDir, "sandbox.json"),
    join(cwd, ".pi", "sandbox.json"),
    ...parentProtectedPaths,
  ].map((entry) => resolveMatchPath(cwd, entry));
  return { config, source, protectedPaths };
}

export interface SandboxGateDeps {
  trusted: boolean;
  cwd: string;
  /** Mutable state holder owned by the session (get_sandbox_state reads it). */
  state: SandboxGateState;
  writeStderr: (text: string) => void;
  /** Subagent (grandchild) spawns NEVER escalate to dialogs (social-
   * engineering surface): all confirmable violations stay hard-blocked. */
  subagent?: boolean;
  /** Extra implicit denyWrite paths (grandchildren pass the parent's
   * conversation project file here — batch-2 review P3). */
  parentProtectedPaths?: string[];
  /** Test seam: pre-built snapshot (defaults to building from env + files). */
  snapshot?: SandboxSnapshot;
  /** Test seam for the OS layer (defaults to the real runtime). */
  initializeRuntime?: typeof initializeSandboxRuntime;
}

/** v0.10 three-way dialog choices (exact-match parsed; anything else —
 * timeout, cancel, unknown value — settles as Deny / fail-closed). */
export const SANDBOX_CHOICE_ONCE = "Allow once";
export const SANDBOX_CHOICE_SESSION = "Allow for this session";
export const SANDBOX_CHOICE_DENY = "Deny";
export const SANDBOX_DIALOG_TIMEOUT_MS = 300_000;

export type SandboxDialogChoice = typeof SANDBOX_CHOICE_ONCE | typeof SANDBOX_CHOICE_SESSION;

/** Minimal dialog surface the confirm flow needs (satisfied by the pi
 * tool_call ctx and by test doubles). */
export interface SandboxDialogAsk {
  (title: string): Promise<SandboxDialogChoice | undefined>;
}

/** Resolve one confirmable violation through the three-way dialog honoring
 * session exemptions; undefined = keep blocked, "allowed" = pass through. */
async function confirmViolation(deps: {
  ask: SandboxDialogAsk;
  title: string;
  exemptionKey: string;
  exemptions: Set<string>;
  cap: number;
}): Promise<"allowed" | "blocked"> {
  const { ask, title, exemptionKey, exemptions, cap } = deps;
  if (exemptions.has(exemptionKey)) return "allowed";
  const choice = await ask(title);
  if (choice === SANDBOX_CHOICE_ONCE) return "allowed";
  if (choice === SANDBOX_CHOICE_SESSION) {
    if (exemptions.size < cap) exemptions.add(exemptionKey);
    return "allowed";
  }
  return "blocked";
}

/** Dialog-capable slice of the pi tool_call ctx (structural — tests
 * satisfy it with a plain double). */
interface SandboxUiContext {
  hasUI: boolean;
  signal?: AbortSignal;
  ui: {
    select: (
      title: string,
      options: string[],
      opts?: { timeout?: number; signal?: AbortSignal },
    ) => Promise<string | undefined>;
  };
}

/** Three-way dialog + session-exemption resolution for one confirmable
 * write/edit violation (v0.10): undefined = pass, else the hard block. */
async function escalateWriteViolation(deps: {
  violation: { kind: "outside-allow" | "deny-write"; entry?: string; reason: string };
  resolved: string;
  state: SandboxGateState;
  uiCtx: SandboxUiContext;
}): Promise<{ block: boolean; reason: string } | undefined> {
  const { violation, resolved, state, uiCtx } = deps;
  const ask: SandboxDialogAsk = async (title) => {
    let choice: string | undefined;
    try {
      choice = await uiCtx.ui.select(
        title,
        [SANDBOX_CHOICE_ONCE, SANDBOX_CHOICE_SESSION, SANDBOX_CHOICE_DENY],
        { timeout: SANDBOX_DIALOG_TIMEOUT_MS, ...(uiCtx.signal ? { signal: uiCtx.signal } : {}) },
      );
    } catch {
      return; // a throwing dialog channel settles fail-closed (Deny)
    }
    return choice === SANDBOX_CHOICE_ONCE || choice === SANDBOX_CHOICE_SESSION ? choice : undefined;
  };
  const title =
    violation.kind === "outside-allow"
      ? `Sandbox: write outside allowed paths (${resolved})`
      : `Sandbox: denyWrite match ${violation.entry} (${resolved})`;
  const outcome = await confirmViolation({
    ask,
    title,
    exemptionKey: resolved,
    exemptions: state.exemptions.writePaths,
    cap: WRITE_EXEMPTION_CAP,
  });
  return outcome === "allowed" ? undefined : { block: true, reason: violation.reason };
}

/** denyRead check: undefined passes, else the v0.7 hard block. */
function readCheck(
  policy: SandboxConfig["filesystem"],
  cwd: string,
  resolved: string,
): { block: boolean; reason: string } | undefined {
  const reason = readViolation(policy, cwd, resolved);
  return reason === undefined ? undefined : { block: true, reason };
}

/** Hard floors decide confirmability: NEVER dialog when the target is a
 * protected policy file (effect-space compare — escalation review P1), a
 * denyRead root with a write violation (P2), the posture is deny, the spawn
 * is a subagent, or no dialog-capable UI is present. */
function confirmContextFor(deps: {
  policy: SandboxConfig["filesystem"];
  cwd: string;
  config: SandboxConfig;
  subagent: boolean;
  protectedPaths: string[];
  resolved: string;
  ctx: SandboxUiContext | undefined;
}): SandboxUiContext | undefined {
  const { policy, cwd, config, subagent, protectedPaths, resolved, ctx } = deps;
  if (config.onViolation !== "ask" || subagent) return undefined;
  if (protectedPaths.some((entry) => pathWithin(resolved, entry))) return undefined;
  // Credential trees stay out of the click-to-allow flow. The floor only
  // tightens the dialog decision — a write that classifies clean
  // (denyRead∩allowWrite configs) keeps the v0.7 pass-through, so the "deny
  // posture ≡ v0.7" invariant holds and ask is never looser than deny.
  if (readViolation(policy, cwd, resolved) !== undefined) return undefined;
  return ctx !== undefined && ctx.hasUI ? ctx : undefined;
}

/** The in-process write/edit/read hard-check handler (layer 1), with the
 * v0.10 confirm escalation for write/edit violations. */
function hardCheckHandler(deps: {
  policy: SandboxConfig["filesystem"];
  cwd: string;
  config: SandboxConfig;
  state: SandboxGateState;
  subagent: boolean;
  protectedPaths: string[];
}): (
  event: {
    toolName: string;
    input: unknown;
  },
  ctx?: SandboxUiContext,
) => Promise<{ block: boolean; reason: string } | undefined> {
  const { policy, cwd, config, state, subagent, protectedPaths } = deps;
  return async (event, ctx) => {
    const tool = event.toolName as "write" | "edit" | "read";
    if (tool !== "write" && tool !== "edit" && tool !== "read") return;
    const input =
      typeof event.input === "object" && event.input !== null
        ? (event.input as Record<string, unknown>)
        : {};
    const resolved = resolveToolPath(cwd, String(input.path ?? ""));
    if (tool === "read") return readCheck(policy, cwd, resolved);
    const violation = classifyWriteViolation(policy, cwd, resolved);
    if (violation === undefined) return;
    const uiCtx = confirmContextFor({
      policy,
      cwd,
      config,
      subagent,
      protectedPaths,
      resolved,
      ctx,
    });
    if (uiCtx === undefined) {
      return { block: true, reason: violation.reason };
    }
    return escalateWriteViolation({ violation, resolved, state, uiCtx });
  };
}

/** Bash confirm-rerun wiring (v0.10): built per execution context — the
 * agent tool passes the turn's abort signal, direct execution goes
 * timeout-only (the permission gate's direct-bash ask is signal-free the
 * same way). Undefined = the v0.7 behavior (denial stays a failure). */
function bashRerunDeps(deps: {
  config: SandboxConfig;
  subagent: boolean;
  state: SandboxGateState;
  cwd: string;
  ui: SandboxUiContext["ui"] | undefined;
  signal?: AbortSignal;
}): BashRerunDeps | undefined {
  const { config, subagent, state, cwd, ui, signal } = deps;
  if (config.onViolation !== "ask" || subagent || ui === undefined) return undefined;
  return {
    confirmRerun: async (command) => {
      let choice: string | undefined;
      try {
        choice = await ui.select(
          `Sandbox denied this command — re-run without sandbox? (${command})`,
          [SANDBOX_CHOICE_ONCE, SANDBOX_CHOICE_SESSION, SANDBOX_CHOICE_DENY],
          { timeout: SANDBOX_DIALOG_TIMEOUT_MS, ...(signal ? { signal } : {}) },
        );
      } catch {
        return; // a throwing dialog channel settles fail-closed
      }
      if (choice === SANDBOX_CHOICE_ONCE) return "once";
      if (choice === SANDBOX_CHOICE_SESSION) return "session";
      return;
    },
    isExempted: (command) => state.exemptions.bashCommands.has(command),
    onSessionGrant: (command) => {
      if (state.exemptions.bashCommands.size < BASH_EXEMPTION_CAP) {
        state.exemptions.bashCommands.add(command);
      }
    },
    denyReadRoots: denyReadRootVariants(config.filesystem, cwd),
  };
}

/** The sandboxed bash tool replacement (schema intact; execution routes
 * through the wrapped BashOperations); inert until the runtime is active.
 * ToolDefinition.execute receives the ExtensionContext as its FIFTH
 * argument — the AgentTool type from createBashTool only declares four, but
 * the runtime passes them all, so the dialog surface is read from args[4]
 * directly (no toolCallId bookkeeping). */
function registerSandboxedBashTool(
  pi: ExtensionAPI,
  deps: {
    cwd: string;
    config: SandboxConfig;
    state: SandboxGateState;
    subagent: boolean;
    localBash: ReturnType<typeof createBashTool>;
  },
): void {
  const { cwd, config, state, subagent, localBash } = deps;
  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(...args: unknown[]) {
      const [toolCallId, params, signal, onUpdate] = args as Parameters<typeof localBash.execute>;
      if (!state.runtime.active) {
        return localBash.execute(toolCallId, params, signal, onUpdate);
      }
      const ctx = args[4] as { hasUI: boolean; ui: SandboxUiContext["ui"] } | undefined;
      const rerun = bashRerunDeps({
        config,
        subagent,
        state,
        cwd,
        ui: ctx !== undefined && ctx.hasUI ? ctx.ui : undefined,
        ...(signal !== undefined ? { signal } : {}),
      });
      const sandboxed = createBashTool(cwd, { operations: createSandboxedBashOperations(rerun) });
      return sandboxed.execute(toolCallId, params, signal, onUpdate);
    },
  });
}

/** The OS-layer bash wiring (layer 2): tool replacement + user_bash capture. */
function mountBashSandbox(
  pi: ExtensionAPI,
  deps: {
    cwd: string;
    config: SandboxConfig;
    state: SandboxGateState;
    subagent: boolean;
    writeStderr: (text: string) => void;
    initializeRuntime: typeof initializeSandboxRuntime;
  },
): void {
  const { cwd, config, state } = deps;
  const localBash = createBashTool(cwd);
  pi.on("session_start", async () => {
    state.runtime = await deps.initializeRuntime(config, cwd, deps.writeStderr);
  });
  // Await the reset: pi serializes handlers, and the library's initialize()
  // early-returns while the old promise lives — a fire-and-forget reset here
  // races the next session_start into a half-torn-down runtime (review P1).
  pi.on("session_shutdown", async () => {
    await resetSandboxRuntime();
  });
  registerSandboxedBashTool(pi, {
    cwd,
    config,
    state,
    subagent: deps.subagent,
    localBash,
  });
  // Direct execution (the protocol `bash` command): hand the sandboxed
  // operations to the existing user_bash pipeline in worker-commands. The
  // user_bash event ctx carries the session UI (timeout-only ask — the
  // direct-bash permission ask is signal-free the same way).
  pi.on("user_bash", (_event, ctx) => {
    if (!state.runtime.active) return;
    const rerun = bashRerunDeps({
      config,
      subagent: deps.subagent,
      state,
      cwd,
      ui: ctx !== undefined && ctx.hasUI ? ctx.ui : undefined,
    });
    return { operations: createSandboxedBashOperations(rerun) };
  });
}

export function createSandboxGate(deps: SandboxGateDeps): InlineExtension {
  const { cwd, state } = deps;
  state.snapshot = deps.snapshot ?? snapshotSandboxConfig({ ...deps, trusted: deps.trusted, cwd });
  // Snapshot rebuild (spawn/fork/clone/rebind) ⇒ fresh session exemptions:
  // "this session" grants never survive a conversation replacement.
  state.exemptions = freshExemptions();
  const initializeRuntime = deps.initializeRuntime ?? initializeSandboxRuntime;
  return (pi: ExtensionAPI): void => {
    const { config } = state.snapshot;
    // The effective FS policy = config + implicit protected paths (kept out
    // of the reported config — batch-2 review P8).
    const filesystem: SandboxConfig["filesystem"] = {
      ...config.filesystem,
      denyWrite: [...config.filesystem.denyWrite, ...state.snapshot.protectedPaths],
    };
    if (!config.enabled) {
      // Observation consistency: a fork into a disabled config must not keep
      // reporting the previous session's active runtime (review P5).
      state.runtime = { active: false };
      return; // inert: PAI_SANDBOX=off or enabled:false
    }
    pi.on(
      "tool_call",
      hardCheckHandler({
        policy: filesystem,
        cwd,
        config,
        state,
        subagent: deps.subagent === true,
        protectedPaths: state.snapshot.protectedPaths,
      }),
    );
    mountBashSandbox(pi, {
      cwd,
      config: { ...config, filesystem },
      state,
      subagent: deps.subagent === true,
      writeStderr: deps.writeStderr,
      initializeRuntime,
    });
  };
}
