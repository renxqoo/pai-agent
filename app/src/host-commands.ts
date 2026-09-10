/**
 * Host-local command handlers: the commands the host answers itself (thread
 * lifecycle routing, global listings, auth, ui_response ack). Everything
 * thread-scoped falls through to the worker pool via handlePassthrough.
 */

import type { HostBackend } from "./backend/ports/backend.ts";
import type { PaiModelRuntime } from "./backend/ports/model-auth.ts";
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
  SetIdleRetireMsCmd,
  SetModelCmd,
  SetModelOverrideCmd,
  SetPermissionRulesCmd,
  ThreadListCmd,
  ThreadListSavedCmd,
  ThreadRegisterCmd,
  ThreadRetireCmd,
  ThreadResumeCmd,
  ThreadSetKeepaliveCmd,
  ThreadStartCmd,
  ThreadStopCmd,
  UiResponseCmd,
} from "./protocol.ts";
import { THREAD_SCOPED_COMMANDS } from "./protocol-internal.ts";
import { handleSetModelOverride } from "./model-overrides.ts";
import { resolve as resolvePath } from "node:path";
import { readNonNegativeIntEnv } from "./int-env.ts";
import { responseFailure, responseSuccess } from "./frames.ts";
import type { RegisterInflight } from "./inflight-registry.ts";
import type { WorkerPool } from "./worker-pool.ts";
import { loadRules, validateRules } from "./rules.ts";
import {
  clearSidecarRules,
  isSafeThreadId,
  readSidecarRules,
  writeSidecarRules,
} from "./sidecar-rules.ts";

export interface HostDeps {
  pool: WorkerPool;
  backend: HostBackend;
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
  modelRuntime: PaiModelRuntime,
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
    model = resolveModel(deps.backend.modelRuntime, start.provider, start.modelId ?? "");
    if (!model) {
      deps.emit(
        responseFailure(id, start.type, `Model not found: ${start.provider}/${start.modelId}`),
      );
      return;
    }
  }
  await deps.pool.startThread(start, model);
};

const handleResume: HostHandler = async (deps, cmd, id) => {
  const resume = cmd as ThreadResumeCmd;
  // Backend-owned admission (coding-agent: sessions-dir containment fence).
  const error = deps.backend.resources.resumePathError(resume.sessionPath ?? "");
  if (error !== undefined) {
    deps.emit(responseFailure(id, resume.type, error));
    return;
  }
  await deps.pool.resumeThread(resume);
};

/** thread/register (v0.12): admit a session file as a parked entry without a
 * worker — the cold-start host table is empty and read commands are
 * thread-scoped, so read-only browsing needs the entry before get_entries. */
const handleRegister: HostHandler = async (deps, cmd, id) => {
  const register = cmd as ThreadRegisterCmd;
  const error = deps.backend.resources.resumePathError(register.sessionPath ?? "");
  if (error !== undefined) {
    deps.emit(responseFailure(id, register.type, error));
    return;
  }
  const sessionPath = resolvePath(register.sessionPath ?? "");
  const history = await deps.backend.resources.readHistory(sessionPath);
  if (!history.ok) {
    deps.emit(responseFailure(id, register.type, `Session file not readable: ${sessionPath}`));
    return;
  }
  const [header] = history.fileEntries;
  if (
    header === undefined ||
    header.type !== "session" ||
    typeof header.id !== "string" ||
    typeof header.cwd !== "string"
  ) {
    deps.emit(
      responseFailure(id, register.type, `Session file is not a pi session: ${sessionPath}`),
    );
    return;
  }
  const outcome = deps.pool.registerParked({
    sessionPath,
    threadId: header.id,
    cwd: header.cwd,
    trusted: register.trusted === true,
  });
  if (!outcome.ok) {
    deps.emit(responseFailure(id, register.type, outcome.error));
    return;
  }
  deps.emit(responseSuccess(id, register.type, outcome.data));
};

const handleStop: HostHandler = async (deps, cmd, id) => {
  const stop = cmd as ThreadStopCmd;
  await deps.pool.stopThread(stop.threadId, id, stop.type);
};

/** thread/retire (v0.13): manual idle-retire — parks the entry (the dispose
 * counterpart is thread/stop). Host-orchestrated: never routed to a worker. */
const handleRetire: HostHandler = async (deps, cmd, id) => {
  const retire = cmd as ThreadRetireCmd;
  deps.pool.retireThread(retire.threadId, id, retire.type);
  return Promise.resolve();
};

