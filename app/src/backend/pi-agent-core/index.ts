/**
 * The pi-agent-core probe bundle (capability-packs plan W3): minimal chat
 * backend validating that the port seam does not leak. Host side reuses the
 * coding-agent model/auth/resource machinery verbatim (pi-ai + config files
 * are backend-independent); worker side runs one in-memory Agent per
 * conversation. Capability set is the honest minimum — everything else
 * fails with the v0.8 unsupported-capability error upstream.
 */

import { readFileSync } from "node:fs";
import { Agent } from "@earendil-works/pi-agent-core";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CapabilityBit } from "../capabilities.ts";
import type { HostBackend, WorkerBackend, WorkerSessionDeps } from "../ports/backend.ts";
import type { PaiEvent, SessionModel } from "../../protocol.ts";
import { AgentCoreSessionHost } from "./session-adapter.ts";
import {
  handleAuthList,
  handleAuthRemoveKey,
  handleAuthSetApiKey,
} from "../pi-coding-agent/host-auth.ts";
import { rulesPath } from "../pi-coding-agent/permission-gate.ts";

/** The probe's honest capability set: chat + shared model/auth surface. */
const PROBE_CAPABILITIES: ReadonlySet<CapabilityBit> = new Set<CapabilityBit>([
  "model.list",
  "model.auth",
  "image",
]);

/** pi-agent-core does not export a VERSION; read the installed package
 * (compiled single-file form degrades to "unknown"). */
export function agentCoreVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(
        new URL(
          "../../../node_modules/@earendil-works/pi-agent-core/package.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { version?: string };
    return manifest.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Shared host resources: same agent dir conventions as the default. */
function sharedResources(): HostBackend["resources"] {
  return {
    agentDir: () => getAgentDir(),
    rulesPath,
    // Unreachable: session.resume/listSaved/agents are capability-gated off.
    resumePathError: () => "Session file must be inside the agent sessions directory",
    listSaved: async () => ({ sessions: [] }),
    discoverAgents: () => [],
  };
}

export async function createAgentCoreHostBackend(): Promise<HostBackend> {
  const modelRuntime = await ModelRuntime.create();
  return {
    id: "pi-agent-core",
    capabilities: PROBE_CAPABILITIES,
    sdkVersion: agentCoreVersion(),
    modelRuntime,
    auth: {
      list: (deps, cmd, id) =>
        handleAuthList(
          { modelRuntime, emit: deps.emit, registerInflight: deps.registerInflight },
          cmd,
          id,
        ),
      setApiKey: (deps, cmd, id) =>
        handleAuthSetApiKey(
          { modelRuntime, emit: deps.emit, registerInflight: deps.registerInflight },
          cmd,
          id,
        ),
      removeKey: (deps, cmd, id) =>
        handleAuthRemoveKey(
          { modelRuntime, emit: deps.emit, registerInflight: deps.registerInflight },
          cmd,
          id,
        ),
    },
    resources: sharedResources(),
  };
}

export function createAgentCoreWorkerBackend(): WorkerBackend {
  return {
    id: "pi-agent-core",
    capabilities: PROBE_CAPABILITIES,
    startTask: () => {
      throw new Error("pi-agent-core backend does not support subagents");
    },
    checkPermission: async () => {
      throw new Error("pi-agent-core backend does not support permission.soft");
    },
    async createSessionHost(deps: WorkerSessionDeps) {
      const modelRuntime = await ModelRuntime.create();
      const pickModel = (model: SessionModel | undefined): SessionModel => {
        if (model !== undefined) return model;
        const [first] = modelRuntime.getAvailableSnapshot();
        if (first === undefined) throw new Error("No models available for pi-agent-core backend");
        return first;
      };
      const createAgent = (model: SessionModel | undefined): Agent =>
        new Agent({
          initialState: { model: pickModel(model), systemPrompt: "You are a helpful assistant." },
          // ModelRuntime.streamSimple matches the agent StreamFn shape 1:1.
          streamFn: modelRuntime.streamSimple.bind(modelRuntime),
        });
      const emit = (frame: { type: "event"; threadId: string; event: PaiEvent }): void => {
        deps.emit(frame);
      };
      return new AgentCoreSessionHost({ createAgent, emit, writeStderr: deps.writeStderr });
    },
  };
}
