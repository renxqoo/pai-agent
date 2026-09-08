/**
 * The coding-agent backend bundle (capability-packs plan §1.3): full
 * capability set. Host side wraps ModelRuntime + the auth trio + resource
 * conventions (sessions-dir fence, v3 listing, agent discovery); worker side
 * wires SessionHost + UI context + the built-in extensions (task tool /
 * grandchild communication) exactly as the previous inline assembly did.
 */

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join as joinPath, resolve as resolvePath } from "node:path";
import {
  ModelRuntime,
  SessionManager,
  VERSION,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { CapabilityBit } from "../capabilities.ts";
import type { HostBackend, WorkerBackend, WorkerSessionDeps } from "../ports/backend.ts";
import { SessionHost } from "./session-adapter.ts";
import { createTaskTool } from "./subagent-tool.ts";
import { createSubagentCommunicationExtension } from "./subagent-communication.ts";
import { startGrandchildTask } from "./subagent-process.ts";
import { checkPermission } from "./permission-gate.ts";
import { rulesPath } from "./permission-gate.ts";
import { discoverAgents } from "./agent-definitions.ts";
import { handleAuthList, handleAuthRemoveKey, handleAuthSetApiKey } from "./host-auth.ts";
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

export async function createCodingAgentHostBackend(): Promise<HostBackend> {
  const modelRuntime = await ModelRuntime.create();
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
      rulesPath,
      resumePathError,
      listSaved: async (cwd) => ({ sessions: await SessionManager.list(cwd) }),
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