/** thread/set_keepalive (v0.13): host-local flag flip; unknown threads fail. */
const handleSetKeepalive: HostHandler = async (deps, cmd, id) => {
  const setKeepalive = cmd as ThreadSetKeepaliveCmd;
  if (typeof setKeepalive.keepalive !== "boolean") {
    deps.emit(responseFailure(id, setKeepalive.type, "Invalid keepalive"));
    return;
  }
  if (deps.pool.setKeepalive(setKeepalive.threadId, setKeepalive.keepalive)) {
    deps.emit(responseSuccess(id, setKeepalive.type, { keepalive: setKeepalive.keepalive }));
    return;
  }
  deps.emit(responseFailure(id, setKeepalive.type, `Unknown threadId: ${setKeepalive.threadId}`));
};

/** set_idle_retire_ms (v0.13): runtime threshold change; the applied (clamped)
 * value is the response so the client never displays a stale policy. */
const handleSetIdleRetireMs: HostHandler = async (deps, cmd, id) => {
  const setThreshold = cmd as SetIdleRetireMsCmd;
  if (typeof setThreshold.ms !== "number" || !Number.isFinite(setThreshold.ms)) {
    deps.emit(responseFailure(id, setThreshold.type, "Invalid ms"));
    return;
  }
  const applied = deps.pool.setIdleRetireMs(setThreshold.ms);
  deps.emit(responseSuccess(id, setThreshold.type, { idleRetireMs: applied }));
};

const handleList: HostHandler = async (deps, cmd, id) => {
  deps.emit(responseSuccess(id, (cmd as ThreadListCmd).type, { threads: deps.pool.listEntries() }));
};

const handleListSaved: HostHandler = async (deps, cmd, id) => {
  const saved = cmd as ThreadListSavedCmd;
  const { sessions } = await deps.backend.resources.listSaved(saved.cwd ?? process.cwd());
  deps.emit(responseSuccess(id, saved.type, { sessions }));
};

const handleGetModels: HostHandler = async (deps, cmd, id) => {
  deps.emit(
    responseSuccess(id, (cmd as GetModelsCmd).type, {
      models: deps.backend.modelRuntime.getAvailableSnapshot(),
    }),
  );
};

const handleSetModel: HostHandler = async (deps, cmd, id) => {
  const setModel = cmd as SetModelCmd;
  if (!deps.pool.hasThread(setModel.threadId)) {
    deps.emit(responseFailure(id, setModel.type, `Unknown threadId: ${setModel.threadId}`));
    return;
  }
  const model = resolveModel(deps.backend.modelRuntime, setModel.provider, setModel.modelId);
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
        : { rules: loadRules(deps.backend.resources.rulesPath()), source: "global" },
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

const authDeps = (deps: HostDeps) => ({
  emit: deps.emit,
  registerInflight: deps.registerInflight,
});

const handleAuthListCommand: HostHandler = async (deps, cmd, id) => {
  await deps.backend.auth.list(authDeps(deps), cmd as AuthListCmd, id);
};

const handleAuthSetApiKeyCommand: HostHandler = async (deps, cmd, id) => {
  await deps.backend.auth.setApiKey(authDeps(deps), cmd as AuthSetApiKeyCmd, id);
};

const handleAuthRemoveKeyCommand: HostHandler = async (deps, cmd, id) => {
  await deps.backend.auth.removeKey(authDeps(deps), cmd as AuthRemoveKeyCmd, id);
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
    const entry = deps.pool.entryFacts(threadId);
    if (entry === undefined) {
      deps.emit(responseFailure(id, list.type, `Unknown threadId: ${threadId}`));
      return Promise.resolve();
    }
    ({ cwd, trusted } = entry);
  }
  const agents = deps.backend.resources.discoverAgents({ cwd, trusted }).map((agent) => ({
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
      backend: {
        id: deps.backend.id,
        version: deps.backend.sdkVersion,
        capabilities: [...deps.backend.capabilities].toSorted(),
      },
    }),
  );
};

export const hostHandlers: ReadonlyMap<string, HostHandler> = new Map<string, HostHandler>(
  Object.entries({
    "thread/start": handleStart,
    "thread/resume": handleResume,
    "thread/register": handleRegister,
    "thread/stop": handleStop,
    "thread/retire": handleRetire,
    "thread/set_keepalive": handleSetKeepalive,
    set_idle_retire_ms: handleSetIdleRetireMs,
    "thread/list": handleList,
    "thread/list_saved": handleListSaved,
    get_models: handleGetModels,
    set_model: handleSetModel,
    set_model_override: (deps, cmd, id) =>
      handleSetModelOverride(
        {
          emit: deps.emit,
          modelRuntime: deps.backend.modelRuntime,
          modelsJsonPath: deps.backend.resources.modelsJsonPath,
        },
        cmd as SetModelOverrideCmd,
        id,
      ),
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
