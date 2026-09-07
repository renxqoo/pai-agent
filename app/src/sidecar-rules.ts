/**
 * Per-conversation permission rule sidecars (plan ui-completeness §2):
 * `<agentDir>/permission-rules/<threadId>.json`. The file is the single
 * source of truth — the gate reads it per call (same cost class as the
 * global file hot read), and get/set_permission_rules are host-local
 * commands that only touch this module.
 *
 * threadId equals the session id the worker reports; on resume it comes
 * from the session file header, which pi does not validate — so every
 * path is built only after the whitelist check below.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type PermissionRules, parseRules } from "./rules.ts";

/** Hostile session-header ids must never reach a filesystem path. */
const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isSafeThreadId(threadId: string): boolean {
  return SAFE_THREAD_ID.test(threadId);
}

function sidecarPath(threadId: string): string | undefined {
  return isSafeThreadId(threadId)
    ? join(getAgentDir(), "permission-rules", `${threadId}.json`)
    : undefined;
}

/** Tolerant read (hand edits degrade to defaults); undefined = no sidecar.
 * A concurrent clear can remove the file between exists and read — ENOENT
 * means "gone", same as never written. */
export function readSidecarRules(threadId: string): PermissionRules | undefined {
  const path = sidecarPath(threadId);
  if (path === undefined || !existsSync(path)) return undefined;
  try {
    return parseRules(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Atomic write: unique tmp name (pid+random) then rename — readers see the
 * old or the new content, never a torn file. Returns the final path. */
export function writeSidecarRules(threadId: string, rules: PermissionRules): string {
  const path = sidecarPath(threadId);
  if (path === undefined) throw new Error("Invalid threadId for permission rules");
  mkdirSync(join(getAgentDir(), "permission-rules"), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rules, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

/** Idempotent delete; true when a file was removed. */
export function clearSidecarRules(threadId: string): boolean {
  const path = sidecarPath(threadId);
  if (path === undefined || !existsSync(path)) return false;
  rmSync(path);
  return true;
}

/**
 * Session replacement (fork/clone/navigate/wake re-key): the rules follow
 * the new id. Best-effort and never throws — a fs failure or an unsafe
 * target id must not kill the worker mid-replacement or abort a rebind;
 * callers warn on false and the conversation falls back to the global rules.
 */
export function copySidecarRules(fromThreadId: string, toThreadId: string): boolean {
  try {
    const rules = readSidecarRules(fromThreadId);
    if (rules === undefined) return false;
    writeSidecarRules(toThreadId, rules);
    return true;
  } catch {
    return false;
  }
}
