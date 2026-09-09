import { describe, expect, test } from "bun:test";
import { toSkillPointer } from "../src/skill-pointer.ts";

// description is present on some entries to prove it is ignored by the rewrite.
const skills = [
  { name: "deploy", description: "Ship the app", filePath: "/skills/deploy/SKILL.md" },
  { name: "quiet", filePath: "/skills/quiet/SKILL.md" },
];

describe("toSkillPointer", () => {
  test("rewrites bare invocation to a name-only pointer line", () => {
    expect(toSkillPointer("/skill:deploy", skills)).toBe("[deploy](url:/skills/deploy/SKILL.md)");
  });
  test("keeps trailing args after a blank line", () => {
    expect(toSkillPointer("/skill:deploy ship it now", skills)).toBe(
      "[deploy](url:/skills/deploy/SKILL.md)\n\nship it now",
    );
  });
  test("unknown skill passes through unchanged", () => {
    expect(toSkillPointer("/skill:nosuch", skills)).toBe("/skill:nosuch");
  });
  test("description is never inlined", () => {
    expect(toSkillPointer("/skill:quiet", skills)).toBe("[quiet](url:/skills/quiet/SKILL.md)");
  });
  test("non-skill input passes through unchanged", () => {
    expect(toSkillPointer("plain text", skills)).toBe("plain text");
    expect(toSkillPointer("/skill deploy", skills)).toBe("/skill deploy");
    expect(toSkillPointer("/template:review", skills)).toBe("/template:review");
  });
  test("name must match exactly", () => {
    expect(toSkillPointer("/skill:dep", skills)).toBe("/skill:dep");
  });
});
