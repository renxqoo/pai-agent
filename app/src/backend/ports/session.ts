/**
 * P1 session port (capability-packs plan §1.3): the exact session surface the
 * composition layer consumes (worker-commands / bash-commands /
 * command-listing / heartbeat), declared as pai-owned structural types. The
 * coding-agent adapter's AgentSession satisfies these members structurally
 * (tsc proves it); any backend must provide them on its session objects.
 * Derived 1:1 from the protocol commands — no member without a command or
 * frame that needs it (port derivation discipline, plan §0). `subscribe` and
 * runtime replacement stay adapter-internal: composition never touches them.
 */

import type { PermissionRules } from "../../rules.ts";
import type { SessionModel, SetThinkingLevelCmd } from "../../protocol.ts";

/** Image attachments as declared on the wire (ImagePayload-compatible). */
export interface PaiImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** prompt() options as pai uses them (fire-and-accept preflight contract). */
export interface PaiPromptOptions {
  images?: ReadonlyArray<PaiImage>;
  streamingBehavior?: "steer" | "followUp";
  source?: string;
  preflightResult?: (success: boolean) => void;
}

/** navigate_tree options (protocol NavigateTreeCmd minus type/threadId). */
export interface PaiNavigateOptions {
  summarize?: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

/** The session-manager sub-face composition reads (entries/tree/cwd). */
export interface PaiSessionManager {
  getCwd(): string;
  getEntries(): ReadonlyArray<{ id: string }>;
  getLeafId(): string | null;
  getTree(): unknown;
}

/** The extension-runner sub-face composition reads (bash hook + commands). */
export interface PaiExtensionRunner {
  emitUserBash(event: {
    type: "user_bash";
    command: string;
    excludeFromContext: boolean;
    cwd: string;
  }): Promise<{ result?: unknown; operations?: unknown } | undefined>;
  getRegisteredCommands(): ReadonlyArray<{ invocationName: string; description?: string }>;
}

/** The resource-loader sub-face composition reads (get_commands skills, /skill: pointer rewrite). */
export interface PaiResourceLoader {
  getSkills(): { skills: ReadonlyArray<{ name: string; description?: string; filePath: string }> };
}

/**
 * One conversation's session as the composition layer sees it. Payloads pai
 * passes through to responses are `unknown` — the wire is JSON; the backend
 * owns the rich types. Awaited calls return Promise (await-thenable gate).
 */
export interface PaiSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly sessionName: string | undefined;
  readonly model: unknown;
  readonly thinkingLevel: unknown;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly messages: ReadonlyArray<unknown>;
  readonly sessionManager: PaiSessionManager;
  readonly extensionRunner: PaiExtensionRunner;
  readonly promptTemplates: ReadonlyArray<{ name: string; description?: string }>;
  readonly resourceLoader: PaiResourceLoader;

  prompt(message: string, options?: PaiPromptOptions): Promise<void>;
  steer(message: string, images?: ReadonlyArray<PaiImage>): Promise<unknown>;
  followUp(message: string, images?: ReadonlyArray<PaiImage>): Promise<unknown>;
  abort(): Promise<unknown>;
  abortCompaction(): unknown;
  compact(customInstructions?: string): Promise<unknown>;
  clearQueue(): unknown;
  setModel(model: SessionModel): Promise<unknown>;
  setThinkingLevel(level: SetThinkingLevelCmd["level"]): void;
  getAvailableThinkingLevels(): unknown;
  setSessionName(name: string): void;
  getSessionStats(): unknown;
  navigateTree(targetId: string, options: PaiNavigateOptions): Promise<unknown>;
  getUserMessagesForForking(): unknown;
  executeBash(
    command: string,
    onChunk?: (chunk: string) => void,
    options?: { excludeFromContext?: boolean; id?: string; operations?: unknown },
  ): Promise<unknown>;
  abortBash(): void;
  recordBashResult(
    command: string,
    result: unknown,
    options: { excludeFromContext: boolean },
  ): void;
}

/** A thread as composition sees it: the session plus routing facts. */
export interface PaiThread {
  session: PaiSession;
  cwd: string;
  sessionPath: string | undefined;
}

