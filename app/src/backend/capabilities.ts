/**
 * Capability negotiation tables (design.md v0.8; plan §1.4.2). Single truth
 * for: the closed capability-bit set, the core command set every backend
 * must implement, and the command → required-bits mapping for all 38
 * protocol commands. Commands absent from the mapping are core. Advisory
 * bits (image, dialogs, permission.soft, sandbox.fs, extensions.project,
 * resources.skills) describe enforcement depth rather than gating a command.
 */

export const CAPABILITY_BITS = [
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
] as const;

export type CapabilityBit = (typeof CAPABILITY_BITS)[number];

/** Commands every backend must implement (conformance rejects otherwise). */
export const CORE_COMMANDS: ReadonlySet<string> = new Set([
  "thread/start",
  "thread/stop",
  "thread/list",
  "prompt",
  "abort",
  "get_state",
  "get_commands",
  "get_host_info",
  "ui_response",
  "get_permission_rules",
  "set_permission_rules",
]);

/** Command → required capability bits (design.md v0.8 table mirror). */
export const COMMAND_CAPABILITIES: Readonly<Record<string, readonly CapabilityBit[]>> = {
  "thread/resume": ["session.resume"],
  "thread/list_saved": ["session.listSaved"],
  steer: ["steer"],
  follow_up: ["followUp"],
  clear_queue: ["queue.clear"],
  compact: ["session.compact"],
  get_messages: ["session.messages"],
  get_entries: ["session.entries"],
  get_tree: ["session.tree"],
  get_session_stats: ["session.stats"],
  set_session_name: ["session.name"],
  get_fork_messages: ["session.entries"],
  fork: ["session.fork"],
  clone: ["session.clone"],
  navigate_tree: ["session.navigate"],
  get_models: ["model.list"],
  set_model: ["session.model.set"],
  set_thinking_level: ["thinkingLevels"],
  get_thinking_levels: ["thinkingLevels"],
  "auth/list": ["model.auth"],
  "auth/set_api_key": ["model.auth"],
  "auth/remove_key": ["model.auth"],
  bash: ["bash.exec"],
  abort_bash: ["bash.exec"],
  "subagent/steer": ["subagents"],
  "agents/list": ["resources.agents"],
  get_sandbox_state: ["sandbox.bash"],
};

/**
 * The capability failure for a command on a backend, or undefined when the
 * backend supports it (core command or all required bits present). Error
 * text is the v0.8 contract shape (English, neutral).
 */
export function capabilityError(
  command: string,
  backendId: string,
  capabilities: ReadonlySet<CapabilityBit>,
): string | undefined {
  const required = COMMAND_CAPABILITIES[command];
  if (required === undefined) return undefined;
  for (const bit of required) {
    if (!capabilities.has(bit)) {
      return `Unsupported capability: ${bit} on backend ${backendId}`;
    }
  }
  return undefined;
}
