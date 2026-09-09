import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSandboxGate,
  snapshotSandboxConfig,
  type SandboxSnapshot,
} from "../src/backend/pi-coding-agent/sandbox-gate.ts";

/**
 * Sandbox gate unit tests (docs/plans/2026-09-09-sandbox.md §7): the inline
 * extension blocks write/edit/read policy violations via a minimal
 * ExtensionAPI capture harness; disabled snapshots mount an inert factory;
 * the snapshot builder honors PAI_SANDBOX and arms the implicit
 * policy-file denyWrite (review P6/P10).
 */

const PROJ = mkdtempSync(join(tmpdir(), "sbx-gate-"));

type ToolCallHandler = (event: {
  type: "tool_call";
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}) => Promise<{ block: boolean; reason: string } | undefined> | undefined;

function mountGate(snapshot: SandboxSnapshot, cwd = PROJ): ToolCallHandler[] {
  const handlers: ToolCallHandler[] = [];
  const pi = {
    on: (name: string, handler: ToolCallHandler) => {
      if (name === "tool_call") handlers.push(handler);
    },
    registerTool: () => {},
  };
  const state: SandboxGateState = { snapshot, runtime: { active: false } };
  createSandboxGate({ trusted: false, cwd, state, snapshot, writeStderr: () => {} })(pi as never);
  return handlers;
}

const enabledSnapshot = (): SandboxSnapshot =>
  snapshotSandboxConfig({ trusted: false, cwd: PROJ, env: { PAI_SANDBOX: "on" } });

const disabledSnapshot: SandboxSnapshot = snapshotSandboxConfig({
  trusted: false,
  cwd: PROJ,
  env: { PAI_SANDBOX: "off" },
});

describe("sandbox gate (write/edit/read hard checks)", () => {
  test("write inside cwd passes, outside is blocked with a named reason", async () => {
    const [handler] = mountGate(enabledSnapshot());
    const ok = await handler({
      type: "tool_call",
      toolName: "write",
      toolCallId: "t1",
      input: { path: join(PROJ, "src/a.ts"), content: "x" },
    });
    const blocked = await handler({
      type: "tool_call",
      toolName: "write",
      toolCallId: "t2",
      input: { path: "/etc/hosts", content: "x" },
    });
    expect(ok).toBeUndefined();
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("outside allowed paths");
  });

  test("edit denyWrite basename match is blocked", async () => {
    const [handler] = mountGate(enabledSnapshot());
    const blocked = await handler({
      type: "tool_call",
      toolName: "edit",
      toolCallId: "t3",
      input: { path: join(PROJ, ".env") },
    });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("denyWrite");
  });

  test("read denyRead match is blocked; ordinary reads pass", async () => {
    const [handler] = mountGate(enabledSnapshot());
    const denied = await handler({
      type: "tool_call",
      toolName: "read",
      toolCallId: "t4",
      input: { path: "~/.ssh/id_rsa" },
    });
    const fine = await handler({
      type: "tool_call",
      toolName: "read",
      toolCallId: "t5",
      input: { path: join(PROJ, "README.md") },
    });
    expect(denied?.block).toBe(true);
    expect(fine).toBeUndefined();
  });

  test("non-covered tools are untouched (bash is batch-2 scope)", async () => {
    const [handler] = mountGate(enabledSnapshot());
    const result = await handler({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "t6",
      input: { command: "curl https://evil.example" },
    });
    expect(result).toBeUndefined();
  });

  test("disabled snapshot mounts an inert factory (no handlers)", () => {
    expect(mountGate(disabledSnapshot).length).toBe(0);
  });

  test("relative and escaping tool paths resolve against the session cwd", async () => {
    const [handler] = mountGate(enabledSnapshot());
    // Enough ../ levels to clamp at / regardless of how deep tmpdir() is.
    const blocked = await handler({
      type: "tool_call",
      toolName: "write",
      toolCallId: "t7",
      input: { path: "../../../../../../../../../../etc/passwd", content: "x" },
    });
    expect(blocked?.block).toBe(true);
  });

  test("malformed input (missing input object) does not crash the handler", async () => {
    const [handler] = mountGate(enabledSnapshot());
    const result = await handler({
      type: "tool_call",
      toolName: "write",
      toolCallId: "t8",
      input: undefined as never,
    });
    // cwd itself is an allowed write root: passes through to the tool's own error.
    expect(result).toBeUndefined();
  });
});

describe("snapshot builder", () => {
  test("PAI_SANDBOX=off produces a disabled snapshot", () => {
    expect(disabledSnapshot.config.enabled).toBe(false);
    expect(mountGate(disabledSnapshot).length).toBe(0);
  });

  test("protected paths cover both policy files and stay OUT of the reported config (P6/P8)", () => {
    const snapshot = enabledSnapshot();
    const home = process.env.HOME ?? "";
    expect(snapshot.protectedPaths.some((entry) => entry.startsWith(`${home}/`))).toBe(true); // agentDir-side (getAgentDir default ~/.pi)
    expect(
      snapshot.protectedPaths.some((entry) => entry === join(PROJ, ".pi", "sandbox.json")),
    ).toBe(true);
    // Reported config stays pristine (no implementation-detail leakage).
    expect(snapshot.config.filesystem.denyWrite).toEqual([".env", ".env.*", "*.pem", "*.key"]);
  });

  test("grandchild parentProtectedPaths land in the snapshot (batch-2 P3)", () => {
    const parent = join("/parent/proj", ".pi", "sandbox.json");
    const snapshot = snapshotSandboxConfig({
      trusted: false,
      cwd: PROJ,
      env: { PAI_SANDBOX: "on" },
      parentProtectedPaths: [parent],
    });
    expect(snapshot.protectedPaths).toContain(parent);
  });

  test("default enabled snapshot is on with the documented defaults", () => {
    const snapshot = enabledSnapshot();
    expect(snapshot.config.enabled).toBe(true);
    expect(snapshot.config.filesystem.allowWrite).toEqual([".", "/tmp"]);
    expect(snapshot.source).toBe("global");
  });
});
