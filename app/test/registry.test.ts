import { describe, expect, test } from "bun:test";
import { resolveBackendSelection } from "../src/backend/registry.ts";

describe("resolveBackendSelection", () => {
  test("default backend spawns self without consulting the registry file", () => {
    let read = false;
    const selection = resolveBackendSelection({
      envBackendId: undefined,
      agentDir: "/agent",
      readFile: () => {
        read = true;
        return "{}";
      },
    });
    expect(selection).toEqual({ backendId: "pi-coding-agent", spawn: { kind: "self" } });
    expect(read).toBeFalse();
  });

  test("explicit default id also spawns self (whitespace trimmed)", () => {
    const selection = resolveBackendSelection({
      envBackendId: "  pi-coding-agent  ",
      agentDir: "/agent",
    });
    expect(selection.spawn).toEqual({ kind: "self" });
  });

  test("registered backend resolves to its spawn spec", () => {
    const file = JSON.stringify({
      "my-agent": { command: "/bin/my-agent", args: ["--worker"], env: { FOO: "1" } },
    });
    const selection = resolveBackendSelection({
      envBackendId: "my-agent",
      agentDir: "/agent",
      readFile: (path) => (path === "/agent/backends.json" ? file : undefined),
    });
    expect(selection).toEqual({
      backendId: "my-agent",
      spawn: {
        kind: "spec",
        command: "/bin/my-agent",
        args: ["--worker"],
        env: { FOO: "1" },
      },
    });
  });

  test("unknown backend fails closed (never silently falls back to self)", () => {
    const cases = [
      { readFile: undefined as (() => string | undefined) | undefined },
      { readFile: () => JSON.stringify({ other: { command: "x", args: [] } }) },
      { readFile: () => "not json" },
      { readFile: () => JSON.stringify({ "my-agent": { args: [] } }) },
      { readFile: () => JSON.stringify({ "my-agent": { command: "x", args: [1] } }) },
      { readFile: () => JSON.stringify({ "my-agent": { command: "x", args: [], env: 3 } }) },
    ];
    for (const testCase of cases) {
      const selection = resolveBackendSelection({
        envBackendId: "my-agent",
        agentDir: "/agent",
        readFile: testCase.readFile,
      });
      expect(selection.backendId).toBe("my-agent");
      expect(selection.spawn.kind).toBe("unregistered");
    }
  });

  test("degradation warnings are emitted for malformed entries", () => {
    const warnings: string[] = [];
    resolveBackendSelection({
      envBackendId: "my-agent",
      agentDir: "/agent",
      readFile: () => JSON.stringify({ "my-agent": { command: "", args: [] } }),
      warn: (line) => warnings.push(line),
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("my-agent");
  });
});
