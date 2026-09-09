/**
 * P4 resources port (capability-packs plan §1.3): agent-dir resolution,
 * resume-path admission, saved-session listing, agent-definition discovery,
 * and the permission-rules path — the resource conventions a backend owns.
 * The resume fence is backend-specific (session file formats differ); the
 * coding-agent implementation keeps the red-team containment semantics
 * (lexical + physical sessions-dir containment, no probing differential).
 */

export interface PaiAgentDefinition {
  name: string;
  description?: string;
  source: string;
  tools?: string[];
  model?: string;
}

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
  /** agents/list discovery (trust gate applies inside the backend). */
  discoverAgents(options: { cwd: string; trusted: boolean }): ReadonlyArray<PaiAgentDefinition>;
}
