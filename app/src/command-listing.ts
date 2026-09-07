/**
 * get_commands listing: extension commands, prompt templates, and skills of
 * one session (autocomplete source for the UI).
 */

import type { Thread } from "./session-host.ts";

export interface SessionCommand {
  name: string;
  description?: string;
  source: string;
}

export function collectCommands(thread: Thread): SessionCommand[] {
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
  return collected;
}
