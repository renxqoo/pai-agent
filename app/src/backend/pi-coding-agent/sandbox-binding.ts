/**
 * Backend binding: mounts the sandbox component package into one pi session
 * (docs/plans/2026-09-10-sandbox-v2.md §三). Replaces the v0.10 sandbox-gate:
 * policy/state live in src/sandbox/*; this file only adapts — pi tool_call /
 * user_bash ctx → AskPort, the OS-runtime lifecycle, the sandboxed bash tool
 * replacement, and (transitionally, until W3) the v0.10 exact-command bash
 * rerun wiring.
 */

import {
  type ExtensionAPI,
  type InlineExtension,
  createBashTool,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type SandboxSnapshot, buildSnapshot, resolveToolPath } from "../../sandbox/config.ts";
import { type SandboxController } from "../../sandbox/controller.ts";
import { createSandboxedBashOperations } from "../../sandbox/bash-exec.ts";
import {
  initializeSandboxRuntime,
  resetSandboxRuntime,
  updateSandboxRuntime,
} from "../../sandbox/runtime.ts";
import {
  SANDBOX_CHOICE_ALWAYS,
  SANDBOX_CHOICE_DENY,
  SANDBOX_CHOICE_ONCE,
  SANDBOX_CHOICE_SESSION,
  SANDBOX_DIALOG_TIMEOUT_MS,
  type SandboxAskChoice,
  type SandboxAskPort,
} from "../../sandbox/ports.ts";
import { askTitle } from "../../sandbox/policy.ts";

const CHOICE_BY_LABEL: Record<string, SandboxAskChoice> = {
  [SANDBOX_CHOICE_ONCE]: "once",
  [SANDBOX_CHOICE_SESSION]: "session",
  [SANDBOX_CHOICE_ALWAYS]: "always",
  [SANDBOX_CHOICE_DENY]: "deny",
};

/** Dialog-capable slice of the pi tool_call ctx (structural — tests satisfy
 * it with a plain double). */
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

/** ui.select → four-way AskPort (label parse; unknown/timeout/throw = deny). */
function askAdapter(ui: SandboxUiContext["ui"], signal: AbortSignal | undefined): SandboxAskPort {
  return async (request, opts) => {
    const dialogSignal = opts?.signal ?? signal;
    let label: string | undefined;
    try {
      label = await ui.select(
        askTitle(request),
        [SANDBOX_CHOICE_ONCE, SANDBOX_CHOICE_SESSION, SANDBOX_CHOICE_ALWAYS, SANDBOX_CHOICE_DENY],
        {
          timeout: SANDBOX_DIALOG_TIMEOUT_MS,
          ...(dialogSignal !== undefined ? { signal: dialogSignal } : {}),
        },
      );
    } catch {
      return "deny"; // a throwing dialog channel settles fail-closed
    }
    return CHOICE_BY_LABEL[label ?? ""] ?? "deny";
  };
}

/** In-process write/edit/read hard check (layer 1): the controller owns the
 * decision; this handler only adapts the pi event shape. */
function mountHardCheck(
  pi: ExtensionAPI,
  deps: { controller: SandboxController; cwd: string },
): void {
  const { controller, cwd } = deps;
  pi.on("tool_call", async (event, ctx?: SandboxUiContext) => {
    const tool = event.toolName as "write" | "edit" | "read";
    if (tool !== "write" && tool !== "edit" && tool !== "read") return;
    const input =
      typeof event.input === "object" && event.input !== null
        ? (event.input as Record<string, unknown>)
        : {};
    const resolved = resolveToolPath(cwd, String(input.path ?? ""));
    if (tool === "read") return controller.readDecision(resolved);
    const uiCtx = ctx !== undefined && ctx.hasUI ? ctx : undefined;
    return controller.writeDecision(
      resolved,
      uiCtx === undefined ? undefined : askAdapter(uiCtx.ui, uiCtx.signal),
      uiCtx?.signal,
    );
  });
}

/** The exec-scoped ask slot: the pre-connection network callback (registered
 * at runtime init) fires mid-exec, so it reads whichever dialog adapter the
 * CURRENT exec published. Empty between execs (and for subagents/no-UI) —
 * the controller then denies the connection. */
interface ActiveAskSlot {
  current: SandboxAskPort | null;
}

/** Build the sandboxed operations for one call site (agent tool / direct
 * bash), publishing the exec-scoped ask into the slot for the callback. */