/** Sandbox observability snapshot (v0.7 get_sandbox_state payload face;
 * onViolation + exemptions are the v0.10 additions — serialized list form). */
export interface PaiSandboxState {
  snapshot: {
    config: {
      enabled: boolean;
      onViolation: "ask" | "deny";
      network: unknown;
      filesystem: unknown;
    };
    source: string;
  };
  runtime: {
    active: boolean;
    degraded?: string;
  };
  /** Session-scoped "don't ask again" grants (empty on backends without the
   * confirm escalation, e.g. the probe). In-process Sets; the wire face
   * (get_sandbox_state) serializes them to lists. */
  exemptions: {
    writePaths: Set<string>;
    bashCommands: Set<string>;
  };
}

/** Subagent shaping of an internal thread/start (plan §3.2). */
export interface SpawnShaping {
  systemPrompt?: string;
  tools?: string[];
  thinkingLevel?: SetThinkingLevelCmd["level"];
  /** Parent conversation id: the gate re-reads ITS ruleset on every decision. */
  permissionThreadId?: string;
  parentProtectedPaths?: string[];
  /** Depth 1: the task tool is not registered inside this session. */
  subagent?: boolean;
  /** Labels for the grandchild's subagent_message frames (advisory). */
  subagentId?: string;
  agentName?: string;
  /** In-memory session: no session file. */
  ephemeral?: boolean;
}

/** Extract the shaping fields of an internal thread/start command. */
export function startShaping(cmd: {
  systemPrompt?: string;
  tools?: string[];
  thinkingLevel?: SetThinkingLevelCmd["level"];
  permissionThreadId?: string;
  parentProtectedPaths?: string[];
  subagent?: boolean;
  subagentId?: string;
  agentName?: string;
  ephemeral?: boolean;
}): SpawnShaping | undefined {
  const shaping: SpawnShaping = {
    ...(cmd.systemPrompt !== undefined ? { systemPrompt: cmd.systemPrompt } : {}),
    ...(cmd.tools !== undefined ? { tools: cmd.tools } : {}),
    ...(cmd.thinkingLevel !== undefined ? { thinkingLevel: cmd.thinkingLevel } : {}),
    ...(cmd.permissionThreadId !== undefined ? { permissionThreadId: cmd.permissionThreadId } : {}),
    ...(cmd.parentProtectedPaths !== undefined
      ? { parentProtectedPaths: cmd.parentProtectedPaths }
      : {}),
    ...(cmd.subagent === true ? { subagent: true } : {}),
    ...(cmd.subagentId !== undefined ? { subagentId: cmd.subagentId } : {}),
    ...(cmd.agentName !== undefined ? { agentName: cmd.agentName } : {}),
    ...(cmd.ephemeral === true ? { ephemeral: true } : {}),
  };
  return Object.keys(shaping).length > 0 ? shaping : undefined;
}

/** fork/clone result as the wire response consumes it. */
export interface PaiForkResult {
  thread: PaiThread;
  previousThreadId: string;
  selectedText?: string;
  cancelled: boolean;
}

/**
 * The single-session host face (P1 lifecycle). Implementation today:
 * SessionHost (coding-agent adapter); one session per worker process.
 */
export interface PaiSessionHost {
  get(): PaiThread | undefined;
  /** Current session id for permission callers ("" before the first spawn). */
  threadId(): string;
  /** Grandchild gate ruleset (parent's live rules), if shaped. */
  getInjectedRules(): PermissionRules | undefined;
  /** Sandbox observability (v0.7). */
  getSandboxState(): PaiSandboxState;
  start(options: {
    cwd: string;
    trusted: boolean;
    model?: SessionModel;
    shaping?: SpawnShaping;
  }): Promise<PaiThread>;
  resume(options: {
    cwd: string | undefined;
    trusted: boolean;
    sessionPath: string;
  }): Promise<PaiThread>;
  fork(
    expectedThreadId: string,
    entryId: string,
    position: "before" | "at",
  ): Promise<PaiForkResult>;
  clone(expectedThreadId: string): Promise<{
    thread: PaiThread;
    previousThreadId: string;
    cancelled: boolean;
  }>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}
