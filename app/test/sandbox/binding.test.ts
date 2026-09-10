import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxController, type SandboxBlock } from "../../src/sandbox/controller.ts";
import { type SandboxSnapshot, buildSnapshot } from "../../src/sandbox/config.ts";
import { WRITE_DIR_CAP } from "../../src/sandbox/grants.ts";
import {
  SANDBOX_CHOICE_ALWAYS,
  SANDBOX_CHOICE_DENY,
  SANDBOX_CHOICE_ONCE,
  SANDBOX_CHOICE_SESSION,
  SANDBOX_DIALOG_TIMEOUT_MS,
  type SandboxPersistedGrant,
} from "../../src/sandbox/ports.ts";
import { createSandboxBinding } from "../../src/backend/pi-coding-agent/sandbox-binding.ts";

/**
 * Sandbox binding unit tests (sandbox v2 plan docs/plans/2026-09-10-sandbox-v2.md
 * §九): the inline extension mounts the controller's write/edit/read hard
 * checks through a minimal ExtensionAPI capture harness; disabled snapshots
 * mount an inert factory; the snapshot builder honors PAI_SANDBOX and arms
 * the implicit policy-file denyWrite. v2: confirmable violations escalate to
 * a FOUR-way select (once / session / always / deny) with coarse session
 * grants — directory granularity for outside-allow, basename-pattern
 * granularity for denyWrite — surviving fork/clone (review P15), with
 * in-flight dedupe and an always-persist port. Hard floors (protected paths
 * incl. symlinked cwd, denyRead roots) never dialog; subagents and missing
 * UI stay fail-closed.
 */

const agentDir = mkdtempSync(join(tmpdir(), "sbx-bind-agent-"));
const PROJ = mkdtempSync(join(tmpdir(), "sbx-bind-"));
const PROJ_REAL = realpathSync(PROJ);
const AGENT_DIR_REAL = realpathSync(agentDir);
afterAll(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(PROJ, { recursive: true, force: true });
});

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
) => Promise<SandboxBlock | undefined>;

function mountBinding(
  snapshot: SandboxSnapshot,
  cwd = PROJ,
  deps: { subagent?: boolean } = {},
): {
  handlers: ToolCallHandler[];
  controller: SandboxController;
  persistCalls: SandboxPersistedGrant[];
} {
  const persistCalls: SandboxPersistedGrant[] = [];
  const controller = new SandboxController({
    cwd,
    snapshot,
    subagent: false,
    persist: {
      persist: (grant) => {
        persistCalls.push(grant);
      },
    },
  });
  const handlers: ToolCallHandler[] = [];
  const pi = {
    on: (name: string, handler: ToolCallHandler) => {
      if (name === "tool_call") handlers.push(handler);
    },
    registerTool: () => {},
  };
  createSandboxBinding({
    trusted: false,
    cwd,
    controller,
    writeStderr: () => {},
    snapshot,
    ...(deps.subagent === true ? { subagent: true } : {}),
  })(pi as never);
  return { handlers, controller, persistCalls };
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
  const snapshot = buildSnapshot({
    agentDir,
    trusted: true,
    cwd: PROJ,
    env: { PAI_SANDBOX: "on" },
  });
  return onViolation === "deny"
    ? { ...snapshot, config: { ...snapshot.config, onViolation: "deny" } }
    : snapshot;
};

const disabledSnapshot: SandboxSnapshot = buildSnapshot({
  agentDir,
  trusted: true,
  cwd: PROJ,
  env: { PAI_SANDBOX: "off" },
});

const writeEvent = (path: string, toolCallId = "t"): Parameters<ToolCallHandler>[0] => ({
  type: "tool_call",
  toolName: "write",
  toolCallId,
  input: { path, content: "x" },
});

