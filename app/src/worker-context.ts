/**
 * What every worker command handler operates on: the single-session host,
 * the dialog broker, frame emitters, and the long-operation registry.
 * Assembled once in worker.ts after the model runtime is ready.
 */

import type { DialogBroker } from "./dialogs.ts";
import type { InflightRegistry } from "./inflight-registry.ts";
import type { HubFrame, WorkerHeartbeatFrame } from "./protocol.ts";
import type { SessionHost, Thread } from "./session-host.ts";

export interface WorkerContext {
  sessions: SessionHost;
  broker: DialogBroker;
  emit: (frame: HubFrame | WorkerHeartbeatFrame) => void;
  registerInflight: InflightRegistry["register"];
  /** Worker self-shutdown (fork destroyed the session, etc). */
  triggerShutdown: (reason: string) => void;
  success: (id: string | undefined, command: string, data?: unknown) => void;
  failure: (id: string | undefined, command: string, error: string) => void;
  requireThread: (threadId: string, command: string, id: string | undefined) => Thread | undefined;
  /** Route a ui_response into a live grandchild (false = not a subagent request). */
  routeSubagentUi: (requestId: string, payload: Record<string, unknown>) => boolean;
  /** U2: client abort / thread stop kills every subagent (foreground + background). */
  killSubagents: () => void;
}