function sandboxedOps(
  controller: SandboxController,
  ask: SandboxAskPort | undefined,
  slot: ActiveAskSlot,
): ReturnType<typeof createSandboxedBashOperations> {
  return createSandboxedBashOperations({
    controller,
    ask,
    onActive: (active) => {
      slot.current = active;
    },
  });
}

/** The network callback reads the slot; null (between execs) denies. */

/** The sandboxed bash tool replacement (schema intact; execution routes
 * through the wrapped BashOperations); inert until the runtime is active.
 * ToolDefinition.execute receives the ExtensionContext as its FIFTH
 * argument — the AgentTool type from createBashTool only declares four, but
 * the runtime passes them all, so the dialog surface is read from args[4].
 * ALL arguments (incl. ctx) forward to the twin tools: pi's bash tool needs
 * ctx for the PI_* session environment (review P5 — v0.7 forwarded all). */
function registerSandboxedBashTool(
  pi: ExtensionAPI,
  deps: {
    controller: SandboxController;
    localBash: ReturnType<typeof createBashTool>;
    slot: ActiveAskSlot;
  },
): void {
  const { controller, localBash, slot } = deps;
  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    // pai-owned schema (plan §4.4: the upstream "schema intact" convention
    // is superseded): escalate lets the MODEL pre-declare that a command
    // needs out-of-sandbox capabilities, replacing the wasted sandboxed
    // half-run + double side effects (codex on-request direction).
    parameters: escalatedSchema(localBash.parameters),
    description: `${localBash.description}\nSet escalate=true (with escalateReason) BEFORE running when you know the command needs capabilities beyond the sandbox (installing globally, writing outside the workspace, reaching unlisted hosts) — the user approves once instead of the command failing halfway.`,
    async execute(...args: unknown[]) {
      if (!controller.runtime.active) {
        return localBash.execute(...(args as Parameters<typeof localBash.execute>));
      }
      const ctx = args[4] as SandboxUiContext | undefined;
      const ask = ctx !== undefined && ctx.hasUI ? askAdapter(ctx.ui, ctx.signal) : undefined;
      const preApproved = await predeclaredEscalation({ controller, ask, args });
      if (preApproved !== undefined) return preApproved;
      const sandboxed = createBashTool(controller.cwd, {
        operations: sandboxedOps(controller, ask, slot),
      });
      return sandboxed.execute(...(args as Parameters<typeof localBash.execute>));
    },
  });
}

/** The twin tool's settled result type (derived — no upstream import). */
type BashToolResult = Awaited<ReturnType<ReturnType<typeof createBashTool>["execute"]>>;

/** Extend the twin's typebox schema with the escalation fields. */
function escalatedSchema(parameters: unknown): ReturnType<typeof Type.Object> {
  const { properties } = parameters as { properties: Record<string, unknown> };
  return Type.Object({
    ...properties,
    escalate: Type.Optional(
      Type.Boolean({
        description: "Pre-declare that this command must run outside the sandbox.",
      }),
    ),
    escalateReason: Type.Optional(
      Type.String({ description: "One line shown to the user in the approval dialog." }),
    ),
  });
}

/** Pre-declared escalation (plan §4.4): ask BEFORE the first run. Returns
 * undefined = run the normal sandboxed path; an approved escalation runs
 * the UNSANDBOXED twin (the plain createBashTool — unwrapped, unmasked). */
async function predeclaredEscalation(deps: {
  controller: SandboxController;
  ask: SandboxAskPort | undefined;
  args: unknown[];
}): Promise<BashToolResult | undefined> {
  const { controller, ask, args } = deps;
  const input = args[1] as { command?: unknown; escalate?: unknown } | undefined;
  const command = typeof input?.command === "string" ? input.command : undefined;
  if (input?.escalate !== true || command === undefined) return undefined;
  const decision = await controller.bashEscalationDecision(command, ask);
  if (!decision.rerun) {
    const declined: BashToolResult = {
      content: [{ type: "text", text: "Sandbox escalation declined by the user" }],
      details: undefined,
    };
    return declined;
  }
  const plain = createBashTool(controller.cwd);
  return plain.execute(...(args as Parameters<typeof plain.execute>));
}

