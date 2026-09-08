/**
 * The backend assembly seam (capability-packs plan §1.5): the one place
 * composition imports concrete bundles. Host-level selection (user ruling
 * R3): `PAI_BACKEND` env, default `pi-coding-agent`. Unknown ids fail boot
 * with a clear error — never a silent fallback. Bundles import statically so
 * the compiled single-file form keeps working. W3 adds the pi-agent-core
 * probe here; W4 routes non-default ids through the backends.json registry
 * for spawn specs — selection itself stays here.
 */

import { VERSION as CODING_AGENT_VERSION } from "@earendil-works/pi-coding-agent";
import {
  createCodingAgentHostBackend,
  createCodingAgentWorkerBackend,
} from "./pi-coding-agent/index.ts";
import type { HostBackend } from "./ports/backend.ts";
import type { WorkerBackend } from "./ports/backend.ts";
import { DEFAULT_BACKEND_ID } from "./registry.ts";

export { DEFAULT_BACKEND_ID };

/** Sync backend-id parse (boot + --version path). */
export function backendIdFromEnv(env: { PAI_BACKEND?: string } = process.env): string {
  const trimmed = env.PAI_BACKEND?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : DEFAULT_BACKEND_ID;
}

/** Sync SDK version for --version (static per backend). */
export function backendSdkVersion(): string {
  return CODING_AGENT_VERSION;
}

export async function createHostBackend(id: string = backendIdFromEnv()): Promise<HostBackend> {
  if (id === DEFAULT_BACKEND_ID) return createCodingAgentHostBackend();
  throw new Error(`Unknown PAI_BACKEND: ${id}`);
}

export function createWorkerBackend(id: string = backendIdFromEnv()): WorkerBackend {
  if (id === DEFAULT_BACKEND_ID) return createCodingAgentWorkerBackend();
  throw new Error(`Unknown PAI_BACKEND: ${id}`);
}
