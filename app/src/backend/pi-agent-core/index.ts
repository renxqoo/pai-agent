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
import type { SessionModel } from "../../protocol.ts";
import { AgentCoreSessionHost } from "./session-adapter.ts";
import {
  handleAuthList,
  handleAuthRemoveKey,
  handleAuthSetApiKey,
} from "../pi-coding-agent/host-auth.ts";
import { modelsJsonPath } from "../pi-coding-agent/models-path.ts";
import { rulesPath } from "../pi-coding-agent/permission-gate.ts";
import { createCodingToolset } from "../tools/coding/index.ts";
import { createToolPermissionGate, TOOL_ASK_TIMEOUT_MS } from "../tools/coding/permission-gate.ts";

/** The probe's honest capability set: chat + shared model/auth surface. */
const PROBE_CAPABILITIES: ReadonlySet<CapabilityBit> = new Set<CapabilityBit>([
  "model.list",
  "model.auth",
  "model.config",
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
    modelsJsonPath,
    rulesPath,
    // Unreachable: session.resume/listSaved/agents are capability-gated off.
    resumePathError: () => "Session file must be inside the agent sessions directory",
    listSaved: async () => ({ sessions: [] }),
    discoverAgents: () => [],
  };
}

export async function createAgentCoreHostBackend(): Promise<HostBackend> {
  const modelRuntime = await ModelRuntime.create({ modelsPath: modelsJsonPath() });
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

/** The probe session host with the coding toolset and permission gate:
 * the late-bound host reference feeds the gate the live session id. */
function createProbeSessionHost(deps: {
  broker: WorkerSessionDeps["broker"];
  emit: WorkerSessionDeps["emit"];
  writeStderr: WorkerSessionDeps["writeStderr"];
  pickModel: (model: SessionModel | undefined) => SessionModel;
  modelRuntime: ModelRuntime;
}): AgentCoreSessionHost {
  const hostRef: { current?: AgentCoreSessionHost } = {};
  const createAgent = (model: SessionModel | undefined, cwd: string): Agent => {
    const toolset = createCodingToolset({
      cwd,
      gate: createToolPermissionGate({
        threadId: () => hostRef.current?.threadId() ?? "",
        rulesPath: rulesPath(),
        ask: async (title, message) => {
          const threadId = hostRef.current?.threadId() ?? "";
          const response = await deps.broker.ask(
            threadId,
            { method: "confirm", title, message },
            { timeout: TOOL_ASK_TIMEOUT_MS },
          );
          return response?.["confirmed"] === true;
        },
      }),
    });
    return new Agent({
      initialState: {
        model: deps.pickModel(model),
        systemPrompt: "You are a helpful assistant.",
        tools: toolset.tools,
      },
      // ModelRuntime.streamSimple matches the agent StreamFn shape 1:1.
      streamFn: deps.modelRuntime.streamSimple.bind(deps.modelRuntime),
      ...(toolset.beforeToolCall !== undefined ? { beforeToolCall: toolset.beforeToolCall } : {}),
    });
  };
  const host = new AgentCoreSessionHost({
    createAgent,
    emit: deps.emit,
    writeStderr: deps.writeStderr,
  });
  hostRef.current = host;
  return host;
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
      return createProbeSessionHost({
        broker: deps.broker,
        emit: deps.emit,
        writeStderr: deps.writeStderr,
        pickModel,
        modelRuntime,
      });
    },
  };
}
