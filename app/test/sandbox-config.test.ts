import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_SANDBOX_CONFIG,
  loadSandboxConfig,
  readViolation,
  resolveToolPath,
  sandboxDisabledByEnv,
  writeViolation,
} from "../src/sandbox-config.ts";

/**
 * Sandbox config table tests (docs/plans/2026-09-09-sandbox.md §7), extended
 * per the slice adversarial review (P1–P10): merge matrix, trust gate, real
 * bad-file degradation, env kill switch, and the path policy matrix THROUGH
 * the real effect-space resolver (pi input forms, traversal, trailing-slash
 * and root entries, folding, symlinks).
 */

const PROJ = mkdtempSync(join(tmpdir(), "sbx-proj-"));
const OUTSIDE = mkdtempSync(join(tmpdir(), "sbx-out-"));
// Effect space is realpathed: expectations compare against REAL paths.
const PROJ_REAL = realpathSync(PROJ);
const OUTSIDE_REAL = realpathSync(OUTSIDE);
// A real symlinked cwd: effect-space must resolve through it.
const LINKED = mkdtempSync(join(tmpdir(), "sbx-linked-"));
const PROJ_VIA_LINK = join(LINKED, "proj");
symlinkSync(PROJ, PROJ_VIA_LINK);
afterAll(() => {
  rmSync(PROJ, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
  rmSync(LINKED, { recursive: true, force: true });
});

describe("sandbox config loading", () => {
  test("defaults when no files exist (fresh copy, not the shared default)", () => {
    const { config, source } = loadSandboxConfig({
      agentDir: "/agent",
      cwd: PROJ,
      trusted: false,
      readJson: () => null,
    });
    expect(source).toBe("global");
    expect(config).toEqual(DEFAULT_SANDBOX_CONFIG);
    expect(config).not.toBe(DEFAULT_SANDBOX_CONFIG);
    expect(config.filesystem).not.toBe(DEFAULT_SANDBOX_CONFIG.filesystem);
  });

  test("global override replaces arrays wholesale and flips enabled", () => {
    const { config } = loadSandboxConfig({
      agentDir: "/agent",
      cwd: PROJ,
      trusted: false,
      readJson: (path) =>
        path === "/agent/sandbox.json"
          ? { enabled: false, network: { allowedDomains: ["internal.example"] } }
          : null,
    });
    expect(config.enabled).toBe(false);
    expect(config.network.allowedDomains).toEqual(["internal.example"]);
    expect(config.network.deniedDomains).toEqual([]);
    expect(config.filesystem.allowWrite).toEqual(DEFAULT_SANDBOX_CONFIG.filesystem.allowWrite);
  });

  test("project config merges ONLY for trusted threads (user ruling 2)", () => {
    const project = { filesystem: { allowWrite: ["/nowhere"] } };
    const readJson = (path: string) =>
      path === join(PROJ, ".pi", "sandbox.json") ? project : null;
    const untrusted = loadSandboxConfig({
      agentDir: "/agent",
      cwd: PROJ,
      trusted: false,
      readJson,
    });
    const trusted = loadSandboxConfig({ agentDir: "/agent", cwd: PROJ, trusted: true, readJson });
    expect(untrusted.source).toBe("global");
    expect(untrusted.config.filesystem.allowWrite).toEqual(
      DEFAULT_SANDBOX_CONFIG.filesystem.allowWrite,
    );
    expect(trusted.source).toBe("global+project");
    expect(trusted.config.filesystem.allowWrite).toEqual(["/nowhere"]);
  });

  test("empty project object still flips the source", () => {
    const { source } = loadSandboxConfig({
      agentDir: "/agent",
      cwd: PROJ,
      trusted: true,
      readJson: (path) => (path === join(PROJ, ".pi", "sandbox.json") ? {} : null),
    });
    expect(source).toBe("global+project");
  });

  test("malformed sections degrade section-wise, never throw", () => {
    const { config } = loadSandboxConfig({
      agentDir: "/agent",
      cwd: PROJ,
      trusted: true,
      readJson: () => ({
        enabled: "yes please",
        network: { allowedDomains: ["ok.example", 42] },
        filesystem: { allowWrite: "not-an-array" },
      }),
    });
    expect(config.enabled).toBe(true);
    expect(config.network.allowedDomains).toEqual(DEFAULT_SANDBOX_CONFIG.network.allowedDomains);
    expect(config.filesystem.allowWrite).toEqual(DEFAULT_SANDBOX_CONFIG.filesystem.allowWrite);
  });

  test("real bad JSON on disk degrades to absent (the never-throw promise itself)", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "sbx-agent-"));
    writeFileSync(join(agentDir, "sandbox.json"), "{ not json at all");
    const { config, source } = loadSandboxConfig({ agentDir, cwd: PROJ, trusted: true });
    expect(source).toBe("global");
    expect(config).toEqual(DEFAULT_SANDBOX_CONFIG);
    rmSync(agentDir, { recursive: true, force: true });
  });
});

