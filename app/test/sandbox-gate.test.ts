import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SANDBOX_CHOICE_DENY,
  SANDBOX_CHOICE_ONCE,
  SANDBOX_CHOICE_SESSION,
  SANDBOX_DIALOG_TIMEOUT_MS,
  type SandboxGateState,
  type SandboxSnapshot,
  WRITE_EXEMPTION_CAP,
  createSandboxGate,
  snapshotSandboxConfig,
} from "../src/backend/pi-coding-agent/sandbox-gate.ts";

/**
 * Sandbox gate unit tests (docs/plans/2026-09-09-sandbox.md §7, escalation
 * flow §二 of docs/plans/2026-09-10-sandbox-escalation.md): the inline
 * extension blocks write/edit/read policy violations via a minimal
 * ExtensionAPI capture harness; disabled snapshots mount an inert factory;
 * the snapshot builder honors PAI_SANDBOX and arms the implicit
 * policy-file denyWrite (review P6/P10). v0.10: confirmable violations
 * escalate to a three-way select dialog (Allow once / session / Deny) with
 * session exemptions, fail-closed without UI and for subagents; hard floors
 * (protected paths incl. symlinked cwd, denyRead roots) never dialog.
 */

// Hermetic: never read the developer's real agent dir (getAgentDir reads
// PI_CODING_AGENT_DIR per call).
const agentDir = mkdtempSync(join(tmpdir(), "sbx-gate-agent-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const PROJ = mkdtempSync(join(tmpdir(), "sbx-gate-"));
const PROJ_REAL = realpathSync(PROJ);
const AGENT_DIR_REAL = realpathSync(agentDir);

interface ToolCallCtx {
  hasUI: boolean;
  signal?: AbortSignal;
  ui: { select: (title: string, options: string[], opts?: unknown) => Promise<string | undefined> };
}

type ToolCallHandler = (
  event: {
    type: "tool_call";
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown>;
  },
  ctx?: ToolCallCtx,
) => Promise<{ block: boolean; reason: string } | undefined>;

function mountGate(
  snapshot: SandboxSnapshot,
  cwd = PROJ,
  deps: { subagent?: boolean } = {},
): ToolCallHandler[] {
  return mountGateWithState(snapshot, cwd, deps).handlers;
}

/** Same as mountGate but exposes the session state for exemption asserts. */
function mountGateWithState(
  snapshot: SandboxSnapshot,
  cwd = PROJ,
  deps: { subagent?: boolean } = {},
): { handlers: ToolCallHandler[]; state: SandboxGateState } {
  const handlers: ToolCallHandler[] = [];
  const pi = {
    on: (name: string, handler: ToolCallHandler) => {
      if (name === "tool_call") handlers.push(handler);
    },
    registerTool: () => {},
  };
  const state: SandboxGateState = {
    snapshot,
    runtime: { active: false },
    exemptions: { writePaths: new Set(), bashCommands: new Set() },
  };
  createSandboxGate({
    trusted: false,
    cwd,
    state,
    snapshot,
    writeStderr: () => {},
    ...(deps.subagent === true ? { subagent: true } : {}),
  })(pi as never);
  return { handlers, state };
}

/** Dialog double: records every ask (incl. opts), answers from a script
 * (default Deny). */
function uiCtx(script: (string | undefined)[] = []) {
  const asked: { title: string; options: string[]; opts: unknown }[] = [];
  let calls = 0;
  const ctx: ToolCallCtx = {
    hasUI: true,
    ui: {
      select: async (title, options, opts) => {
        asked.push({ title, options, opts });
        return script[calls++] ?? SANDBOX_CHOICE_DENY;
      },
    },
  };
  return { ctx, asked };
}

const enabledSnapshot = (onViolation: "ask" | "deny" = "ask"): SandboxSnapshot => {
  const snapshot = snapshotSandboxConfig({ trusted: false, cwd: PROJ, env: { PAI_SANDBOX: "on" } });
  return onViolation === "deny"
    ? { ...snapshot, config: { ...snapshot.config, onViolation: "deny" } }
    : snapshot;
};

const disabledSnapshot: SandboxSnapshot = snapshotSandboxConfig({
  trusted: false,
  cwd: PROJ,
  env: { PAI_SANDBOX: "off" },
});

const writeEvent = (path: string, toolCallId = "t"): Parameters<ToolCallHandler>[0] => ({
  type: "tool_call",
  toolName: "write",
  toolCallId,
  input: { path, content: "x" },
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

describe("sandbox gate (v0.10 confirm escalation, write/edit)", () => {
  const OUTSIDE = "/etc/pai-sandbox-test.txt";

  test("Allow once passes the call and does not mint an exemption", async () => {
    const [handler] = mountGate(enabledSnapshot());
    const { ctx, asked } = uiCtx([SANDBOX_CHOICE_ONCE, SANDBOX_CHOICE_ONCE]);
    expect(await handler(writeEvent(OUTSIDE, "t1"), ctx)).toBeUndefined();
    expect(asked.length).toBe(1);
    expect(asked[0]?.title).toContain(OUTSIDE);
    expect(asked[0]?.options).toEqual([
      SANDBOX_CHOICE_ONCE,
      SANDBOX_CHOICE_SESSION,
      SANDBOX_CHOICE_DENY,
    ]);
    // Second write to the same path asks again (once ≠ exemption).
    expect(await handler(writeEvent(OUTSIDE, "t2"), ctx)).toBeUndefined();
    expect(asked.length).toBe(2);
  });

  test("Allow for this session mints an exemption: the same path never asks again", async () => {
    const [handler] = mountGate(enabledSnapshot());
    const { ctx, asked } = uiCtx([SANDBOX_CHOICE_SESSION]);
    expect(await handler(writeEvent(OUTSIDE, "t1"), ctx)).toBeUndefined();
    expect(await handler(writeEvent(OUTSIDE, "t2"), ctx)).toBeUndefined();
    expect(asked.length).toBe(1);
  });

  test("Deny keeps the v0.7 block with the same reason string", async () => {
    const [handler] = mountGate(enabledSnapshot());
    const { ctx } = uiCtx([SANDBOX_CHOICE_DENY]);
    const blocked = await handler(writeEvent(OUTSIDE), ctx);
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("outside allowed paths");
  });

  test("timeout / cancel / unknown select value all settle as Deny (fail-closed)", async () => {
    for (const answer of [undefined, "nonsense", ""]) {
      const [handler] = mountGate(enabledSnapshot());
      const { ctx } = uiCtx([answer]);
      const blocked = await handler(writeEvent(OUTSIDE), ctx);
      expect(blocked?.block).toBe(true);
    }
  });

  test("onViolation deny and missing-UI ctx stay hard-blocked without a dialog", async () => {
    const [denyHandler] = mountGate(enabledSnapshot("deny"));
    const { ctx: denyCtx } = uiCtx([SANDBOX_CHOICE_ONCE]);
    expect((await denyHandler(writeEvent(OUTSIDE), denyCtx))?.block).toBe(true);

    const [askHandler] = mountGate(enabledSnapshot());
    const { ctx, asked } = uiCtx([SANDBOX_CHOICE_ONCE]);
    expect(((await askHandler(writeEvent(OUTSIDE))) as { block: boolean } | undefined)?.block).toBe(
      true,
    );
    expect((await askHandler(writeEvent(OUTSIDE), { hasUI: false, ui: ctx.ui }))?.block).toBe(true);
    expect(asked.length).toBe(0);
  });

  test("subagent spawns never escalate (no dialog even with UI)", async () => {
    const [handler] = mountGate(enabledSnapshot(), PROJ, { subagent: true });
    const { ctx, asked } = uiCtx([SANDBOX_CHOICE_ONCE]);
    const blocked = await handler(writeEvent(OUTSIDE), ctx);
    expect(blocked?.block).toBe(true);
    expect(asked.length).toBe(0);
  });

  test("protected policy-file targets are never confirmable", async () => {
    const snapshot = enabledSnapshot();
    const protectedTarget = snapshot.protectedPaths[0] ?? "";
    expect(protectedTarget.length).toBeGreaterThan(0);
    const [handler] = mountGate(snapshot);
    const { ctx, asked } = uiCtx([SANDBOX_CHOICE_SESSION]);
    const blocked = await handler(writeEvent(protectedTarget), ctx);
    expect(blocked?.block).toBe(true);
    expect(asked.length).toBe(0);
  });

  test("denyWrite (non-protected) is confirmable; denyRead stays hard-blocked", async () => {
    const [handler] = mountGate(enabledSnapshot());
    const { ctx, asked } = uiCtx([SANDBOX_CHOICE_ONCE]);
    // .env inside cwd: deny-write kind, confirmable.
    expect(await handler(writeEvent(join(PROJ, ".env")), ctx)).toBeUndefined();
    expect(asked[0]?.title).toContain(".env");
    // read of ~/.ssh: denyRead, never confirmable.
    const denied = await handler(
      { type: "tool_call", toolName: "read", toolCallId: "tr", input: { path: "~/.ssh/id_rsa" } },
      ctx,
    );
    expect(denied?.block).toBe(true);
    expect(asked.length).toBe(1);
  });

  test("exemption cap: session grants keep allowing but the set clamps at the cap", async () => {
    const { handlers, state } = mountGateWithState(enabledSnapshot());
    const [handler] = handlers;
    const { ctx } = uiCtx(
      Array.from({ length: WRITE_EXEMPTION_CAP + 2 }, () => SANDBOX_CHOICE_SESSION),
    );
    for (let i = 0; i < WRITE_EXEMPTION_CAP + 2; i += 1) {
      expect(await handler(writeEvent(`/etc/cap-${i}`), ctx)).toBeUndefined();
    }
    expect(state.exemptions.writePaths.size).toBe(WRITE_EXEMPTION_CAP);
  });

  test("dialog opts carry the 300s timeout and the turn abort signal", async () => {
    const [handler] = mountGate(enabledSnapshot());
    const controller = new AbortController();
    const { ctx, asked } = uiCtx([SANDBOX_CHOICE_DENY]);
    (ctx as ToolCallCtx & { signal?: AbortSignal }).signal = controller.signal;
    await handler(writeEvent(OUTSIDE), ctx);
    const opts = asked[0]?.opts as { timeout?: number; signal?: AbortSignal };
    expect(opts.timeout).toBe(SANDBOX_DIALOG_TIMEOUT_MS);
    expect(opts.signal).toBe(controller.signal);
  });

  test("a throwing dialog channel settles fail-closed (blocked, v0.7 reason)", async () => {
    const [handler] = mountGate(enabledSnapshot());
    const ctx: ToolCallCtx = {
      hasUI: true,
      ui: {
        select: () => {
          throw new Error("dialog broker exploded");
        },
      },
    };
    const blocked = await handler(writeEvent(OUTSIDE), ctx);
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("outside allowed paths");
  });

  test("denied once keeps blocking with the same reason (no exemption side effects)", async () => {
    const { handlers, state } = mountGateWithState(enabledSnapshot());
    const [handler] = handlers;
    const { ctx } = uiCtx([SANDBOX_CHOICE_DENY]);
    expect((await handler(writeEvent(OUTSIDE), ctx))?.block).toBe(true);
    expect(state.exemptions.writePaths.size).toBe(0);
  });

  test("snapshot rebuild clears session exemptions (fork/clone lifecycle)", async () => {
    const { handlers, state } = mountGateWithState(enabledSnapshot());
    const [handler] = handlers;
    const { ctx } = uiCtx([SANDBOX_CHOICE_SESSION]);
    expect(await handler(writeEvent(OUTSIDE), ctx)).toBeUndefined();
    expect(state.exemptions.writePaths.size).toBe(1);
    // Re-run the gate factory on the same state (fork/clone/rebind path):
    // fresh snapshot ⇒ fresh exemptions.
    createSandboxGate({
      trusted: false,
      cwd: PROJ,
      state,
      snapshot: enabledSnapshot(),
      writeStderr: () => {},
    })({ on: () => {}, registerTool: () => {} } as never);
    expect(state.exemptions.writePaths.size).toBe(0);
  });

  test("write into a denyRead root is hard-blocked even with UI (escalation review P2)", async () => {
    const [handler] = mountGate(enabledSnapshot());
    const { ctx, asked } = uiCtx([SANDBOX_CHOICE_ONCE]);
    const blocked = await handler(writeEvent("~/.ssh/authorized_keys"), ctx);
    expect(blocked?.block).toBe(true);
    expect(asked.length).toBe(0); // credential trees never enter the click-to-allow flow
  });
});

describe("snapshot builder", () => {
  test("PAI_SANDBOX=off produces a disabled snapshot", () => {
    expect(disabledSnapshot.config.enabled).toBe(false);
    expect(mountGate(disabledSnapshot).length).toBe(0);
  });

  test("protected paths cover both policy files and stay OUT of the reported config (P6/P8)", () => {
    const snapshot = enabledSnapshot();
    expect(snapshot.protectedPaths.some((entry) => entry.startsWith(`${AGENT_DIR_REAL}/`))).toBe(
      true,
    );
    expect(
      snapshot.protectedPaths.some((entry) => entry === join(PROJ_REAL, ".pi", "sandbox.json")),
    ).toBe(true);
    // Reported config stays pristine (no implementation-detail leakage).
    expect(snapshot.config.filesystem.denyWrite).toEqual([".env", ".env.*", "*.pem", "*.key"]);
  });

  test("protected paths are EFFECT-SPACE resolved — a symlinked cwd keeps the policy file un-confirmable (review P1)", async () => {
    const link = join(PROJ_REAL, "..", `sbx-gate-link-${Date.now()}`);
    symlinkSync(PROJ, link);
    try {
      const snapshot = snapshotSandboxConfig({
        trusted: false,
        cwd: link,
        env: { PAI_SANDBOX: "on" },
      });
      expect(
        snapshot.protectedPaths.some((entry) => entry === join(PROJ_REAL, ".pi", "sandbox.json")),
      ).toBe(true);
      // End to end: writing the policy file through the REAL path must stay
      // hard-blocked (no dialog) even with UI + ask posture.
      const [handler] = mountGate(snapshot, link);
      const { ctx, asked } = uiCtx([SANDBOX_CHOICE_SESSION]);
      const blocked = await handler(writeEvent(join(PROJ_REAL, ".pi", "sandbox.json")), ctx);
      expect(blocked?.block).toBe(true);
      expect(asked.length).toBe(0);
    } finally {
      rmSync(link, { force: true });
    }
  });

  test("grandchild parentProtectedPaths land in the snapshot resolved to effect space (batch-2 P3)", () => {
    const parent = join("/parent/proj", ".pi", "sandbox.json");
    const snapshot = snapshotSandboxConfig({
      trusted: false,
      cwd: PROJ,
      env: { PAI_SANDBOX: "on" },
      parentProtectedPaths: [parent],
    });
    // /parent does not exist: the resolver keeps the lexical tail.
    expect(snapshot.protectedPaths).toContain(parent);
  });

  test("default enabled snapshot is on with the documented defaults", () => {
    const snapshot = enabledSnapshot();
    expect(snapshot.config.enabled).toBe(true);
    expect(snapshot.config.onViolation).toBe("ask");
    expect(snapshot.config.filesystem.allowWrite).toEqual([".", "/tmp"]);
    expect(snapshot.source).toBe("global");
  });
});
