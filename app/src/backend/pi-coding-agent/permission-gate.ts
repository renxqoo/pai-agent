/**
 * Built-in permission gate. Two enforcement points, one decision function:
 * - `tool_call` events cover the agent's bash/write/edit tool calls;
 * - the hub's direct `bash` command calls checkPermission() itself (pi's
 *   user-bash path does not emit tool_call, and user_bash results cannot
 *   block — see docs/design.md).
 *
 * Rule resolution per call (plan ui-completeness §2): the conversation's
 * sidecar file when one exists, else the global `<agentDir>/permission-rules.json`
 * hot-read (design.md "Permission rules v2"). The file IS the truth — there is
 * no in-memory box. Paths follow the effective agent dir (respects
 * PI_CODING_AGENT_DIR).
 */

import { join } from "node:path";
import {
  type ExtensionAPI,
  getAgentDir,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { resolveMatchPath } from "../../gate-path.ts";
import { decide, type GatedTool, loadRules, type PermissionRules } from "../../rules.ts";
import { readSidecarRules } from "../../sidecar-rules.ts";

const CONFIRM_TIMEOUT_MS = 300_000;

const TOOL_VALUE_KEYS: Record<GatedTool, "command" | "path"> = {
  bash: "command",
  write: "path",
  edit: "path",
};

const CONFIRM_TITLES: Record<GatedTool, string> = {
  bash: "Allow command execution?",
  write: "Allow file write?",
  edit: "Allow file edit?",
};

/** Global rules live under the effective agent dir. */
export function rulesPath(): string {
  return join(getAgentDir(), "permission-rules.json");
}

/**
 * Grandchild gates get a LIVE rules provider (the parent conversation's
 * ruleset, re-read per call — never a spawn-time snapshot): the injected
 * provider wins; then sidecar; then the global hot read.
 */
export function effectiveRules(
  threadId: string | undefined,
  injected: PermissionRules | undefined = undefined,
): PermissionRules {
  if (injected !== undefined) return injected;
  if (threadId !== undefined) {
    const sidecar = readSidecarRules(threadId);
    if (sidecar !== undefined) return sidecar;
  }
  return loadRules(rulesPath());
}

export interface PermissionCheck {
  block: boolean;
  reason?: string;
}

/**
 * Single permission decision shared by the tool_call gate and the hub's
 * direct bash command. `ask` resolves true to allow, false to deny.
 */
export async function checkPermission(deps: {
  tool: GatedTool;
  value: string;
  ask: (title: string, value: string) => Promise<boolean>;
  threadId?: string;
  injectedRules?: PermissionRules;
}): Promise<PermissionCheck> {
  const { tool, value, ask, threadId, injectedRules } = deps;
  const decision = decide(effectiveRules(threadId, injectedRules), tool, value);
  if (decision === "allow") return { block: false };
  if (decision === "block") {
    return { block: true, reason: `Blocked by permission rules: ${tool} ${value}` };
  }
  const allowed = await ask(CONFIRM_TITLES[tool], value);
  return allowed ? { block: false } : { block: true, reason: `User denied: ${tool} ${value}` };
}

/**
 * Gate extension bound to one conversation: the session id is only known
 * after the session exists (and changes on fork/clone), so the factory
 * closes over a mutable ref owned by the SessionHost. The optional injected
 * rules getter is the grandchild's LIVE rules provider (it re-reads the
 * parent conversation's ruleset on every call). write/edit match values are
 * resolved to effect-space absolute paths against the session cwd.
 */
export function createPermissionGate(
  getThreadId: () => string,
  getInjectedRules?: () => PermissionRules | undefined,
  cwd: string = process.cwd(),
): InlineExtension {
  return (pi: ExtensionAPI): void => {
    pi.on("tool_call", async (event, ctx) => {
      const tool = event.toolName as GatedTool;
      const valueKey = TOOL_VALUE_KEYS[tool];
      if (valueKey === undefined) return;

      const input = event.input as Record<string, unknown>;
      const rawValue = String(input[valueKey] ?? "");
      const value = tool === "bash" ? rawValue : resolveMatchPath(cwd, rawValue);

      if (!ctx.hasUI) {
        // Fail closed only at the ask stage: allow-all/allowPatterns still
        // pass (decide() first), unmatched commands block without a dialog.
        const check = await checkPermission({
          tool,
          value,
          ask: async () => false,
          threadId: getThreadId(),
          injectedRules: getInjectedRules?.(),
        });
        return check.block ? { block: true, reason: check.reason } : undefined;
      }

      const check = await checkPermission({
        tool,
        value,
        ask: async (title, value2) => {
          // Wire the turn's abort signal so an `abort` command settles the
          // dialog immediately instead of waiting out the timeout.
          const allowed = await ctx.ui.confirm(title, value2, {
            timeout: CONFIRM_TIMEOUT_MS,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return allowed;
        },
        threadId: getThreadId(),
        injectedRules: getInjectedRules?.(),
      });
      return check.block ? { block: true, reason: check.reason } : undefined;
    });
  };
}
