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
import {
  type SandboxConfig,
  loadSandboxConfig,
  readViolation,
  resolveToolPath,
  sandboxDisabledByEnv,
  writeViolation,
} from "../../sandbox-config.ts";
import {
  type SandboxRuntimeState,
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

/** Per-session observable state (get_sandbox_state reads this). */
export interface SandboxGateState {
  snapshot: SandboxSnapshot;
  runtime: SandboxRuntimeState;
}

const DISABLED_SANDBOX_CONFIG: SandboxConfig = {
  enabled: false,
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
  // (batch-2 review P3).
  const protectedPaths = [
    join(agentDir, "sandbox.json"),
    join(cwd, ".pi", "sandbox.json"),
    ...parentProtectedPaths,
  ];
  return { config, source, protectedPaths };
}

export interface SandboxGateDeps {
  trusted: boolean;
  cwd: string;
  /** Mutable state holder owned by the session (get_sandbox_state reads it). */
  state: SandboxGateState;
  writeStderr: (text: string) => void;
  /** Extra implicit denyWrite paths (grandchildren pass the parent's
   * conversation project file here — batch-2 review P3). */
  parentProtectedPaths?: string[];
  /** Test seam: pre-built snapshot (defaults to building from env + files). */
  snapshot?: SandboxSnapshot;
  /** Test seam for the OS layer (defaults to the real runtime). */
  initializeRuntime?: typeof initializeSandboxRuntime;
}

/** The in-process write/edit/read hard-check handler (layer 1). */
function hardCheckHandler(deps: {
  policy: SandboxConfig["filesystem"];
  cwd: string;
}): (event: {
  toolName: string;
  input: unknown;
}) => { block: boolean; reason: string } | undefined {
  const { policy, cwd } = deps;
  return (event) => {
    const tool = event.toolName as "write" | "edit" | "read";
    if (tool !== "write" && tool !== "edit" && tool !== "read") return;
    const input =
      typeof event.input === "object" && event.input !== null
        ? (event.input as Record<string, unknown>)
        : {};
    const resolved = resolveToolPath(cwd, String(input.path ?? ""));
    const reason =
      tool === "read"
        ? readViolation(policy, cwd, resolved)
        : writeViolation(policy, cwd, resolved);
    if (reason !== undefined) {
      return { block: true, reason };
    }
    return;
  };
}

/** The OS-layer bash wiring (layer 2): tool replacement + user_bash capture. */
function mountBashSandbox(
  pi: ExtensionAPI,
  deps: {
    cwd: string;
    config: SandboxConfig;
    state: SandboxGateState;
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
  // Replace the built-in bash tool with the sandboxed twin (schema intact;
  // execution routes through the wrapped BashOperations). Registered once
  // per session; inert until the runtime reports active.
  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(...args: Parameters<typeof localBash.execute>) {
      if (!state.runtime.active) {
        return localBash.execute(...args);
      }
      const sandboxed = createBashTool(cwd, { operations: createSandboxedBashOperations() });
      return sandboxed.execute(...args);
    },
  });
  // Direct execution (the protocol `bash` command): hand the sandboxed
  // operations to the existing user_bash pipeline in worker-commands.
  pi.on("user_bash", () => {
    if (!state.runtime.active) return;
    return { operations: createSandboxedBashOperations() };
  });
}

export function createSandboxGate(deps: SandboxGateDeps): InlineExtension {
  const { cwd, state } = deps;
  state.snapshot = deps.snapshot ?? snapshotSandboxConfig({ ...deps, trusted: deps.trusted, cwd });
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
    pi.on("tool_call", hardCheckHandler({ policy: filesystem, cwd }));
    mountBashSandbox(pi, {
      cwd,
      config: { ...config, filesystem },
      state,
      writeStderr: deps.writeStderr,
      initializeRuntime,
    });
  };
}
