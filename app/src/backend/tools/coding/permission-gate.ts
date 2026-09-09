/**
 * Tool-call permission gate for non-extension backends (capability-packs
 * follow-up): the P2 interception point expressed through pi-agent-core's
 * `beforeToolCall` hook. Decision logic is the shared pure layer
 * (rules.decide) — same semantics as the default backend's inline gate:
 * bash matches the command string, write/edit match the path argument, read
 * is ungated at the permission layer (only the OS sandbox would gate it,
 * which this backend does not have). ask goes to the host dialog broker
 * with the 5-minute default-deny timeout.
 */

import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { type PermissionRules, decide, loadRules } from "../../../rules.ts";
import { readSidecarRules } from "../../../sidecar-rules.ts";

export const TOOL_ASK_TIMEOUT_MS = 300_000;

/** The gated value per tool: bash -> command string, write/edit -> path. */
function gatedValue(toolName: string, args: unknown): string | undefined {
  const shaped = args as { command?: unknown; path?: unknown };
  if (toolName === "bash") {
    return typeof shaped.command === "string" ? shaped.command : undefined;
  }
  if (toolName === "write" || toolName === "edit") {
    return typeof shaped.path === "string" ? shaped.path : undefined;
  }
  return undefined;
}

/** Rules chain: conversation sidecar, else the global hot-read file. */
function effectiveRules(threadId: string, rulesPath: string): PermissionRules {
  return readSidecarRules(threadId) ?? loadRules(rulesPath);
}

export interface ToolGateDeps {
  /** Current conversation id (sidecar keying; empty before the first start). */
  threadId: () => string;
  /** Global permission-rules.json path (bundle resources). */
  rulesPath: string;
  /** Permission confirm dialog (broker-backed); resolves false on timeout. */
  ask: (title: string, message: string) => Promise<boolean>;
}

export type ToolPermissionGate = (
  context: BeforeToolCallContext,
  signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

/** Wire the gate; returns the hook to pass as the Agent's beforeToolCall. */
export function createToolPermissionGate(deps: ToolGateDeps): ToolPermissionGate {
  return async (context) => {
    const toolName = context.toolCall.name;
    const value = gatedValue(toolName, context.args);
    if (value === undefined) return;
    if (toolName !== "bash" && toolName !== "write" && toolName !== "edit") return;
    const rules = effectiveRules(deps.threadId(), deps.rulesPath);
    const decision = decide(rules, toolName as "bash" | "write" | "edit", value);
    if (decision === "allow") return;
    if (decision === "block") {
      return { block: true, reason: `Blocked by permission rules: ${toolName} ${value}` };
    }
    const confirmed = await deps.ask(
      toolName === "bash" ? "Allow command execution?" : `Allow file ${toolName}?`,
      value,
    );
    if (confirmed) return;
    return { block: true, reason: "Denied by user" };
  };
}