describe("PAI_SANDBOX kill switch", () => {
  for (const value of ["off", "0", "false", "OFF", " false "]) {
    test(`PAI_SANDBOX=${JSON.stringify(value)} disables`, () => {
      expect(sandboxDisabledByEnv({ PAI_SANDBOX: value })).toBe(true);
    });
  }
  test("unset / other values keep the sandbox on", () => {
    expect(sandboxDisabledByEnv({})).toBe(false);
    expect(sandboxDisabledByEnv({ PAI_SANDBOX: "on" })).toBe(false);
    expect(sandboxDisabledByEnv({ PAI_SANDBOX: "" })).toBe(false);
  });
});

describe("effect-space resolver (pi input forms — review P1)", () => {
  test("~ expands to home, not a cwd-relative literal", () => {
    const resolved = resolveToolPath(PROJ, "~/.ssh/authorized_keys");
    expect(resolved.startsWith(`${process.env.HOME}/.ssh`)).toBe(true);
    expect(resolved.includes(PROJ)).toBe(false);
  });

  test("file:// URLs resolve to their path form", () => {
    const resolved = resolveToolPath(PROJ, `file://${OUTSIDE}/evil`);
    expect(resolved.startsWith(OUTSIDE_REAL)).toBe(true);
  });

  test("leading @ is stripped", () => {
    const resolved = resolveToolPath(PROJ, "@/etc/cron.d/x");
    expect(resolved.replace("/private", "")).toBe("/etc/cron.d/x");
  });

  test("traversal collapses lexically before containment (two levels up escapes cwd)", () => {
    const resolved = resolveToolPath(PROJ, "sub/../../outside");
    const expected = join(dirname(PROJ_REAL), "outside");
    expect(resolved).toBe(expected);
  });

  test("symlinked cwd resolves through the link (review P2)", () => {
    const resolved = resolveToolPath(PROJ_VIA_LINK, "src/a.ts");
    expect(resolved.startsWith(PROJ_REAL)).toBe(true);
  });
});