/** The OS-layer bash wiring (layer 2): lifecycle + tool + user_bash capture. */
function mountBashSandbox(
  pi: ExtensionAPI,
  deps: {
    controller: SandboxController;
    writeStderr: (text: string) => void;
    initializeRuntime: typeof initializeSandboxRuntime;
  },
): void {
  const { controller } = deps;
  const slot: ActiveAskSlot = { current: null };
  const localBash = createBashTool(controller.cwd);
  pi.on("session_start", async () => {
    controller.setRuntimeSync((config, sessionCwd) => updateSandboxRuntime(config, sessionCwd));
    controller.runtime = await deps.initializeRuntime({
      config: { ...controller.snapshot.config, filesystem: controller.filesystem() },
      sessionCwd: controller.cwd,
      writeStderr: deps.writeStderr,
      // Pre-connection network ask (micro-repro verified): the proxy consults
      // this for hosts matching neither list; no active exec ask = deny.
      ask: (host) => controller.networkAsk(host, slot.current ?? undefined),
    });
    // The runtime re-initializes per session with the SNAPSHOT config —
    // surviving conversation grants (fork/clone) must be re-applied.
    controller.networkCallbackActive = controller.runtime.active;
    if (controller.runtime.active) controller.syncRuntimeNow();
  });
  // Await the reset: pi serializes handlers, and the library's initialize()
  // early-returns while the old promise lives — a fire-and-forget reset here
  // races the next session_start into a half-torn-down runtime (review P1).
  pi.on("session_shutdown", async () => {
    controller.onRuntimeDown();
    await resetSandboxRuntime();
  });
  registerSandboxedBashTool(pi, { controller, localBash, slot });
  // Direct execution (the protocol `bash` command): hand the sandboxed
  // operations to the existing user_bash pipeline in worker-commands. The
  // user_bash event ctx carries the session UI (timeout-only ask — the
  // direct-bash permission ask is signal-free the same way).
  pi.on("user_bash", (_event, ctx) => {
    if (!controller.runtime.active) return;
    const ask = ctx !== undefined && ctx.hasUI ? askAdapter(ctx.ui, ctx.signal) : undefined;
    return { operations: sandboxedOps(controller, ask, slot) };
  });
}

export interface SandboxBindingDeps {
  trusted: boolean;
  cwd: string;
  controller: SandboxController;
  writeStderr: (text: string) => void;
  /** Grandchild spawns (from the spawn shaping): never escalate to dialogs. */
  subagent?: boolean;
  parentProtectedPaths?: string[];
  snapshot?: SandboxSnapshot;
  env?: NodeJS.ProcessEnv;
  /** v0.12 posture from the thread command (thread.start/resume param). */
  posture?: "strict" | "balanced" | "open";
  /** v0.12 lineage (grandchild spawns): parent posture fallback + the
   * in-sandbox grant snapshot to adopt (plan §4.6). */
  lineage?: {
    posture: "strict" | "balanced" | "open";
    writeDirs: string[];
    writePatterns: string[];
    domains: string[];
  };
  /** Test seam (defaults to the real OS runtime initializer). */
  initializeRuntime?: typeof initializeSandboxRuntime;
}

export function createSandboxBinding(deps: SandboxBindingDeps): InlineExtension {
  const { cwd, controller, writeStderr } = deps;
  if (deps.subagent === true) controller.setSubagent(true);
  if (deps.lineage !== undefined) controller.adoptLineage(deps.lineage);
  const snapshot =
    deps.snapshot ??
    buildSnapshot({
      agentDir: getAgentDir(),
      trusted: deps.trusted,
      cwd,
      env: deps.env,
      parentProtectedPaths: deps.parentProtectedPaths,
      posture: deps.posture ?? deps.lineage?.posture,
    });
  // Snapshot rebuild (spawn/fork/clone/rebind) swaps the config; session
  // grants survive — conversation continuity (plan §4.3, review P15).
  controller.onSnapshotRebuilt(snapshot, cwd);
  const initializeRuntime = deps.initializeRuntime ?? initializeSandboxRuntime;
  return (pi: ExtensionAPI): void => {
    if (!controller.snapshot.config.enabled) {
      // Observation consistency: a fork into a disabled config must not keep
      // reporting the previous session's active runtime (review P5).
      controller.runtime = { active: false };
      return; // inert: PAI_SANDBOX=off or enabled:false
    }
    mountHardCheck(pi, { controller, cwd });
    mountBashSandbox(pi, { controller, writeStderr, initializeRuntime });
  };
}
