/**
 * Host-local command handlers: the commands the host answers itself (thread
 * lifecycle routing, global listings, auth, ui_response ack). Everything
 * thread-scoped falls through to the worker pool via handlePassthrough.
 */

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join as joinPath, resolve as resolvePath } from "node:path";
import { type ModelRuntime, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agent-definitions.ts";
import type {
  AgentsListCmd,
  AuthListCmd,
  AuthRemoveKeyCmd,
  AuthSetApiKeyCmd,
  GetHostInfoCmd,
  GetModelsCmd,
  GetPermissionRulesCmd,
  HubCommand,
  HubFrame,
  SessionModel,
  SetModelCmd,
  SetPermissionRulesCmd,
  ThreadListCmd,
  ThreadListSavedCmd,
  ThreadResumeCmd,
  ThreadStartCmd,
  ThreadStopCmd,
  UiResponseCmd,
} from "./protocol.ts";
import { THREAD_SCOPED_COMMANDS } from "./protocol.ts";
import { readNonNegativeIntEnv } from "./int-env.ts";
import { responseFailure, responseSuccess } from "./frames.ts";
import type { RegisterInflight } from "./inflight-registry.ts";
import { handleAuthList, handleAuthRemoveKey, handleAuthSetApiKey } from "./host-auth.ts";
import type { WorkerPool } from "./worker-pool.ts";
import { rulesPath } from "./permission-gate.ts";
import { loadRules, validateRules } from "./rules.ts";
import {
  clearSidecarRules,
  isSafeThreadId,
  readSidecarRules,
  writeSidecarRules,
} from "./sidecar-rules.ts";

export interface HostDeps {
  pool: WorkerPool;
  modelRuntime: ModelRuntime;
  emit: (frame: HubFrame) => void;
  registerInflight: RegisterInflight;
  /** Static host facts collected once at startup (get_host_info). */
  hostMeta: {
    version: string;
    piVersion: string;
    bunVersion: string;
    startedAt: number;
  };
}

export type HostHandler = (
  deps: HostDeps,
  cmd: HubCommand,
  id: string | undefined,
) => Promise<void>;

/** Model resolution is host-only (single source of truth; the host's
 * snapshot is always fresh, a spawned-earlier worker's is not). */
/** Exported despite single-file use: the named single-truth point for
 * provider+modelId resolution (see AGENTS.md) — future callers must not
 * reimplement it. */
export function resolveModel(
  modelRuntime: ModelRuntime,
  provider: string,
  modelId: string,
): SessionModel | undefined {
  return modelRuntime
    .getAvailableSnapshot()
    .find((model) => model.provider === provider && model.id === modelId);
}

const handleStart: HostHandler = async (deps, cmd, id) => {
  const start = cmd as ThreadStartCmd;
  let model: SessionModel | undefined;
  if (start.provider !== undefined) {
    model = resolveModel(deps.modelRuntime, start.provider, start.modelId ?? "");
    if (!model) {
      deps.emit(
        responseFailure(id, start.type, `Model not found: ${start.provider}/${start.modelId}`),
      );
      return;
    }
  }
  await deps.pool.startThread(start, model);
};

/**
 * thread/resume path admission (red-team findings): absolute (relative
 * would resolve against the HOST cwd), physically under the agent's own
 * sessions directory (otherwise any client could make the hub load — and
 * serve back via get_entries — an arbitrary pi-format file from anywhere
 * on disk; one uniform error outside, no exists/valid differential for
 * path probing), and actually present (pi's SessionManager.open would
 * otherwise silently "resume" a brand-new empty session).
 *
 * Spaces stay consistent per check: lexical containment compares
 * resolve()'d strings (no symlink resolution — macOS /var is /private/var,
 * mixing spaces would reject legit paths), then physical containment
 * realpaths BOTH sides (a link inside sessions/ pointing outside is caught
 * there).
 */
function resumePathError(sessionPath: string): string | undefined {
  if (!isAbsolute(sessionPath)) {
    return "sessionPath must be an absolute path (echo the value returned by thread/start or a previous thread/resume)";
  }
  const sessionsLexical = resolvePath(joinPath(getAgentDir(), "sessions"));
  const resolved = resolvePath(sessionPath);
  if (resolved !== sessionsLexical && !resolved.startsWith(`${sessionsLexical}/`)) {
    return "Session file must be inside the agent sessions directory";
  }
  if (!existsSync(sessionPath)) {
    return `Session file not found: ${sessionPath}`;
  }
  const sessionsRoot = realpathSync(sessionsLexical); // exists: the file under it does
  const physical = realpathSync(sessionPath);
  if (physical !== sessionsRoot && !physical.startsWith(`${sessionsRoot}/`)) {
    return "Session file must be inside the agent sessions directory";
  }
  return undefined;
}

const handleResume: HostHandler = async (deps, cmd, id) => {
  const resume = cmd as ThreadResumeCmd;
  const error = resumePathError(resume.sessionPath ?? "");
  if (error !== undefined) {
    deps.emit(responseFailure(id, resume.type, error));
    return;
  }
  await deps.pool.resumeThread(resume);
};

const handleStop: HostHandler = async (deps, cmd, id) => {
  const stop = cmd as ThreadStopCmd;
  await deps.pool.stopThread(stop.threadId, id, stop.type);
};

const handleList: HostHandler = async (deps, cmd, id) => {
  deps.emit(responseSuccess(id, (cmd as ThreadListCmd).type, { threads: deps.pool.listEntries() }));
};

const handleListSaved: HostHandler = async (deps, cmd, id) => {
  const saved = cmd as ThreadListSavedCmd;
  const sessions = await SessionManager.list(saved.cwd ?? process.cwd());
  deps.emit(responseSuccess(id, saved.type, { sessions }));
};

const handleGetModels: HostHandler = async (deps, cmd, id) => {
  deps.emit(
    responseSuccess(id, (cmd as GetModelsCmd).type, {
      models: deps.modelRuntime.getAvailableSnapshot(),
    }),
  );
};

const handleSetModel: HostHandler = async (deps, cmd, id) => {
  const setModel = cmd as SetModelCmd;
  if (!deps.pool.hasThread(setModel.threadId)) {
    deps.emit(responseFailure(id, setModel.type, `Unknown threadId: ${setModel.threadId}`));
    return;
  }
  const model = resolveModel(deps.modelRuntime, setModel.provider, setModel.modelId);
  if (!model) {
    deps.emit(
      responseFailure(
        id,
        setModel.type,
        `Model not found: ${setModel.provider}/${setModel.modelId}`,
      ),
    );
    return;
  }
  await deps.pool.sendToThread(
    setModel,
    JSON.stringify({
      type: "set_model",
      threadId: setModel.threadId,
      model,
      ...(id !== undefined ? { id } : {}),
    }),
  );
};

const handleUiResponse: HostHandler = async (deps, cmd, id) => {
  // Exactly one ack from the host; the payload is broadcast to all live
  // workers and the owning one resolves its dialog.
  deps.pool.broadcastUiResponse(cmd as UiResponseCmd);
  deps.emit(responseSuccess(id, cmd.type));
};

// --- v0.5: per-conversation permission rules (host-local, no worker) ----------

const handleGetPermissionRules: HostHandler = (deps, cmd, id) => {
  const get = cmd as GetPermissionRulesCmd;
  const { threadId } = get;
  if (typeof threadId !== "string" || !isSafeThreadId(threadId)) {
    deps.emit(responseFailure(id, get.type, "Invalid threadId"));
    return Promise.resolve();
  }
  const sidecar = readSidecarRules(threadId);
  deps.emit(
    responseSuccess(
      id,
      get.type,
      sidecar !== undefined
        ? { rules: sidecar, source: "thread" }
        : { rules: loadRules(rulesPath()), source: "global" },
    ),
  );
  return Promise.resolve();
};

const handleSetPermissionRules: HostHandler = async (deps, cmd, id) => {
  const set = cmd as SetPermissionRulesCmd;
  const { threadId } = set;
  if (typeof threadId !== "string" || !isSafeThreadId(threadId)) {
    deps.emit(responseFailure(id, set.type, "Invalid threadId"));
    return;
  }
  if (set.rules === null) {
    clearSidecarRules(threadId);
    deps.emit(responseSuccess(id, set.type, { source: "global" }));
    return;
  }
  if (set.rules === undefined) {
    deps.emit(responseFailure(id, set.type, "rules must be an object or null"));
    return;
  }
  const validated = validateRules(set.rules);
  if (!validated.ok) {
    deps.emit(responseFailure(id, set.type, validated.error));
    return;
  }
  try {
    writeSidecarRules(threadId, validated.rules);
  } catch (error) {
    deps.emit(
      responseFailure(id, set.type, error instanceof Error ? error.message : String(error)),
    );
    return;
  }
  deps.emit(responseSuccess(id, set.type, { source: "thread" }));
};

const handleAuthListCommand: HostHandler = async (deps, cmd, id) => {
  await handleAuthList(
    { modelRuntime: deps.modelRuntime, emit: deps.emit, registerInflight: deps.registerInflight },
    cmd as AuthListCmd,
    id,
  );
};

const handleAuthSetApiKeyCommand: HostHandler = async (deps, cmd, id) => {
  await handleAuthSetApiKey(
    { modelRuntime: deps.modelRuntime, emit: deps.emit, registerInflight: deps.registerInflight },
    cmd as AuthSetApiKeyCmd,
    id,
  );
};

const handleAuthRemoveKeyCommand: HostHandler = async (deps, cmd, id) => {
  await handleAuthRemoveKey(
    { modelRuntime: deps.modelRuntime, emit: deps.emit, registerInflight: deps.registerInflight },
    cmd as AuthRemoveKeyCmd,
    id,
  );
};

// --- v0.5: agent definitions (host-local) --------------------------------------

/** agents/list {threadId?}: with a threadId, project-level agents of that
 * thread's cwd are included when the thread is trusted; without one only
 * user-level agents are visible (no cwd context, no trust decision). */
const handleAgentsList: HostHandler = (deps, cmd, id) => {
  const list = cmd as AgentsListCmd;
  const { threadId } = list;
  if (threadId !== undefined && typeof threadId !== "string") {
    deps.emit(responseFailure(id, list.type, "Invalid threadId"));
    return Promise.resolve();
  }
  let cwd = process.cwd();
  let trusted = false;
  if (threadId !== undefined) {
    const entry = deps.pool.entryFor(threadId);
    if (entry === undefined) {
      deps.emit(responseFailure(id, list.type, `Unknown threadId: ${threadId}`));
      return Promise.resolve();
    }
    ({ cwd, trusted } = entry);
  }
  const agents = discoverAgents({ cwd, trusted }).map((agent) => ({
    name: agent.name,
    description: agent.description,
    source: agent.source,
    ...(agent.tools !== undefined ? { tools: agent.tools } : {}),
    ...(agent.model !== undefined ? { model: agent.model } : {}),
  }));
  deps.emit(responseSuccess(id, list.type, { agents }));
  return Promise.resolve();
};

/** Registry of commands the host answers itself; everything else either
 * routes to a worker (thread-scoped) or is an unknown command. */
/** v0.6 get_host_info: host-local observability (design.md v0.6). */
const handleGetHostInfo: HostHandler = async (deps, cmd, id) => {
  const typed = cmd as GetHostInfoCmd;
  const counts = deps.pool.threadStateCounts();
  const limits = deps.pool.limits();
  deps.emit(
    responseSuccess(id, typed.type, {
      version: deps.hostMeta.version,
      piVersion: deps.hostMeta.piVersion,
      bunVersion: deps.hostMeta.bunVersion,
      pid: process.pid,
      uptimeMs: Date.now() - deps.hostMeta.startedAt,
      rssBytes: process.memoryUsage().rss,
      threads: counts,
      subagents: { running: deps.pool.runningGrants() },
      limits: {
        maxThreads: limits.maxThreads,
        idleRetireMs: limits.idleRetireMs,
        workerStaleMs: limits.workerStaleMs,
        workerExitTimeoutMs: limits.workerExitTimeoutMs,
        maxSubagents: limits.maxSubagents,
        bashTimeoutMs: readNonNegativeIntEnv("PAI_BASH_TIMEOUT_MS", 600_000),
      },
    }),
  );
};

export const hostHandlers: ReadonlyMap<string, HostHandler> = new Map<string, HostHandler>(
  Object.entries({
    "thread/start": handleStart,
    "thread/resume": handleResume,
    "thread/stop": handleStop,
    "thread/list": handleList,
    "thread/list_saved": handleListSaved,
    get_models: handleGetModels,
    set_model: handleSetModel,
    "auth/list": handleAuthListCommand,
    "auth/set_api_key": handleAuthSetApiKeyCommand,
    "auth/remove_key": handleAuthRemoveKeyCommand,
    ui_response: handleUiResponse,
    get_permission_rules: handleGetPermissionRules,
    set_permission_rules: handleSetPermissionRules,
    "agents/list": handleAgentsList,
    get_host_info: handleGetHostInfo,
  }),
);

/** Fallback for non-local commands: raw-line passthrough to the owning
 * worker (shape is identical on both sides of the host<->worker protocol).
 * Anything else keeps the v0.3 wording: unknown type -> "Unknown command";
 * known type missing its threadId -> the old lookup error. */
export async function handlePassthrough(
  deps: HostDeps,
  cmd: HubCommand,
  line: string,
): Promise<void> {
  const { id } = cmd;
  const name = typeof cmd.type === "string" ? cmd.type : "unknown";
  if (!THREAD_SCOPED_COMMANDS.has(name)) {
    deps.emit(responseFailure(id, name, `Unknown command: ${name}`));
    return;
  }
  const scoped = cmd as { threadId?: unknown };
  if (typeof scoped.threadId !== "string") {
    deps.emit(responseFailure(id, name, "Unknown threadId: undefined"));
    return;
  }
  await deps.pool.sendToThread(cmd as { type: string; threadId: string; id?: string }, line);
}
