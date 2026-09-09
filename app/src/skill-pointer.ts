/**
 * Hub-side /skill: invocation rewrite (design.md v0.8「skill 调用指针化」):
 * pai rewrites `/skill:name [args]` into a compact pointer line before handing
 * the message to the worker, so the session never stores or ships the full
 * SKILL.md body — the model loads the file itself with its read/bash tools.
 * The rewritten text no longer starts with "/skill:", which is what makes the
 * worker's own full-body expansion step pass it through untouched.
 *
 * The line carries name and location only; descriptions are not inlined —
 * the system prompt's available_skills listing and the app's skill list
 * already carry them. Unknown skill names pass through unchanged: the
 * worker's built-in expansion remains the fallback.
 */

export interface SkillPointerSource {
  name: string;
  filePath: string;
}

export function toSkillPointer(message: string, skills: ReadonlyArray<SkillPointerSource>): string {
  if (!message.startsWith("/skill:")) return message;
  const spaceIndex = message.indexOf(" ");
  const name = spaceIndex === -1 ? message.slice(7) : message.slice(7, spaceIndex);
  const skill = skills.find((s) => s.name === name);
  if (!skill) return message;
  const args = spaceIndex === -1 ? "" : message.slice(spaceIndex + 1).trim();
  const pointer = `[${skill.name}](url:${skill.filePath})`;
  return args.length > 0 ? `${pointer}\n\n${args}` : pointer;
}
