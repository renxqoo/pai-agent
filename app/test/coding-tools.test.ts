import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodingToolset } from "../src/backend/tools/coding/index.ts";
import {
  createToolPermissionGate,
  type ToolPermissionGate,
} from "../src/backend/tools/coding/permission-gate.ts";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";

function callContext(toolName: string, args: Record<string, unknown>): BeforeToolCallContext {
  return {
    assistantMessage: {
      role: "assistant",
      content: [],
    } as BeforeToolCallContext["assistantMessage"],
    toolCall: { id: "tc1", name: toolName } as BeforeToolCallContext["toolCall"],
    args,
    context: { systemPrompt: "", messages: [] } as BeforeToolCallContext["context"],
  };
}

function makeGate(rulesFile: { mode: string }, askResult: () => Promise<boolean>) {
  const dir = mkdtempSync(join(tmpdir(), "pai-gate-"));
  const rulesPath = join(dir, "permission-rules.json");
  writeFileSync(rulesPath, JSON.stringify(rulesFile));
  const gate: ToolPermissionGate = createToolPermissionGate({
    threadId: () => "gate-test",
    rulesPath,
    ask: async () => askResult(),
  });
  return { gate, dir };
}

describe("tool permission gate (probe coding tools)", () => {
  test("allow-all short-circuits: no ask, no block", async () => {
    let asked = 0;
    const { gate } = makeGate({ mode: "allow-all" }, async () => {
      asked += 1;
      return true;
    });
    const result = await gate(callContext("bash", { command: "rm -rf /" }));
    expect(result).toBeUndefined();
    expect(asked).toBe(0);
  });

  test("block-all blocks with the neutral reason; read is ungated", async () => {
    const { gate } = makeGate({ mode: "block-all" }, async () => true);
    const blocked = await gate(callContext("bash", { command: "echo hi" }));
    expect(blocked?.block).toBeTrue();
    expect(blocked?.reason).toContain("Blocked by permission rules");
    const writeBlocked = await gate(callContext("write", { path: "x.txt", content: "y" }));
    expect(writeBlocked?.block).toBeTrue();
    const readPasses = await gate(callContext("read", { path: "x.txt" }));
    expect(readPasses).toBeUndefined();
  });

  test("ask mode: confirmed allows, denied blocks with the user reason", async () => {
    let answer = true;
    const { gate } = makeGate({ mode: "ask" }, async () => answer);
    expect(await gate(callContext("bash", { command: "git status" }))).toBeUndefined();
    answer = false;
    const denied = await gate(callContext("bash", { command: "git status" }));
    expect(denied?.block).toBeTrue();
    expect(denied?.reason).toBe("Denied by user");
  });

  test("non-gated tools and malformed args pass through ungated", async () => {
    const { gate } = makeGate({ mode: "block-all" }, async () => true);
    expect(await gate(callContext("task", { agent: "x" }))).toBeUndefined();
    expect(await gate(callContext("bash", {}))).toBeUndefined();
  });
});

describe("coding toolset shim (harness tools on the bare Agent face)", () => {
  test("write tool creates the file under the conversation cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pai-coding-"));
    const toolset = createCodingToolset({ cwd });
    const write = toolset.tools.find((tool) => tool.name === "write");
    if (write === undefined) throw new Error("write tool missing");
    const result = await write.execute("t1", {
      path: "probe.txt",
      content: "hello from the shim",
    } as never);
    const text = result.content.find((block) => block.type === "text");
    expect(String(text?.type === "text" ? text.text : "")).toContain("Successfully wrote");
    expect(readFileSync(join(cwd, "probe.txt"), "utf8")).toBe("hello from the shim");
  });

  test("bash tool executes through the node env", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pai-coding-"));
    const toolset = createCodingToolset({ cwd });
    const bash = toolset.tools.find((tool) => tool.name === "bash");
    if (bash === undefined) throw new Error("bash tool missing");
    const result = await bash.execute("t2", { command: "echo shim-ok" } as never);
    const text = result.content.find((block) => block.type === "text");
    expect(String(text?.type === "text" ? text.text : "")).toContain("shim-ok");
  });

  test("the four coding tools are present with the gate wired", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pai-coding-"));
    const dir = mkdtempSync(join(tmpdir(), "pai-gate-"));
    const rulesPath = join(dir, "permission-rules.json");
    writeFileSync(rulesPath, JSON.stringify({ mode: "allow-all" }));
    const toolset = createCodingToolset({
      cwd,
      gate: createToolPermissionGate({ threadId: () => "t", rulesPath, ask: async () => false }),
    });
    expect(toolset.tools.map((tool) => tool.name).toSorted()).toEqual([
      "bash",
      "edit",
      "read",
      "write",
    ]);
    expect(toolset.beforeToolCall).toBeDefined();
    expect(existsSync(cwd)).toBeTrue();
  });
});
