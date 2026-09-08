/**
 * P2 interception port (capability-packs plan §1.3): the permission-check
 * hook the composition layer calls for direct-execution bash (the agent-tool
 * path is wired inside the backend as an inline gate). Decision logic lives
 * in the pure rules layer; backends provide the enforcement point. For
 * backends without permission.soft this face is unreachable — the bash.exec
 * capability gate fails the command first.
 */

import type { PermissionRules } from "../../rules.ts";

export type GatedToolName = "bash" | "write" | "edit";

export interface PermissionCheckRequest {
  tool: GatedToolName;
  value: string;
  ask: (title: string, value: string) => Promise<boolean>;
  threadId?: string;
  injectedRules?: PermissionRules;
}

export interface PermissionCheckResult {
  block: boolean;
  reason?: string;
}

export type CheckPermission = (request: PermissionCheckRequest) => Promise<PermissionCheckResult>;
