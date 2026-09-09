/**
 * get_commands listing: extension commands, prompt templates, skills, and
 * capability-gated builtin commands of one session (autocomplete source for
 * the UI).
 */

import type { CapabilityBit } from "./backend/capabilities.ts";
import type { PaiThread } from "./backend/ports/session.ts";

export interface SessionCommand {
  name: string;
  description?: string;
  source: string;
}

/** Hub-owned builtin commands (v0.11): descriptions mirror the SDK's
 * BUILTIN_SLASH_COMMANDS entries (the const is not re-exported from the
 * package root); names carry no leading slash, matching the other sources.
 * Each entry is gated on its capability bit — unsupported backends simply
 * do not list it. */
const BUILTIN_COMMANDS: ReadonlyArray<{
  name: string;
  description: string;
  capability: CapabilityBit;
}> = [
  {
    name: "compact",
    description: "Manually compact the session context",
    capability: "session.compact",
  },
];

export function collectCommands(
  thread: PaiThread,
  capabilities: ReadonlySet<CapabilityBit>,
): SessionCommand[] {
  const { session } = thread;
  const collected: SessionCommand[] = [];
  for (const command of session.extensionRunner.getRegisteredCommands()) {
    collected.push({
      name: command.invocationName,
      ...(command.description !== undefined ? { description: command.description } : {}),
      source: "extension",
    });
  }
  for (const template of session.promptTemplates) {
    collected.push({
      name: template.name,
      ...(template.description !== undefined ? { description: template.description } : {}),
      source: "prompt",
    });
  }
  for (const skill of session.resourceLoader.getSkills().skills) {
    collected.push({
      name: `skill:${skill.name}`,
      ...(skill.description !== undefined ? { description: skill.description } : {}),
      source: "skill",
    });
  }
  for (const builtin of BUILTIN_COMMANDS) {
    if (capabilities.has(builtin.capability)) {
      collected.push({ name: builtin.name, description: builtin.description, source: "builtin" });
    }
  }
  return collected;
}
