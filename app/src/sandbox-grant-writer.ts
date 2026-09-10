/**
 * Host-side single-writer for "Always allow" sandbox grants (v0.12 plan
 * §4.3, review P1/P2): the global sandbox.json's `grants` section is the
 * ONLY thing grants ever touch (the posture-scoped network/filesystem
 * arrays are never rewritten — appending to them would leak a balanced
 * session's grants into strict sessions). Write is atomic (temp +
 * rename); the host event loop serializes concurrent workers' frames.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendGlobalGrant, type SandboxPersistGrantInput } from "./sandbox/config.ts";

export function sandboxGrantsPath(agentDir: string): string {
  return join(agentDir, "sandbox.json");
}

/** Best-effort (a failed persistence never disturbs the session that
 * already applied its own copy); returns an error message or undefined.
 * A dedupe no-op (value already present) is success, not malformed input. */
export function persistSandboxGrant(
  agentDir: string,
  grant: SandboxPersistGrantInput,
): string | undefined {
  const path = sandboxGrantsPath(agentDir);
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "{}\n";
  const next = appendGlobalGrant(raw, grant);
  if (next === null) {
    return `sandbox grant not persisted (malformed sandbox.json): ${path}`;
  }
  if (next === raw) return undefined; // idempotent: already granted
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, next, "utf8");
    renameSync(temp, path);
    return undefined;
  } catch (error) {
    return `sandbox grant persistence failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
