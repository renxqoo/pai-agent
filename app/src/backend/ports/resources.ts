/**
 * P4 resources port (capability-packs plan §1.3): agent-dir resolution,
 * resume-path admission, saved-session listing, agent-definition discovery,
 * and the permission-rules path — the resource conventions a backend owns.
 * The resume fence is backend-specific (session file formats differ); the
 * coding-agent implementation keeps the red-team containment semantics
 * (lexical + physical sessions-dir containment, no probing differential).
 * readHistory is the parked-read-history seam (v0.12): backends without a
 * session-file concept report `unsupported` and the host falls back to
 * waking the worker — the read shortcut never gates command availability.
 */

import type { FileEntry } from "@earendil-works/pi-coding-agent";

export interface PaiAgentDefinition {
  name: string;
  description?: string;
  source: string;
  model?: string;
  tools?: string[];
}

/** readHistory outcome: parsed entries, or why direct reading is unavailable. */
export type ReadHistoryResult =
  | { ok: true; fileEntries: FileEntry[] }
  | { ok: false; reason: "unsupported" | "not_found" | "invalid_file" };

export interface PaiResources {
  /** Effective agent dir (PAI_BACKEND-bundled conventions live under it). */
  agentDir(): string;
  /** models.json path (set_model_override merge target; same file the
   * bundle's ModelRuntime loads — one derivation per bundle). */
  modelsJsonPath(): string;
  /** Global permission-rules.json path (hot-read file truth). */
  rulesPath(): string;
  /** thread/resume admission error, or undefined when the path is allowed. */
  resumePathError(sessionPath: string): string | undefined;
  /** thread/list_saved payload (backend session store enumeration). */
  listSaved(cwd: string): Promise<{ sessions: unknown[] }>;
  /** Parked read history (v0.12): side-effect-free parse of one session
   * file for host-local get_entries/get_state. Never mutates the file. */
  readHistory(sessionPath: string): Promise<ReadHistoryResult>;
  /** agents/list discovery (trust gate applies inside the backend). */
  discoverAgents(options: { cwd: string; trusted: boolean }): ReadonlyArray<PaiAgentDefinition>;
}
