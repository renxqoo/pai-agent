import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSidecarRules,
  copySidecarRules,
  isSafeThreadId,
  readSidecarRules,
  writeSidecarRules,
} from "../src/sidecar-rules.ts";

/**
 * Hermetic agent dir: sidecar paths follow PI_CODING_AGENT_DIR, so the tests
 * set it before any path is built and must never touch the real ~/.pi.
 */
const agentDir = mkdtempSync(join(tmpdir(), "pai-cli-sidecar-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const ID = "11111111-2222-3333-4444-555555555555";

function sidecarFiles(): string[] {
  const dir = join(agentDir, "permission-rules");
  return existsSync(dir) ? readdirSync(dir).toSorted() : [];
}

describe("isSafeThreadId (path-traversal guard, plan §2.1)", () => {
  test("uuid-style and slug ids accepted", () => {
    expect(isSafeThreadId(ID)).toBe(true);
    expect(isSafeThreadId("abc")).toBe(true);
    expect(isSafeThreadId("a-b_C9")).toBe(true);
  });
  test("traversal and path separators rejected", () => {
    expect(isSafeThreadId("../evil")).toBe(false);
    expect(isSafeThreadId("a/b")).toBe(false);
    expect(isSafeThreadId("a\\b")).toBe(false);
    expect(isSafeThreadId(".hidden")).toBe(false);
    expect(isSafeThreadId("..")).toBe(false);
  });
  test("empty and over-length rejected", () => {
    expect(isSafeThreadId("")).toBe(false);
    expect(isSafeThreadId("a".repeat(129))).toBe(false);
    expect(isSafeThreadId("a".repeat(128))).toBe(true);
  });
});

describe("sidecar read/write/clear", () => {
  test("write creates the file inside the agent dir and reads back", () => {
    const path = writeSidecarRules(ID, { mode: "block-all", bash: { allowPatterns: ["echo *"] } });
    expect(path).toBe(join(agentDir, "permission-rules", `${ID}.json`));
    expect(readSidecarRules(ID)).toEqual({
      mode: "block-all",
      bash: { allowPatterns: ["echo *"] },
    });
  });

  test("re-write replaces atomically (no tmp leftovers)", () => {
    writeSidecarRules(ID, { mode: "ask" });
    expect(sidecarFiles()).toEqual([`${ID}.json`]);
    expect(readSidecarRules(ID)).toEqual({ mode: "ask" });
  });

  test("missing sidecar reads as undefined", () => {
    expect(readSidecarRules("no-such-thread-id")).toBeUndefined();
  });

  test("unsafe id: write throws, read/clear are no-ops, no file escapes the dir", () => {
    expect(() => writeSidecarRules("../evil", { mode: "ask" })).toThrow(/Invalid threadId/);
    expect(readSidecarRules("../evil")).toBeUndefined();
    expect(clearSidecarRules("../evil")).toBe(false);
    expect(existsSync(join(agentDir, "evil.json"))).toBe(false);
  });

  test("corrupt sidecar degrades to defaults on read (tolerant path)", () => {
    mkdirSync(join(agentDir, "permission-rules"), { recursive: true });
    writeFileSync(join(agentDir, "permission-rules", "corrupt-id.json"), "not json");
    expect(readSidecarRules("corrupt-id")).toEqual({ mode: "ask" });
  });

  test("clear removes and is idempotent", () => {
    writeSidecarRules("clearable-id", { mode: "ask" });
    expect(clearSidecarRules("clearable-id")).toBe(true);
    expect(clearSidecarRules("clearable-id")).toBe(false);
    expect(readSidecarRules("clearable-id")).toBeUndefined();
  });
});

describe("copySidecarRules (session replacement)", () => {
  test("copies content to the new id and leaves the source untouched", () => {
    const rules = { mode: "block-all" };
    writeSidecarRules("fork-src", rules);
    copySidecarRules("fork-src", "fork-dst");
    expect(readSidecarRules("fork-src")).toEqual(rules);
    expect(readSidecarRules("fork-dst")).toEqual(rules);
  });

  test("no-op when the source has no sidecar", () => {
    copySidecarRules("never-written", "fork-dst-2");
    expect(readSidecarRules("fork-dst-2")).toBeUndefined();
  });

  test("unsafe source id is a read-side no-op", () => {
    copySidecarRules("../evil", "fork-dst-3");
    expect(existsSync(join(agentDir, "evil.json"))).toBe(false);
    expect(readSidecarRules("fork-dst-3")).toBeUndefined();
  });

  test("unsafe target id degrades to false instead of throwing", () => {
    writeSidecarRules("fork-src-2", { mode: "ask" });
    expect(copySidecarRules("fork-src-2", "../evil")).toBe(false);
    expect(existsSync(join(agentDir, "evil.json"))).toBe(false);
  });
});
