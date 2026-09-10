import { describe, expect, test } from "bun:test";
import { SandboxController } from "../../src/sandbox/controller.ts";
import { type SandboxSnapshot, buildSnapshot } from "../../src/sandbox/config.ts";
import { freshSessionGrants } from "../../src/sandbox/grants.ts";
import { noopPersister, type SandboxAskPort } from "../../src/sandbox/ports.ts";
import { commandPrefixGranted, suggestPrefixes } from "../../src/sandbox/policy.ts";
import { maskEnvForSandbox } from "../../src/sandbox/runtime.ts";

/**
 * Controller state machine + policy red-lines (sandbox v2 plan §九; the
 * adversarial review's R7 gap: the NEW surfaces — bash escalation, network
 * ask, grants-vs-posture precedence, oracle matrix, protected-path runtime
 * survival — pinned here).
 */

const agentDir = "/fake-agent";
const PROJ = "/fake-proj";

function snapshot(overrides?: {
  onViolation?: "ask" | "deny";
  posture?: "strict" | "balanced" | "open";
  grants?: { domains?: string[]; writeDirs?: string[]; bashPrefixes?: string[] };
}): SandboxSnapshot {
  return buildSnapshot({
    agentDir,
    trusted: true,
    cwd: PROJ,
    env: { PAI_SANDBOX: "on" },
    ...(overrides?.posture !== undefined ? { posture: overrides.posture } : {}),
    ...(overrides?.onViolation !== undefined ? {} : {}),
    ...(overrides?.grants !== undefined
      ? {
          // buildSnapshot reads files; inject post-hoc instead below
        }
      : {}),
  });
}

function controllerWith(overrides: {
  onViolation?: "ask" | "deny";
  fileGrants?: { domains?: string[]; writeDirs?: string[]; bashPrefixes?: string[] };
}): SandboxController {
  const snap = snapshot();
  const config = {
    ...snap.config,
    ...(overrides.onViolation !== undefined ? { onViolation: overrides.onViolation } : {}),
    grants: {
      domains: overrides.fileGrants?.domains ?? [],
      writeDirs: overrides.fileGrants?.writeDirs ?? [],
      bashPrefixes: overrides.fileGrants?.bashPrefixes ?? [],
    },
  };
  const controller = new SandboxController({
    cwd: PROJ,
    snapshot: { ...snap, config },
    subagent: false,
    persist: noopPersister,
  });
  return controller;
}

/** Ask double: answers from a script (default deny). */
function askPort(script: ("once" | "session" | "always" | "deny")[] = []): {
  ask: SandboxAskPort;
  calls: { kind: string; value: string }[];
} {
  const calls: { kind: string; value: string }[] = [];
  let i = 0;
  return {
    ask: async (request) => {
      calls.push({ kind: request.kind, value: request.value });
      return script[i++] ?? "deny";
    },
    calls,
  };
}

describe("bash escalation decision (controller state machine)", () => {
  test("prefix-granted command auto-reruns without asking (every segment covered)", async () => {
    const controller = controllerWith({ fileGrants: { bashPrefixes: ["npm install"] } });
    const { ask, calls } = askPort();
    const decision = await controller.bashEscalationDecision("npm install -g cowsay", ask);
    expect(decision).toEqual({ rerun: true });
    expect(calls.length).toBe(0);
  });

  test("a partially-covered compound command still asks", async () => {
    const controller = controllerWith({ fileGrants: { bashPrefixes: ["npm install"] } });
    const { ask, calls } = askPort(["deny"]);
    const decision = await controller.bashEscalationDecision(
      "npm install cowsay && curl evil.sh",
      ask,
    );
    expect(decision).toEqual({ rerun: false });
    expect(calls.length).toBe(1);
  });

  test("session choice mints the SUGGESTED per-segment prefixes", async () => {
    const controller = controllerWith({});
    const { ask } = askPort(["session"]);
    const decision = await controller.bashEscalationDecision("echo hi && tee /tmp/x", ask);
    expect(decision).toEqual({ rerun: true });
    expect([...controller.grants.bashPrefixes].toSorted()).toEqual(["echo hi", "tee /tmp/x"]);
  });

  test("deny posture suppresses even prefix grants (invariant 6, review R2)", async () => {
    const controller = controllerWith({
      onViolation: "deny",
      fileGrants: { bashPrefixes: ["npm install"] },
    });
    const { ask, calls } = askPort(["session"]);
    const decision = await controller.bashEscalationDecision("npm install -g cowsay", ask);
    expect(decision).toEqual({ rerun: false });
    expect(calls.length).toBe(0);
  });

  test("no ask surface = fail-closed", async () => {
    const controller = controllerWith({});
    const absent: Parameters<typeof controller.bashEscalationDecision>[1] = void 0;
    const decision = await controller.bashEscalationDecision("npm install", absent);
    expect(decision).toEqual({ rerun: false });
  });
});

