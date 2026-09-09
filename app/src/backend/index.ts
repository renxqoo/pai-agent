/**
 * The backend assembly seam (capability-packs plan §1.5): the one place
 * composition imports concrete bundles. Host-level selection (user ruling
 * R3): `PAI_BACKEND` env, default `pi-coding-agent`. Built-in backends spawn
 * this pai binary as their worker; anything else must be registered in
 * backends.json (external executable — the host then serves core commands
 * only and every capability-gated host command fails honestly). Bundles
 * import statically so the compiled single-file form keeps working.
 */

import { readFileSync } from "node:fs";
import {
  getAgentDir,
  ModelRuntime,
  VERSION as CODING_AGENT_VERSION,
} from "@earendil-works/pi-coding-agent";
import { modelsJsonPath } from "./pi-coding-agent/models-path.ts";
import {
  agentCoreVersion,
  createAgentCoreHostBackend,
  createAgentCoreWorkerBackend,
} from "./pi-agent-core/index.ts";
import {
  createCodingAgentHostBackend,
  createCodingAgentWorkerBackend,
} from "./pi-coding-agent/index.ts";
import { rulesPath } from "./pi-coding-agent/permission-gate.ts";
import type { HostBackend } from "./ports/backend.ts";
import type { WorkerBackend } from "./ports/backend.ts";
import { DEFAULT_BACKEND_ID, resolveBackendSelection, type BackendSelection } from "./registry.ts";

export { DEFAULT_BACKEND_ID };
export const AGENT_CORE_BACKEND_ID = "pi-agent-core";

/** Built-in backends spawn this pai binary as their worker (env-selected). */
const BUILTIN_BACKEND_IDS: ReadonlySet<string> = new Set([
  DEFAULT_BACKEND_ID,
  AGENT_CORE_BACKEND_ID,
]);

/** Sync backend-id parse (boot + --version path). */
export function backendIdFromEnv(env: { PAI_BACKEND?: string } = process.env): string {
  const trimmed = env.PAI_BACKEND?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : DEFAULT_BACKEND_ID;
}

/** Sync SDK version for --version (static per backend). */
export function backendSdkVersion(): string {
  const id = backendIdFromEnv();
  if (id === AGENT_CORE_BACKEND_ID) return agentCoreVersion();
  if (BUILTIN_BACKEND_IDS.has(id)) return CODING_AGENT_VERSION;
  return "external";
}

/**
 * How the host spawns workers of the selected backend: built-ins spawn self
 * (dynamic launch-form resolution preserved); anything else must be
 * registered in backends.json — unregistered ids fail closed here.
 */
export function resolveSpawnSelection(deps: {
  writeStderr: (line: string) => void;
}): BackendSelection {
  const backendId = backendIdFromEnv();
  if (BUILTIN_BACKEND_IDS.has(backendId)) {
    return { backendId, spawn: { kind: "self" } };
  }
  return resolveBackendSelection({
    envBackendId: process.env.PAI_BACKEND,
    agentDir: getAgentDir(),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return;
      }
    },
    warn: deps.writeStderr,
  });
}

export async function createHostBackend(id: string = backendIdFromEnv()): Promise<HostBackend> {
  if (id === DEFAULT_BACKEND_ID) return createCodingAgentHostBackend();
  if (id === AGENT_CORE_BACKEND_ID) return createAgentCoreHostBackend();
  return createExternalHostBackend(id);
}

/** External backend: core commands only; gated host commands throw the
 * v0.8 unsupported shape via the empty capability set. */
async function createExternalHostBackend(id: string): Promise<HostBackend> {
  const unsupported = (): never => {
    throw new Error(`External backend ${id} does not support this command`);
  };
  const modelRuntime = await ModelRuntime.create({ modelsPath: modelsJsonPath() });
  return {
    id,
    capabilities: new Set(),
    sdkVersion: "external",
    modelRuntime,
    auth: {
      list: () => Promise.resolve(unsupported()),
      setApiKey: () => Promise.resolve(unsupported()),
      removeKey: () => Promise.resolve(unsupported()),
    },
    resources: {
      agentDir: () => getAgentDir(),
      modelsJsonPath,
      rulesPath,
      resumePathError: () => "Session file must be inside the agent sessions directory",
      listSaved: async () => ({ sessions: [] }),
      discoverAgents: () => [],
    },
  };
}

export function createWorkerBackend(id: string = backendIdFromEnv()): WorkerBackend {
  if (id === DEFAULT_BACKEND_ID) return createCodingAgentWorkerBackend();
  if (id === AGENT_CORE_BACKEND_ID) return createAgentCoreWorkerBackend();
  // External backends never run this binary's worker: their workers are the
  // executables registered in backends.json.
  throw new Error(`Unknown PAI_BACKEND: ${id}`);
}
