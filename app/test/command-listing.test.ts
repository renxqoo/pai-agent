import { describe, expect, test } from "bun:test";
import { collectCommands } from "../src/command-listing.ts";
import type { CapabilityBit } from "../src/backend/capabilities.ts";
import type { PaiThread } from "../src/backend/ports/session.ts";

/**
 * v0.11 get_commands fourth source (design.md 增补): the builtin `compact`
 * entry is capability-gated — listed only when the backend declares
 * session.compact (pi-coding-agent yes, pi-agent-core no). The three
 * session-sourced listings are unchanged.
 */

function makeThread(): PaiThread {
  return {
    cwd: "/tmp/proj",
    sessionPath: undefined,
    session: {
      extensionRunner: {
        getRegisteredCommands: () => [{ invocationName: "/ext-cmd", description: "ext desc" }],
        emitUserBash: async () => {},
      },
      promptTemplates: [{ name: "review", description: "template desc" }],
      resourceLoader: {
        getSkills: () => ({
          skills: [{ name: "deploy", description: "skill desc", filePath: "/s/deploy/SKILL.md" }],
        }),
      },
    },
  } as unknown as PaiThread;
}

describe("collectCommands builtin gating (v0.11)", () => {
  test("session.compact backend lists the builtin compact entry last", () => {
    const capabilities = new Set<CapabilityBit>(["session.compact"]);
    const commands = collectCommands(makeThread(), capabilities);
    expect(commands).toEqual([
      { name: "/ext-cmd", description: "ext desc", source: "extension" },
      { name: "review", description: "template desc", source: "prompt" },
      { name: "skill:deploy", description: "skill desc", source: "skill" },
      { name: "compact", description: "Manually compact the session context", source: "builtin" },
    ]);
  });

  test("backend without session.compact has no builtin entry (pi-agent-core shape)", () => {
    const commands = collectCommands(makeThread(), new Set<CapabilityBit>());
    expect(commands.map((c) => c.source)).toEqual(["extension", "prompt", "skill"]);
    expect(commands.some((c) => c.name === "compact")).toBe(false);
  });

  test("unrelated capability bits do not unlock the entry", () => {
    const capabilities = new Set<CapabilityBit>(["bash.exec", "dialogs"]);
    expect(collectCommands(makeThread(), capabilities).some((c) => c.source === "builtin")).toBe(
      false,
    );
  });
});
