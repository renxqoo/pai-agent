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
import { createTaskTool, type TaskToolDeps } from "../tools/task/subagent-tool.ts";
import { lineageSnapshot } from "../../sandbox/grants.ts";
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
  // v0.14: in-flight read face (streaming message + queue + turn boundary).
  "session.inflight",
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

/** Single-slot share window for one user action: a parked open fires
 * register + get_entries + get_state back-to-back on the same file, and the
 * same-mtime burst shares one parse. Cache residency is bounded by exactly
 * one file's entries and rotates on the next distinct read — no long-lived
 * per-session caches (v0.12 concurrency budget). */
const READ_HISTORY_SHARE_MS = 1_000;
let readHistoryShared: {
  path: string;
  mtimeMs: number;
  size: number;
  at: number;
  entries: ReturnType<typeof parseSessionEntries>;
} | null = null;

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
  // Fence errors are verdicts, but its realpath probes can race a deletion
  // (TOCTOU) and throw — that is the file being gone, i.e. not_found.
  let fenceError: string | undefined;
  try {
    fenceError = resumePathError(sessionPath);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (fenceError !== undefined) {
    return { ok: false, reason: "not_found" };
  }
  const resolved = resolvePath(sessionPath);
  let mtimeMs: number;
  let size: number;
  try {
    ({ mtimeMs, size } = statSync(resolved));
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (size > MAX_READ_HISTORY_BYTES) {
    return { ok: false, reason: "invalid_file" };
  }
  if (sharedParseHit(resolved, mtimeMs, size)) {
    return { ok: true, fileEntries: readHistoryShared?.entries ?? [] };
  }
  return parseAndShare(resolved, mtimeMs, size);
}

/** True when the single-slot share window still holds this exact file. */
function sharedParseHit(resolved: string, mtimeMs: number, size: number): boolean {
  const shared = readHistoryShared;
  return (
    shared !== null &&
    shared.path === resolved &&
    shared.mtimeMs === mtimeMs &&
    shared.size === size &&
    Date.now() - shared.at < READ_HISTORY_SHARE_MS
  );
}

function parseAndShare(resolved: string, mtimeMs: number, size: number): ReadHistoryResult {
  let entries;
  try {
    entries = parseSessionEntries(readFileSync(resolved, "utf8"));
  } catch {
    return { ok: false, reason: "invalid_file" };
  }
  // parseSessionEntries pushes any JSON value (a literal `null` line
  // included) without shape validation — guard before field access.
  const [header] = entries;
  if (
    header === undefined ||
    typeof header !== "object" ||
    header === null ||
    header.type !== "session" ||
    typeof (header as { id?: unknown }).id !== "string" ||
    (header.version ?? 1) < CURRENT_SESSION_VERSION
  ) {
    return { ok: false, reason: "invalid_file" };
  }
  readHistoryShared = { path: resolved, mtimeMs, size, at: Date.now(), entries };
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
  getLineage?: TaskToolDeps["getLineage"];
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
              ...(deps.getLineage !== undefined ? { getLineage: deps.getLineage } : {}),
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
        persistGrant: {
          persist: (grant) => {
            deps.emit({
              type: "sandbox_grant_persist",
              grant: { kind: grant.kind, value: grant.value },
            });
          },
        },
        createExtensions: builtinExtensions({
          emit: deps.emit,
          modelRuntime,
          subagents: deps.subagents,
          writeStderr: deps.writeStderr,
          getThreadId: () => sessions.threadId(),
          getLineage: () => {
            const controller = sessions.getSandboxState();
            return {
              posture: controller.snapshot.config.posture,
              ...lineageSnapshot(controller.grants),
            };
          },
        }),
      });
      return sessions;
    },
  };
}