describe("write policy matrix (through the real resolver)", () => {
  const policy = DEFAULT_SANDBOX_CONFIG.filesystem;
  const gate = (rawPath: string, cwd = PROJ): string | undefined =>
    writeViolation(policy, cwd, resolveToolPath(cwd, rawPath));

  test("inside cwd allowed; /tmp allowed across the macOS /private/tmp symlink", () => {
    expect(gate("src/a.ts")).toBeUndefined();
    expect(writeViolation(policy, PROJ, resolveToolPath(PROJ, "/tmp/build-out/x"))).toBeUndefined();
  });

  test("outside every root is blocked", () => {
    expect(gate(join(OUTSIDE, "evil.ts"))).toContain("outside allowed paths");
  });

  test("denyWrite basename and glob at any depth", () => {
    expect(gate(".env")).toContain("denyWrite");
    expect(gate("nested/dir/.env.local")).toContain("denyWrite");
    expect(gate("cert.pem")).toContain("denyWrite");
  });

  test("escape forms land OUTSIDE the roots (review P1 end-to-end)", () => {
    expect(gate("~/.ssh/authorized_keys")).toContain("outside allowed paths");
    expect(gate("file:///etc/passwd")).toContain("outside allowed paths");
    expect(gate("@/etc/passwd")).toContain("outside allowed paths");
    expect(gate("../../../etc/passwd")).toContain("outside allowed paths");
  });

  test("trailing-slash and root entries behave (review P4/P5)", () => {
    const slashed = { denyRead: [`${OUTSIDE}/`], allowWrite: [`${PROJ}/`], denyWrite: [] };
    expect(writeViolation(slashed, PROJ, resolveToolPath(PROJ, "ok.ts"))).toBeUndefined();
    expect(readViolation(slashed, PROJ, resolveToolPath(PROJ, join(OUTSIDE, "secret")))).toContain(
      "denyRead",
    );
    const rootAllow = { denyRead: [], allowWrite: ["/"], denyWrite: [] };
    expect(writeViolation(rootAllow, PROJ, "/usr/local/lib/x")).toBeUndefined();
    const rootDeny = { denyRead: ["/"], allowWrite: [], denyWrite: [] };
    expect(readViolation(rootDeny, PROJ, join(PROJ, "any"))).toContain("denyRead");
  });

  test("allow+deny both hit -> the denyWrite reason wins", () => {
    const both = { denyRead: [], allowWrite: ["/"], denyWrite: [".env"] };
    expect(writeViolation(both, PROJ, join(PROJ, ".env"))).toContain("denyWrite");
  });

  test("unicode NFD and case-folded basenames still match on folding platforms", () => {
    const nfdPolicy = { denyRead: [], allowWrite: [PROJ], denyWrite: ["cafe\u0301*"] };
    const nfcPath = resolveToolPath(PROJ, join(PROJ, "caf\u00e9x"));
    expect(writeViolation(nfdPolicy, PROJ, nfcPath)).toContain("denyWrite");
    const casePolicy = { denyRead: [], allowWrite: [PROJ], denyWrite: [".env"] };
    expect(writeViolation(casePolicy, PROJ, resolveToolPath(PROJ, join(PROJ, ".ENV")))).toContain(
      "denyWrite",
    );
  });

  test("real symlinked deny root matches (review P3)", () => {
    const viaLink = { denyRead: [PROJ_VIA_LINK], allowWrite: [], denyWrite: [] };
    expect(readViolation(viaLink, PROJ, resolveToolPath(PROJ, "secret.txt"))).toContain("denyRead");
  });

  test("allowWrite through a symlinked cwd root still admits in-cwd writes", () => {
    const viaCwd = { denyRead: [], allowWrite: ["."], denyWrite: [] };
    expect(
      writeViolation(viaCwd, PROJ_VIA_LINK, resolveToolPath(PROJ_VIA_LINK, "src/a.ts")),
    ).toBeUndefined();
  });
});

describe("read policy matrix", () => {
  const policy = DEFAULT_SANDBOX_CONFIG.filesystem;
  test("denyRead directory containment via ~", () => {
    expect(readViolation(policy, PROJ, resolveToolPath(PROJ, "~/.ssh/id_rsa"))).toBeDefined();
  });
  test("denyRead glob entry in home path space", () => {
    const globbed = { ...policy, denyRead: ["~/.config/*.secret"] };
    expect(
      readViolation(globbed, PROJ, resolveToolPath(PROJ, "~/.config/api.secret")),
    ).toBeDefined();
  });
  test("ordinary project reads pass", () => {
    expect(readViolation(policy, PROJ, resolveToolPath(PROJ, "src/main.ts"))).toBeUndefined();
  });
});
