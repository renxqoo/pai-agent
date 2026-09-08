/**
 * Backend registry (design.md v0.8; plan §1.4.3): host-level backend
 * selection. `PAI_BACKEND=<id>` picks the backend (default
 * `pi-coding-agent` = spawn-self, never consults the registry file and keeps
 * the dynamic self-resolution that the compile form needs). Other ids must
 * be registered in `<agentDir>/backends.json` as `{command, args, env}`;
 * malformed files/entries degrade with a warning and the selection fails
 * closed (unregistered), never silently falling back to self. The registry
 * file is user-machine trust (same tier as permission-rules.json): pointing
 * it at an executable is an explicit trust declaration for that worker's
 * own containment.
 */

import { join } from "node:path";

export const DEFAULT_BACKEND_ID = "pi-coding-agent";
export const BACKENDS_FILE_NAME = "backends.json";

/** How the host spawns workers of the selected backend. */
export type BackendSpawn =
  | { kind: "self" }
  | { kind: "spec"; command: string; args: readonly string[]; env?: Record<string, string> }
  | { kind: "unregistered"; error: string };

export interface BackendSelection {
  backendId: string;
  spawn: BackendSpawn;
}

export interface RegistryDeps {
  /** PAI_BACKEND value (undefined/empty = default). */
  envBackendId: string | undefined;
  /** Effective agent dir (injected; respects PI_CODING_AGENT_DIR upstream). */
  agentDir: string;
  /** Registry file reader (undefined result = missing file). */
  readFile?: (path: string) => string | undefined;
  /** Degradation warnings (worker boot stderr). */
  warn?: (line: string) => void;
}

interface RegistryFileEntry {
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

function parseEntry(id: string, raw: unknown, warn: (line: string) => void): BackendSpawn {
  if (typeof raw !== "object" || raw === null) {
    warn(`pai-cli backends.json: entry ${id} is not an object; ignored`);
    return { kind: "unregistered", error: `backend ${id} is not registered` };
  }
  const entry = raw as RegistryFileEntry;
  if (typeof entry.command !== "string" || entry.command.length === 0) {
    warn(`pai-cli backends.json: entry ${id} has no command; ignored`);
    return { kind: "unregistered", error: `backend ${id} is not registered` };
  }
  const args = Array.isArray(entry.args) && entry.args.every((a) => typeof a === "string");
  if (!args) {
    warn(`pai-cli backends.json: entry ${id} has malformed args; ignored`);
    return { kind: "unregistered", error: `backend ${id} is not registered` };
  }
  const envOk =
    entry.env === undefined ||
    (typeof entry.env === "object" &&
      entry.env !== null &&
      Object.values(entry.env).every((v) => typeof v === "string"));
  if (!envOk) {
    warn(`pai-cli backends.json: entry ${id} has malformed env; ignored`);
    return { kind: "unregistered", error: `backend ${id} is not registered` };
  }
  const env =
    entry.env === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(entry.env as Record<string, string>).filter(([, v]) => v !== undefined),
        );
  return {
    kind: "spec",
    command: entry.command,
    args: entry.args as string[],
    ...(env !== undefined ? { env } : {}),
  };
}

/** Resolve the host-level backend selection (pure; fs injected). */
export function resolveBackendSelection(deps: RegistryDeps): BackendSelection {
  const warn = deps.warn ?? (() => {});
  const trimmed = deps.envBackendId?.trim();
  const backendId = trimmed !== undefined && trimmed.length > 0 ? trimmed : DEFAULT_BACKEND_ID;
  if (backendId === DEFAULT_BACKEND_ID) {
    return { backendId, spawn: { kind: "self" } };
  }
  const raw = deps.readFile?.(join(deps.agentDir, BACKENDS_FILE_NAME));
  if (raw === undefined) {
    return {
      backendId,
      spawn: {
        kind: "unregistered",
        error: `backend ${backendId} is not registered (no ${BACKENDS_FILE_NAME})`,
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warn(
      `pai-cli backends.json is malformed (${error instanceof Error ? error.message : String(error)}); ignored`,
    );
    return {
      backendId,
      spawn: { kind: "unregistered", error: `backend ${backendId} is not registered` },
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      backendId,
      spawn: { kind: "unregistered", error: `backend ${backendId} is not registered` },
    };
  }
  const entry = (parsed as Record<string, unknown>)[backendId];
  if (entry === undefined) {
    return {
      backendId,
      spawn: {
        kind: "unregistered",
        error: `backend ${backendId} is not registered in ${BACKENDS_FILE_NAME}`,
      },
    };
  }
  return { backendId, spawn: parseEntry(backendId, entry, warn) };
}
