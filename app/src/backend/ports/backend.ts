/**
 * The backend bundle faces (capability-packs plan §1.3/§1.5): what a backend
 * plugs into the host and worker composition roots. The composition layers
 * see only ports + protocol; the concrete bundle is selected once at the
 * assembly seam (src/backend/index.ts). Core invariants (exactly-one
 * response, settle-once, stdout single channel, occupancy) never live here.
 */

import type { CapabilityBit } from "../capabilities.ts";
import type { DialogBroker } from "../../dialogs.ts";
import type { HubFrame, WorkerGrantFrame, WorkerHeartbeatFrame } from "../../protocol.ts";
import type { CheckPermission } from "./interception.ts";
import type { PaiAuthFace, PaiModelRuntime } from "./model-auth.ts";
import type { PaiResources } from "./resources.ts";
import type { PaiSessionHost } from "./session.ts";
import type { StartGrandchildTask, SubagentRegistryFace } from "./subagent.ts";

/** Host-side bundle: global commands (models, auth, listings, admission). */
export interface HostBackend {
  id: string;
  capabilities: ReadonlySet<CapabilityBit>;
  /** Backend SDK version (get_host_info.piVersion, --version). */
  sdkVersion: string;
  modelRuntime: PaiModelRuntime;
  auth: PaiAuthFace;
  resources: PaiResources;
}

/** Worker-side session wiring deps (dialog broker stays composition). */
export interface WorkerSessionDeps {
  emit: (frame: HubFrame | WorkerHeartbeatFrame | WorkerGrantFrame) => void;
  broker: DialogBroker;
  writeStderr: (text: string) => void;
  subagents: SubagentRegistryFace;
}

/** Worker-side bundle: session host, grandchild driver, permission check. */
export interface WorkerBackend {
  id: string;
  capabilities: ReadonlySet<CapabilityBit>;
  createSessionHost(deps: WorkerSessionDeps): Promise<PaiSessionHost>;
  startTask: StartGrandchildTask;
  checkPermission: CheckPermission;
}