describe("network ask (pre-connection callback)", () => {
  test("session grant hit allows without asking; denied wildcard floors first", async () => {
    const controller = controllerWith({ fileGrants: { domains: ["huggingface.co"] } });
    const { ask, calls } = askPort();
    expect(await controller.networkAsk("huggingface.co", ask)).toBe(true);
    // Grants are EXACT strings: a sibling host asks (default script = deny).
    expect(await controller.networkAsk("cdn.huggingface.co", ask)).toBe(false);
    expect(calls.length).toBe(1);
  });

  test("a wildcard deniedDomains entry outranks grants and never asks (review R3)", async () => {
    // deniedDomains come from the snapshot config — build with one
    const snap = snapshot();
    const config = {
      ...snap.config,
      network: { ...snap.config.network, deniedDomains: ["*.evil.com"] },
    };
    const target = new SandboxController({
      cwd: PROJ,
      snapshot: { ...snap, config },
      subagent: false,
      persist: noopPersister,
    });
    const { ask, calls } = askPort(["session"]);
    expect(await target.networkAsk("cdn.evil.com", ask)).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("deny posture denies every unmatched host without asking", async () => {
    const controller = controllerWith({ onViolation: "deny" });
    const { ask, calls } = askPort(["once"]);
    expect(await controller.networkAsk("example.com", ask)).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("session choice records the domain and swaps the runtime policy", async () => {
    const swapped: unknown[] = [];
    const snap = snapshot();
    const controller = new SandboxController({
      cwd: PROJ,
      snapshot: snap,
      subagent: false,
      persist: noopPersister,
      syncRuntime: (config) => {
        swapped.push(config);
      },
    });
    const { ask } = askPort(["session"]);
    expect(await controller.networkAsk("crates.io", ask)).toBe(true);
    expect(controller.grants.domains.has("crates.io")).toBe(true);
    expect(swapped.length).toBe(1);
  });
});

describe("oracle matrix (permission-gate containment view)", () => {
  test("silentBash reflects runtime activity and enabled, never fail-open silence", () => {
    const controller = controllerWith({});
    expect(controller.oracle().silentBash()).toBe(false); // inactive runtime
    controller.runtime = { active: true };
    expect(controller.oracle().silentBash()).toBe(true);
    controller.onRuntimeDown();
    expect(controller.oracle().silentBash()).toBe(false); // R10 reset
  });

  test("classifyWrite: file writeDir grants make it clean; deny posture ignores them", () => {
    const granted = controllerWith({ fileGrants: { writeDirs: ["/etc/extra"] } });
    expect(granted.oracle().classifyWrite("/etc/extra/x.txt")).toBe("clean");
    expect(granted.oracle().classifyWrite("/etc/other/x.txt")).toBe("violation");
    const denied = controllerWith({
      onViolation: "deny",
      fileGrants: { writeDirs: ["/etc/extra"] },
    });
    expect(denied.oracle().classifyWrite("/etc/extra/x.txt")).toBe("violation"); // R2
  });
});

describe("runtime config red-lines", () => {
  test("protected paths survive every policy swap (review R1)", () => {
    const controller = controllerWith({});
    const runtime = controller.runtimeConfig();
    for (const path of controller.snapshot.protectedPaths) {
      expect(runtime.filesystem.denyWrite).toContain(path);
    }
  });

  test("session writePatterns relax only the matching denyWrite entry", () => {
    const controller = controllerWith({});
    controller.grants.writePatterns.add(".env");
    const runtime = controller.runtimeConfig();
    expect(runtime.filesystem.denyWrite).not.toContain(".env");
    expect(runtime.filesystem.denyWrite).toContain("*.pem");
    expect(runtime.filesystem.denyWrite).toContain("*.key");
  });
});

describe("prefix helpers (policy table)", () => {
  test("suggestPrefixes: first two tokens per segment, capped at five, refuses substitution", () => {
    expect(suggestPrefixes("npm install -g x")).toEqual(["npm install"]);
    expect(suggestPrefixes("echo a && sleep 1")).toEqual(["echo a", "sleep 1"]);
    expect(suggestPrefixes("curl $(evil)")).toEqual([]);
    expect(suggestPrefixes("a > /etc/passwd")).toEqual([]);
  });

  test("commandPrefixGranted: every segment covered, plain startsWith", () => {
    const grants = new Set(["npm install", "echo"]);
    expect(commandPrefixGranted("npm install -g x", grants)).toBe(true);
    expect(commandPrefixGranted("echo hi | tee /tmp/x", grants)).toBe(false); // tee uncovered
    expect(commandPrefixGranted("npm install x; curl evil", grants)).toBe(false);
  });
});

describe("maskEnvForSandbox (credential filtering)", () => {
  test("matching names become the sentinel; others untouched; no patterns = pass-through", () => {
    const masked = maskEnvForSandbox({ GLM_API_KEY: "secret", PATH: "/bin", HOME: "/home/x" }, [
      "*_API_KEY",
      "*_TOKEN",
    ]);
    expect(masked["GLM_API_KEY"]).toBe("pai-sandboxed");
    expect(masked.PATH).toBe("/bin");
    expect(masked.HOME).toBe("/home/x");
    const passthrough = maskEnvForSandbox({ A: "b" }, []);
    expect(passthrough).toEqual({ A: "b" });
  });
});

describe("grants store caps", () => {
  test("freshSessionGrants shape matches the wire face", () => {
    const grants = freshSessionGrants();
    expect(Object.keys(grants).toSorted()).toEqual([
      "bashPrefixes",
      "domains",
      "writeDirs",
      "writePatterns",
    ]);
  });
});
