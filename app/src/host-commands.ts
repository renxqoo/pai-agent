/**
 * Host-local command handlers: the commands the host answers itself (thread
 * lifecycle routing, global listings, auth, ui_response ack). Everything
 * thread-scoped falls through to the worker pool via handlePassthrough.
 */

import { type ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  AuthListCmd,
  AuthRemoveKeyCmd,
  AuthSetApiKeyCmd,
  GetModelsCmd,
  HubCommand,
  HubFrame,
  SessionModel,
  SetModelCmd,
  ThreadListCmd,
  ThreadListSavedCmd,
  ThreadResumeCmd,
  ThreadStartCmd,
  ThreadStopCmd,
  UiResponseCmd,
} from "./protocol.ts";
import { THREAD_SCOPED_COMMANDS } from "./protocol.ts";
import { responseFailure, responseSuccess } from "./frames.ts";
import type { RegisterInflight } from "./inflight-registry.ts";
import { handleAuthList, handleAuthRemoveKey, handleAuthSetApiKey } from "./host-auth.ts";
import type { WorkerPool } from "./worker-pool.ts";

export interface HostDeps {
  pool: WorkerPool;
  modelRuntime: ModelRuntime;
  emit: (frame: HubFrame) => void;
  registerInflight: RegisterInflight;
}

export type HostHandler = (
  deps: HostDeps,
  cmd: HubCommand,
  id: string | undefined,
) => Promise<void>;

/** Model resolution is host-only (single source of truth; the host's
 * snapshot is always fresh, a spawned-earlier worker's is not). */
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

const handleResume: HostHandler = async (deps, cmd, _id) => {
  await deps.pool.resumeThread(cmd as ThreadResumeCmd);
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

/** Registry of commands the host answers itself; everything else either
 * routes to a worker (thread-scoped) or is an unknown command. */
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