describe("sandbox binding (write/edit/read hard checks)", () => {
  test("write inside cwd passes, outside is blocked with a named reason", async () => {
    const [handler] = mountBinding(enabledSnapshot()).handlers;
    const ok = await handler(writeEvent(join(PROJ, "src/a.ts"), "t1"));
    const blocked = await handler(writeEvent("/etc/hosts", "t2"));
    expect(ok).toBeUndefined();
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("outside allowed paths");
  });

  test("edit denyWrite basename match is blocked", async () => {
    const [handler] = mountBinding(enabledSnapshot()).handlers;
    const blocked = await handler(writeEvent(join(PROJ, ".env"), "t3"));
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("denyWrite");
  });

  test("read denyRead match is blocked; ordinary reads pass", async () => {
    const [handler] = mountBinding(enabledSnapshot()).handlers;
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

  test("non-covered tools are untouched", async () => {
    const [handler] = mountBinding(enabledSnapshot()).handlers;
    const result = await handler({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "t6",
      input: { command: "curl https://evil.example" },
    });
    expect(result).toBeUndefined();
  });

  test("disabled snapshot mounts an inert factory (no handlers)", () => {
    expect(mountBinding(disabledSnapshot).handlers.length).toBe(0);
  });

  test("relative and escaping tool paths resolve against the session cwd", async () => {
    const [handler] = mountBinding(enabledSnapshot()).handlers;
    const blocked = await handler(writeEvent("../../../../../../../../../../etc/passwd", "t7"));
    expect(blocked?.block).toBe(true);
  });

  test("malformed input (missing input object) does not crash the handler", async () => {
    const [handler] = mountBinding(enabledSnapshot()).handlers;
    const result = await handler({
      type: "tool_call",
      toolName: "write",
      toolCallId: "t8",
      input: undefined as never,
    });
    expect(result).toBeUndefined();
  });
});

describe("sandbox binding (v2 four-way escalation, write/edit)", () => {
  const OUTSIDE = "/etc/pai-sandbox-test.txt";
  const FOUR_OPTIONS = [
    SANDBOX_CHOICE_ONCE,
    SANDBOX_CHOICE_SESSION,
    SANDBOX_CHOICE_ALWAYS,
    SANDBOX_CHOICE_DENY,
  ];

  test("the dialog offers exactly the four documented options", async () => {
    const [handler] = mountBinding(enabledSnapshot()).handlers;
    const { ctx, asked } = uiCtx([SANDBOX_CHOICE_DENY]);
    await handler(writeEvent(OUTSIDE), ctx);
    expect(asked[0]?.options).toEqual(FOUR_OPTIONS);
  });

  test("Allow once passes the call and does not mint a grant", async () => {
    const [handler] = mountBinding(enabledSnapshot()).handlers;
    const { ctx, asked } = uiCtx([SANDBOX_CHOICE_ONCE, SANDBOX_CHOICE_ONCE]);
    expect(await handler(writeEvent(OUTSIDE, "t1"), ctx)).toBeUndefined();
    expect(asked.length).toBe(1);
    expect(asked[0]?.title).toContain(OUTSIDE);
    // Second write to the same path asks again (once ≠ grant).
    expect(await handler(writeEvent(OUTSIDE, "t2"), ctx)).toBeUndefined();
    expect(asked.length).toBe(2);
  });

  test("Allow for this session grants the DIRECTORY: same and sibling files never ask again", async () => {
    const [handler] = mountBinding(enabledSnapshot()).handlers;
    const { ctx, asked } = uiCtx([SANDBOX_CHOICE_SESSION]);
    expect(await handler(writeEvent("/etc/v2-dir/a.txt", "t1"), ctx)).toBeUndefined();
    expect(await handler(writeEvent("/etc/v2-dir/a.txt", "t2"), ctx)).toBeUndefined();
    expect(await handler(writeEvent("/etc/v2-dir/b/c.txt", "t3"), ctx)).toBeUndefined();
    expect(asked.length).toBe(1); // one ask, then the whole directory is silent
    expect(asked[0]?.title).toContain("/etc/v2-dir");
  });

  test("Always allow records the session grant AND hands the rule to the persister", async () => {
    const { handlers, controller, persistCalls } = mountBinding(enabledSnapshot());
    const [handler] = handlers;
    const { ctx } = uiCtx([SANDBOX_CHOICE_ALWAYS]);
    expect(await handler(writeEvent("/etc/v2-always/x.txt"), ctx)).toBeUndefined();
    // The grant key is EFFECT-SPACE (macOS /etc → /private/etc).
    const grantedDir = join(realpathSync("/etc"), "v2-always");
    expect(controller.grants.writeDirs.has(grantedDir)).toBe(true);
    expect(persistCalls).toEqual([{ kind: "writeDir", value: grantedDir }]);
  });

  test("denyWrite pattern grants are entry-scoped: .env goes silent, *.pem keeps asking", async () => {
    const [handler] = mountBinding(enabledSnapshot()).handlers;
    // Script: t1 = session (grants .env); the silent t2 consumes nothing;
    // t3 (*.pem — a different grant key) gets an explicit Deny.
    const { ctx, asked } = uiCtx([SANDBOX_CHOICE_SESSION, SANDBOX_CHOICE_DENY]);
    expect(await handler(writeEvent(join(PROJ, ".env"), "t1"), ctx)).toBeUndefined();
    expect(await handler(writeEvent(join(PROJ, "nested/.env"), "t2"), ctx)).toBeUndefined();
    expect(asked.length).toBe(1); // the .env pattern covers both depths
    expect(asked[0]?.title).toContain(".env");
    // A DIFFERENT denyWrite entry is a different grant key: *.pem asks.
    const pemBlocked = await handler(writeEvent(join(PROJ, "server.pem"), "t3"), ctx);
    expect(pemBlocked?.block).toBe(true);
    expect(asked.length).toBe(2);
  });

  test("Deny keeps the v0.7 block with the same reason string", async () => {
    const [handler] = mountBinding(enabledSnapshot()).handlers;
    const { ctx } = uiCtx([SANDBOX_CHOICE_DENY]);
    const blocked = await handler(writeEvent(OUTSIDE), ctx);
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("outside allowed paths");
  });

  test("timeout / cancel / unknown select value all settle as Deny (fail-closed)", async () => {
    for (const answer of [undefined, "nonsense", ""]) {
      const [handler] = mountBinding(enabledSnapshot()).handlers;
      const { ctx } = uiCtx([answer]);
      const blocked = await handler(writeEvent(OUTSIDE), ctx);
      expect(blocked?.block).toBe(true);
    }
  });

  test("onViolation deny and missing-UI ctx stay hard-blocked without a dialog", async () => {
    const denyMount = mountBinding(enabledSnapshot("deny"));
    const { ctx: denyCtx } = uiCtx([SANDBOX_CHOICE_ONCE]);
    expect((await denyMount.handlers[0](writeEvent(OUTSIDE), denyCtx))?.block).toBe(true);

    const askMount = mountBinding(enabledSnapshot());
    const { ctx, asked } = uiCtx([SANDBOX_CHOICE_ONCE]);
    expect(((await askMount.handlers[0](writeEvent(OUTSIDE))) as SandboxBlock)?.block).toBe(true);
    expect(
      (await askMount.handlers[0](writeEvent(OUTSIDE), { hasUI: false, ui: ctx.ui }))?.block,
    ).toBe(true);
    expect(asked.length).toBe(0);
  });

  test("subagent spawns never escalate (no dialog even with UI)", async () => {
    const [handler] = mountBinding(enabledSnapshot(), PROJ, { subagent: true }).handlers;
    const { ctx, asked } = uiCtx([SANDBOX_CHOICE_ONCE]);
    const blocked = await handler(writeEvent(OUTSIDE), ctx);
    expect(blocked?.block).toBe(true);
    expect(asked.length).toBe(0);
  });

  test("protected policy-file targets are never confirmable", async () => {
    const snapshot = enabledSnapshot();
    const protectedTarget = snapshot.protectedPaths[0] ?? "";
    expect(protectedTarget.length).toBeGreaterThan(0);
    const [handler] = mountBinding(snapshot).handlers;
    const { ctx, asked } = uiCtx([SANDBOX_CHOICE_SESSION]);
    const blocked = await handler(writeEvent(protectedTarget), ctx);
    expect(blocked?.block).toBe(true);
    expect(asked.length).toBe(0);
  });

  test("write into a denyRead root is hard-blocked even with UI", async () => {
    const [handler] = mountBinding(enabledSnapshot()).handlers;
    const { ctx, asked } = uiCtx([SANDBOX_CHOICE_ONCE]);
    const blocked = await handler(writeEvent("~/.ssh/authorized_keys"), ctx);
    expect(blocked?.block).toBe(true);
    expect(asked.length).toBe(0); // credential trees never enter the flow
  });

  test("grant cap: session grants keep allowing but the set clamps at the cap", async () => {
    const { handlers, controller } = mountBinding(enabledSnapshot());
    const [handler] = handlers;
    const { ctx } = uiCtx(Array.from({ length: WRITE_DIR_CAP + 2 }, () => SANDBOX_CHOICE_SESSION));
    for (let i = 0; i < WRITE_DIR_CAP + 2; i += 1) {
      // Distinct DIRECTORIES (the v2 grant granularity — same-dir repeats
      // never ask, so the cap test needs one directory per grant).
      expect(await handler(writeEvent(`/etc/v2-cap-${i}/f.txt`), ctx)).toBeUndefined();
    }
    expect(controller.grants.writeDirs.size).toBe(WRITE_DIR_CAP);
  });

  test("in-flight dedupe: concurrent same-directory violations share one dialog", async () => {
    const { handlers } = mountBinding(enabledSnapshot());
    const [handler] = handlers;
    const asked: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const ctx: ToolCallCtx = {
      hasUI: true,
      ui: {
        select: async (title) => {
          asked.push(title);
          await gate;
          return SANDBOX_CHOICE_SESSION;
        },
      },
    };
    const first = handler(writeEvent("/etc/v2-dedupe/a.txt", "t1"), ctx);
    const second = handler(writeEvent("/etc/v2-dedupe/b.txt", "t2"), ctx);
    release?.();
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
    expect(asked.length).toBe(1); // the second inherited the first's outcome
  });

  test("dialog opts carry the 300s timeout and the turn abort signal", async () => {
    const [handler] = mountBinding(enabledSnapshot()).handlers;
    const controller = new AbortController();
    const { ctx, asked } = uiCtx([SANDBOX_CHOICE_DENY]);
    ctx.signal = controller.signal;
    await handler(writeEvent(OUTSIDE), ctx);
    const opts = asked[0]?.opts as { timeout?: number; signal?: AbortSignal };
    expect(opts.timeout).toBe(SANDBOX_DIALOG_TIMEOUT_MS);
    expect(opts.signal).toBe(controller.signal);
  });

  test("a throwing dialog channel settles fail-closed (blocked, v0.7 reason)", async () => {
    const [handler] = mountBinding(enabledSnapshot()).handlers;
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

  test("snapshot rebuild PRESERVES session grants (conversation continuity, review P15)", async () => {
    const { handlers, controller } = mountBinding(enabledSnapshot());
    const [handler] = handlers;
    const { ctx } = uiCtx([SANDBOX_CHOICE_SESSION]);
    expect(await handler(writeEvent("/etc/v2-fork/a.txt"), ctx)).toBeUndefined();
    expect(controller.grants.writeDirs.size).toBe(1);
    // Re-run the binding factory on the same controller (fork/clone/rebind):
    // fresh snapshot, grants survive.
    createSandboxBinding({
      trusted: false,
      cwd: PROJ,
      controller,
      writeStderr: () => {},
      snapshot: enabledSnapshot(),
    })({ on: () => {}, registerTool: () => {} } as never);
    expect(controller.grants.writeDirs.size).toBe(1);
    const [rehandler] = handlers;
    // The surviving directory grant keeps the rebuilt session silent.
    const { ctx: reCtx, asked: reAsked } = uiCtx([SANDBOX_CHOICE_SESSION]);
    expect(await rehandler(writeEvent("/etc/v2-fork/b.txt"), reCtx)).toBeUndefined();
    expect(reAsked.length).toBe(0);
  });
});

describe("snapshot builder", () => {
  test("PAI_SANDBOX=off produces a disabled snapshot", () => {
    expect(disabledSnapshot.config.enabled).toBe(false);
    expect(mountBinding(disabledSnapshot).handlers.length).toBe(0);
  });

  test("protected paths cover both policy files and stay OUT of the reported config", () => {
    const snapshot = enabledSnapshot();
    expect(snapshot.protectedPaths.some((entry) => entry.startsWith(`${AGENT_DIR_REAL}/`))).toBe(
      true,
    );
    expect(
      snapshot.protectedPaths.some((entry) => entry === join(PROJ_REAL, ".pi", "sandbox.json")),
    ).toBe(true);
    expect(snapshot.config.filesystem.denyWrite).toEqual([".env", ".env.*", "*.pem", "*.key"]);
  });

  test("protected paths are EFFECT-SPACE resolved — a symlinked cwd keeps the policy file un-confirmable", async () => {
    const link = join(PROJ_REAL, "..", `sbx-bind-link-${Date.now()}`);
    symlinkSync(PROJ, link);
    try {
      const snapshot = buildSnapshot({
        agentDir,
        trusted: true,
        cwd: link,
        env: { PAI_SANDBOX: "on" },
      });
      expect(
        snapshot.protectedPaths.some((entry) => entry === join(PROJ_REAL, ".pi", "sandbox.json")),
      ).toBe(true);
      const [handler] = mountBinding(snapshot, link).handlers;
      const { ctx, asked } = uiCtx([SANDBOX_CHOICE_SESSION]);
      const blocked = await handler(writeEvent(join(PROJ_REAL, ".pi", "sandbox.json")), ctx);
      expect(blocked?.block).toBe(true);
      expect(asked.length).toBe(0);
    } finally {
      rmSync(link, { force: true });
    }
  });

  test("grandchild parentProtectedPaths land in the snapshot resolved to effect space", () => {
    const parent = join("/parent/proj", ".pi", "sandbox.json");
    const snapshot = buildSnapshot({
      agentDir,
      trusted: true,
      cwd: PROJ,
      env: { PAI_SANDBOX: "on" },
      parentProtectedPaths: [parent],
    });
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
