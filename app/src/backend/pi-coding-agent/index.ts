/**
 * The coding-agent backend bundle (capability-packs plan §1.3): full
 * capability set. Host side wraps ModelRuntime + the auth trio + resource
 * conventions (sessions-dir fence, v3 listing, agent discovery); worker side
 * wires SessionHost + UI context + the built-in extensions (task tool /
 * grandchild communication) exactly as the previous inline assembly did.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join as joinPath, resolve as resolvePath } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  ModelRuntime,
  SessionManager,
  VERSION,
  getAgentDir,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import type { CapabilityBit } from "../capabilities.ts";
import type { ReadHistoryResult } from "../ports/resources.ts";
import type { HostBackend, WorkerBackend, WorkerSessionDeps } from "../ports/backend.ts";
import { SessionHost } from "./session-adapter.ts";
import { createTaskTool } from "../tools/task/subagent-tool.ts";
import { createSubagentCommunicationExtension } from "../tools/task/subagent-communication.ts";
import { startGrandchildTask } from "./subagent-process.ts";
import { checkPermission } from "./permission-gate.ts";
import { rulesPath } from "./permission-gate.ts";
import { discoverAgents } from "./agent-definitions.ts";
import { handleAuthList, handleAuthRemoveKey, handleAuthSetApiKey } from "./host-auth.ts";
import { modelsJsonPath } from "./models-path.ts";
import { createUiContext } from "./ui-context.ts";

/** The full capability set: every bit (sandbox degradation stays visible
 * through get_sandbox_state, matching the v0.7 fail-open contract). */
const FULL_CAPABILITIES: ReadonlySet<CapabilityBit> = new Set<CapabilityBit>([
  "session.fork",
  "session.clone",
  "session.tree",
  "session.navigate",
  "session.compact",
  "session.entries",
  "session.messages",
  "session.stats",
  "session.name",
  "session.resume",
  "session.listSaved",
  "session.model.set",
  "thinkingLevels",
  "steer",
  "followUp",
  "queue.clear",
  "bash.exec",
  "dialogs",
  "permission.soft",
  "sandbox.bash",
  "sandbox.fs",
  "subagents",
  "model.auth",
  "model.list",
  "model.config",
  "image",
  "extensions.project",
  "resources.agents",
  "resources.skills",
]);

/**
 * thread/resume admission (moved from host-commands; coding-agent sessions
 * semantics): absolute, lexically and physically inside the agent's own
 * sessions directory (no probing differential), and actually present.
 */
export function resumePathError(sessionPath: string): string | undefined {
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

/** Direct-read size ceiling: a session file beyond this is handed to the
 * wake path instead of blocking the host loop with a giant synchronous
 * parse (the hub's own 16 MiB line-limit discipline applies to the wire,
 * not to files it did not write this second). */
const MAX_READ_HISTORY_BYTES = 64 * 1024 * 1024;

/** Parked read history (v0.12): the same admission fence as thread/resume,
 * then a side-effect-free parse (parseSessionEntries skips malformed lines;
 * unlike SessionManager.open/loadEntriesFromFile it never migrates or
 * repairs the file — a pre-v3 file is therefore invalid here and falls
 * back to the wake path, whose open() performs the migration rewrite).
 * An empty, header-less, oversized, or legacy file is invalid — the host
 * falls back to the wake path, which owns the failure wording. */
export function readHistory(sessionPath: string): Promise<ReadHistoryResult> {
  return Promise.resolve(readHistorySync(sessionPath));
}

function readHistorySync(sessionPath: string): ReadHistoryResult {
  if (resumePathError(sessionPath) !== undefined) {
    return { ok: false, reason: "not_found" };
  }
  const resolved = resolvePath(sessionPath);
  try {
    if (statSync(resolved).size > MAX_READ_HISTORY_BYTES) {
      return { ok: false, reason: "invalid_file" };
    }
  } catch {
    return { ok: false, reason: "not_found" };
  }
  let entries;
  try {
    entries = parseSessionEntries(readFileSync(resolved, "utf8"));
  } catch {
    return { ok: false, reason: "invalid_file" };
  }
  const [header] = entries;
  if (
    header === undefined ||
    header.type !== "session" ||
    typeof (header as { id?: unknown }).id !== "string" ||
    (header.version ?? 1) < CURRENT_SESSION_VERSION
  ) {
    return { ok: false, reason: "invalid_file" };
  }
  return { ok: true, fileEntries: entries };
}

export async function createCodingAgentHostBackend(): Promise<HostBackend> {
  const modelRuntime = await ModelRuntime.create({ modelsPath: modelsJsonPath() });
  return {
    id: "pi-coding-agent",
    capabilities: FULL_CAPABILITIES,
    sdkVersion: VERSION,
    modelRuntime,
    auth: {
      list: (deps, cmd, id) =>
        handleAuthList(
          { modelRuntime, emit: deps.emit, registerInflight: deps.registerInflight },
          cmd,
          id,
        ),
      setApiKey: (deps, cmd, id) =>
        handleAuthSetApiKey(
          { modelRuntime, emit: deps.emit, registerInflight: deps.registerInflight },
          cmd,
          id,
        ),
      removeKey: (deps, cmd, id) =>
        handleAuthRemoveKey(
          { modelRuntime, emit: deps.emit, registerInflight: deps.registerInflight },
          cmd,
          id,
        ),
    },
    resources: {
      agentDir: () => getAgentDir(),
      modelsJsonPath,
      rulesPath,
      resumePathError,
      listSaved: async (cwd) => ({ sessions: await SessionManager.list(cwd) }),
      readHistory,
      discoverAgents,
    },
  };
}

/** Built-in extensions (moved from worker.ts): normal conversations get the
 * task tool; grandchild spawns (depth 1) get the communication tools. */
function builtinExtensions(deps: {
  emit: WorkerSessionDeps["emit"];
  modelRuntime: ModelRuntime;
  subagents: WorkerSessionDeps["subagents"];
  writeStderr: (text: string) => void;
  getThreadId: () => string;
}) {
  return (spawn: {
    trusted: boolean;
    subagent: boolean;
    subagentId?: string;
    agentName?: string;
  }) =>
    spawn.subagent
      ? [
          createSubagentCommunicationExtension({
            emit: (frame) => deps.emit(frame),
            getThreadId: deps.getThreadId,
            subagentId: spawn.subagentId ?? "",
            agentName: spawn.agentName ?? "",
          }),
        ]
      : [
          createTaskTool(
            {
              emit: deps.emit,
              modelRuntime: deps.modelRuntime,
              registry: deps.subagents,
              writeStderr: deps.writeStderr,
              getThreadId: deps.getThreadId,
            },
            spawn.trusted,
          ),
        ];
}

export function createCodingAgentWorkerBackend(): WorkerBackend {
  return {
    id: "pi-coding-agent",
    capabilities: FULL_CAPABILITIES,
    startTask: startGrandchildTask,
    checkPermission,
    async createSessionHost(deps: WorkerSessionDeps) {
      const modelRuntime = await ModelRuntime.create();
      const sessions = new SessionHost({
        modelRuntime,
        emit: deps.emit,
        createUi: (threadId) => createUiContext(threadId, deps.broker, deps.emit),
        onThreadDisposed: (threadId) => deps.broker.settleThread(threadId),
        writeStderr: deps.writeStderr,
        createExtensions: builtinExtensions({
          emit: deps.emit,
          modelRuntime,
          subagents: deps.subagents,
          writeStderr: deps.writeStderr,
          getThreadId: () => sessions.threadId(),
        }),
      });
      return sessions;
    },
  };
}
