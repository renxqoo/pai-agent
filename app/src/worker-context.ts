/**
 * What every worker command handler operates on: the single-session host
 * (P1 port face), the dialog broker, frame emitters, the long-operation
 * registry, and the backend's permission check (P2). Assembled once in
 * worker.ts after the backend bundle is ready.
 */

import type { WorkerCommand } from "./protocol-internal.ts";
import type { DialogBroker } from "./dialogs.ts";
import type { InflightRegistry } from "./inflight-registry.ts";
import type { HubFrame } from "./protocol.ts";
import type {
  WorkerGrantFrame,
  WorkerHeartbeatFrame,
  WorkerSandboxGrantFrame,
} from "./protocol-internal.ts";
import type { CapabilityBit } from "./backend/capabilities.ts";
import type { CheckPermission } from "./backend/ports/interception.ts";
import type { PaiSessionHost, PaiThread } from "./backend/ports/session.ts";

export interface WorkerContext {
  sessions: PaiSessionHost;
  broker: DialogBroker;
  emit: (
    frame: HubFrame | WorkerHeartbeatFrame | WorkerGrantFrame | WorkerSandboxGrantFrame,
  ) => void;
  /** v0.11: the backend's capability set (hello-frame mirror, assembled
   * from the backend bundle) — drives the prompt-path /compact interception
   * and the builtin get_commands gating. */
  capabilities: ReadonlySet<CapabilityBit>;
  /** v0.6: effective direct-bash wall clock (PAI_BASH_TIMEOUT_MS default; a
   * command's timeoutMs overrides, 0 disables per command). */
  bashTimeoutMs: number;
  registerInflight: InflightRegistry["register"];
  /** Worker self-shutdown (fork destroyed the session, etc). */
  triggerShutdown: (reason: string) => void;
  success: (id: string | undefined, command: string, data?: unknown) => void;
  failure: (id: string | undefined, command: string, error: string) => void;
  requireThread: (
    threadId: string,
    command: string,
    id: string | undefined,
  ) => PaiThread | undefined;
  /** Route a ui_response into a live grandchild (false = not a subagent request). */
  routeSubagentUi: (requestId: string, payload: Record<string, unknown>) => boolean;
  /** U2: client abort / thread stop kills every subagent (foreground + background). */
  killSubagents: () => void;
  /** Stage 7: steer a running subagent; true on ack, otherwise an error string. */
  steerSubagent: (subagentId: string, message: string) => Promise<boolean | string>;
  /** v0.6 INTERNAL grant_result: wake the pending acquire by grant id
   * (running feeds the denial message when granted is false). */
  resolveGrant: (grantId: string, granted: boolean, running?: number) => void;
  /** P2: the backend's direct-bash permission check (same rules/dialog path
   * as the agent's bash tool). */
  checkPermission: CheckPermission;
}

/** One worker command handler (registered by type in worker-commands.ts). */
export type WorkerHandler = (
  ctx: WorkerContext,
  cmd: WorkerCommand,
  id: string | undefined,
) => Promise<void>;
