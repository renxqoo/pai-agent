/**
 * Built-in permission gate. Two enforcement points, one decision function:
 * - `tool_call` events cover the agent's bash/write/edit tool calls;
 * - the hub's direct `bash` command calls checkPermission() itself (pi's
 *   user-bash path does not emit tool_call, and user_bash results cannot
 *   block — see docs/design.md).
 *
 * Rules are hot-reloaded from <agentDir>/permission-rules.json per call
 * (design.md "Permission rules v2"); decide() in rules.ts owns the order.
 * The path follows the effective agent dir (respects PI_CODING_AGENT_DIR).
 */

import { join } from "node:path";
import {
  type ExtensionAPI,
  getAgentDir,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { decide, type GatedTool, loadRules } from "./rules.ts";

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

/** Rules live under the effective agent dir. */
export function rulesPath(): string {
  return join(getAgentDir(), "permission-rules.json");
}

export interface PermissionCheck {
  block: boolean;
  reason?: string;
}

/**
 * Single permission decision shared by the tool_call gate and the hub's
 * direct bash command. `ask` resolves true to allow, false to deny.
 */
export async function checkPermission(
  tool: GatedTool,
  value: string,
  ask: (title: string, value: string) => Promise<boolean>,
): Promise<PermissionCheck> {
  const decision = decide(loadRules(rulesPath()), tool, value);
  if (decision === "allow") return { block: false };
  if (decision === "block") {
    return { block: true, reason: `Blocked by permission rules: ${tool} ${value}` };
  }
  const allowed = await ask(CONFIRM_TITLES[tool], value);
  return allowed ? { block: false } : { block: true, reason: `User denied: ${tool} ${value}` };
}

export const permissionGate: InlineExtension = (pi: ExtensionAPI): void => {
  pi.on("tool_call", async (event, ctx) => {
    const tool = event.toolName as GatedTool;
    const valueKey = TOOL_VALUE_KEYS[tool];
    if (valueKey === undefined) return undefined;

    const input = event.input as Record<string, unknown>;
    const value = String(input[valueKey] ?? "");

    if (!ctx.hasUI) {
      // Fail closed only at the ask stage: allow-all/allowPatterns still
      // pass (decide() first), unmatched commands block without a dialog.
      const check = await checkPermission(tool, value, async () => false);
      return check.block ? { block: true, reason: check.reason } : undefined;
    }

    const check = await checkPermission(tool, value, async (title, value2) => {
      // Wire the turn's abort signal so an `abort` command settles the
      // dialog immediately instead of waiting out the timeout.
      const allowed = await ctx.ui.confirm(title, value2, {
        timeout: CONFIRM_TIMEOUT_MS,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return allowed;
    });
    return check.block ? { block: true, reason: check.reason } : undefined;
  });
};
