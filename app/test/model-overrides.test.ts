import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOverride,
  handleSetModelOverride,
  parseModelsJson,
  planOverride,
  type OverridePlan,
  type OverrideTarget,
} from "../src/model-overrides.ts";
import type { PaiModelRuntime } from "../src/backend/ports/model-auth.ts";
import type { HubFrame, SetModelOverrideCmd } from "../src/protocol.ts";

const cmd = (fields: Partial<SetModelOverrideCmd>): SetModelOverrideCmd => ({
  type: "set_model_override",
  provider: "p",
  modelId: "m",
  ...fields,
});
const target: OverrideTarget = { provider: "p", modelId: "m" };
const setPlan = (
  fields: Partial<Record<"contextWindow" | "maxTokens", number | null>>,
): OverridePlan => ({ kind: "set", fields });
const removePlan: OverridePlan = { kind: "remove" };

describe("planOverride", () => {
  test("missing provider / modelId", () => {
    expect(planOverride(cmd({ provider: "" }))).toEqual({
      kind: "invalid",
      error: "provider must be a non-empty string",
    });
    expect(planOverride(cmd({ modelId: "" }))).toEqual({
      kind: "invalid",
      error: "modelId must be a non-empty string",
    });
  });
  test("remove intent", () => {
    expect(planOverride(cmd({ remove: true }))).toEqual({ kind: "remove" });
  });
  test("remove combined with fields / empty payload", () => {
    expect(planOverride(cmd({ remove: true, contextWindow: 5 }))).toEqual({
      kind: "invalid",
      error: "remove cannot be combined with contextWindow/maxTokens",
    });
    expect(planOverride(cmd({}))).toEqual({
      kind: "invalid",
      error: "nothing to set: provide contextWindow/maxTokens or remove",
    });
  });
  test("value validation (positive safe integers only)", () => {
    expect(planOverride(cmd({ contextWindow: 0 }))).toEqual({
      kind: "invalid",
      error: "contextWindow must be a positive integer",
    });
    expect(planOverride(cmd({ maxTokens: -1 }))).toEqual({
      kind: "invalid",
      error: "maxTokens must be a positive integer",
    });
    expect(planOverride(cmd({ contextWindow: 1.5 }))).toEqual({
      kind: "invalid",
      error: "contextWindow must be a positive integer",
    });
    expect(planOverride(cmd({ contextWindow: Number.MAX_SAFE_INTEGER + 1 }))).toEqual({
      kind: "invalid",
      error: "contextWindow must be a positive integer",
    });
  });
  test("null is the clear-field intent, not a value error", () => {
    expect(planOverride(cmd({ contextWindow: null }))).toEqual({
      kind: "set",
      fields: { contextWindow: null },
    });
    expect(planOverride(cmd({ contextWindow: 8, maxTokens: null }))).toEqual({
      kind: "set",
      fields: { contextWindow: 8, maxTokens: null },
    });
  });
  test("garbage shapes fail closed", () => {
    const garbage = { type: "set_model_override", provider: 7, modelId: "m" };
    expect(planOverride(garbage as unknown as SetModelOverrideCmd)).toEqual({
      kind: "invalid",
      error: "provider must be a non-empty string",
    });
  });
});

describe("applyOverride", () => {
  test("fresh file: creates the nested section", () => {
    const r = applyOverride({}, target, setPlan({ contextWindow: 1 }));
    expect(r).toEqual({
      ok: true,
      changed: true,
      config: { providers: { p: { modelOverrides: { m: { contextWindow: 1 } } } } },
    });
  });
  test("provider siblings and unknown fields pass through untouched", () => {
    const config = { $schema: "x", providers: { other: { baseUrl: "u" }, p: { baseUrl: "b" } } };
    const r = applyOverride(config, target, setPlan({ maxTokens: 2 }));
    expect(r.ok && r.config).toEqual({
      $schema: "x",
      providers: {
        other: { baseUrl: "u" },
        p: { baseUrl: "b", modelOverrides: { m: { maxTokens: 2 } } },
      },
    });
    expect(r.ok && r.changed).toBe(true);
  });
  test("merges into an existing override entry field-wise", () => {
    const config = { providers: { p: { modelOverrides: { m: { contextWindow: 9 } } } } };
    const r = applyOverride(config, target, setPlan({ maxTokens: 2 }));
    expect(r.ok && r.config.providers).toEqual({
      p: { modelOverrides: { m: { contextWindow: 9, maxTokens: 2 } } },
    });
  });
  test("null clears one field, keeps the rest", () => {
    const config = {
      providers: { p: { modelOverrides: { m: { contextWindow: 9, maxTokens: 2 } } } },
    };
    const r = applyOverride(config, target, setPlan({ contextWindow: null }));
    expect(r.ok && r.config.providers).toEqual({ p: { modelOverrides: { m: { maxTokens: 2 } } } });
  });
  test("clearing the last field deletes entry, section, and lone provider", () => {
    const config = { providers: { p: { modelOverrides: { m: { contextWindow: 9 } } } } };
    const r = applyOverride(config, target, setPlan({ contextWindow: null }));
    expect(r.ok && r.config).toEqual({ providers: {} });
  });
  test("clearing an absent field is not a change", () => {
    const config = { providers: { p: { modelOverrides: { m: { maxTokens: 2 } } } } };
    const r = applyOverride(config, target, setPlan({ contextWindow: null }));
    expect(r.ok && r.changed).toBe(false);
  });
  test("writing the same value is not a change", () => {
    const config = { providers: { p: { modelOverrides: { m: { contextWindow: 9 } } } } };
    const r = applyOverride(config, target, setPlan({ contextWindow: 9 }));
    expect(r.ok && r.changed).toBe(false);
  });
  test("remove deletes the entry; absent entry is idempotent no-op", () => {
    const config = {
      providers: { p: { baseUrl: "b", modelOverrides: { m: { contextWindow: 9 } } } },
    };
    const removed = applyOverride(config, target, removePlan);
    expect(removed.ok && removed.config.providers).toEqual({ p: { baseUrl: "b" } });
    const absent = applyOverride({}, target, removePlan);
    expect(absent.ok && absent.changed).toBe(false);
    expect(absent.ok && absent.config).toEqual({});
  });
  test("malformed shapes are refused, never written", () => {
    expect(applyOverride({ providers: 3 }, target, removePlan)).toEqual({
      ok: false,
      error: "models.json is unreadable: providers is not an object",
    });
    expect(applyOverride({ providers: { p: 3 } }, target, removePlan)).toEqual({
      ok: false,
      error: "models.json is unreadable: provider p is not an object",
    });
    expect(applyOverride({ providers: { p: { modelOverrides: 3 } } }, target, removePlan)).toEqual({
      ok: false,
      error: "models.json is unreadable: provider p modelOverrides is not an object",
    });
    expect(
      applyOverride({ providers: { p: { modelOverrides: { m: 3 } } } }, target, removePlan),
    ).toEqual({
      ok: false,
      error: "models.json is unreadable: override for p/m is not an object",
    });
  });
  test("prototype-chain ids stay idempotent (review P2-1 regression)", () => {
    // "constructor" resolves through Object.prototype unless hasOwn guards.
    const r = applyOverride({}, { provider: "p", modelId: "constructor" }, removePlan);
    expect(r.ok && r.changed).toBe(false);
    const set = applyOverride(
      { providers: { p: {} } },
      { provider: "p", modelId: "toString" },
      setPlan({ maxTokens: 2 }),
    );
    expect(set.ok && set.config.providers).toEqual({
      p: { modelOverrides: { toString: { maxTokens: 2 } } },
    });
  });
  test("an own __proto__ sibling entry survives neighbor removal (review P2-1)", () => {
    const config = JSON.parse(
      '{"providers":{"p":{"modelOverrides":{"__proto__":{"maxTokens":1},"m":{"contextWindow":9}}}}}',
    );
    const r = applyOverride(config, target, removePlan);
    const restored = JSON.parse(JSON.stringify(r.ok ? r.config : {}));
    expect(restored.providers.p.modelOverrides).toEqual({ __proto__: { maxTokens: 1 } });
  });
});

describe("parseModelsJson", () => {
  test("mirrors upstream leniency: BOM, // comments, trailing commas", () => {
    const text = '\ufeff{ // leading\n"providers": {"p": {"baseUrl": "b",}},\n}';
    expect(parseModelsJson(text)).toEqual({ providers: { p: { baseUrl: "b" } } });
  });
  test("comment markers inside string literals survive", () => {
    expect(parseModelsJson('{"providers":{"p":{"baseUrl":"http://x//y"}}}')).toEqual({
      providers: { p: { baseUrl: "http://x//y" } },
    });
  });
  test("garbage and non-object tops throw unreadable", () => {
    expect(() => parseModelsJson("{oops")).toThrow(/models.json is unreadable/);
    expect(() => parseModelsJson("[1]")).toThrow(/top level is not an object/);
  });
});

/** Loader stand-in: base definitions plus, on each refresh(), the
 * modelOverrides the current file carries (mirrors the upstream composer's
 * contextWindow/maxTokens merge); `applyFile` off simulates a loader that
 * rejected the merged file. */
function createLoaderRuntime(path: string, base: Array<Record<string, unknown>>) {
  const state = {
    refreshCalls: 0,
    refreshError: undefined as Error | undefined,
    configError: undefined as string | undefined,
    applyFile: true,
  };
  const runtime = {
    getAvailableSnapshot: () => [],
    getModel: (provider: string, modelId: string) => {
      const found = base.find((m) => m.provider === provider && m.id === modelId);
      if (found === undefined) return;
      if (!state.applyFile || !existsSync(path)) return found;
      // Like the real runtime: an unreadable models.json degrades to the
      // definition catalog (builtins stay resolvable), never throws.
      let providers: unknown;
      try {
        ({ providers } = parseModelsJson(readFileSync(path, "utf-8")));
      } catch {
        return found;
      }
      if (typeof providers !== "object" || providers === null) return found;
      const providerEntry = (providers as Record<string, unknown>)[provider];
      if (typeof providerEntry !== "object" || providerEntry === null) return found;
      const overrides = (providerEntry as { modelOverrides?: unknown }).modelOverrides;
      if (typeof overrides !== "object" || overrides === null) return found;
      const entry = (overrides as Record<string, unknown>)[modelId];
      if (entry === undefined) return found;
      return { ...found, ...(entry as Record<string, number>) };
    },
    getError: () => state.configError,
    refresh: async () => {
      state.refreshCalls++;
      if (state.refreshError !== undefined) throw state.refreshError;
    },
  };
  return { runtime: runtime as unknown as PaiModelRuntime, state };
}

describe("handleSetModelOverride", () => {
  function setup(applyFile = true) {
    const dir = mkdtempSync(join(tmpdir(), "pai-model-overrides-"));
    const path = join(dir, "models.json");
    const frames: HubFrame[] = [];
    const { runtime, state } = createLoaderRuntime(path, [
      { provider: "p", id: "m", contextWindow: 10, maxTokens: 20 },
    ]);
    state.applyFile = applyFile;
    const deps = {
      emit: (frame: HubFrame) => frames.push(frame),
      modelRuntime: runtime,
      modelsJsonPath: () => path,
    };
    return { dir, path, frames, deps, state };
  }

  test("writes the merged file, refreshes, answers with effective values", async () => {
    const { dir, path, frames, deps, state } = setup();
    try {
      await handleSetModelOverride(deps, cmd({ contextWindow: 30 }), "id-1");
      expect(frames).toEqual([
        {
          id: "id-1",
          type: "response",
          command: "set_model_override",
          success: true,
          data: { model: { provider: "p", id: "m", contextWindow: 30, maxTokens: 20 } },
        },
      ]);
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
        providers: { p: { modelOverrides: { m: { contextWindow: 30 } } } },
      });
      expect(state.refreshCalls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("unknown model retries one disk refresh, then fails without touching the file", async () => {
    const { dir, path, frames, deps, state } = setup();
    try {
      await handleSetModelOverride(deps, cmd({ provider: "x", contextWindow: 1 }), "id-1");
      expect(existsSync(path)).toBe(false);
      expect(state.refreshCalls).toBe(1);
      expect((frames[0] as { success: boolean; error?: string }).success).toBe(false);
      expect((frames[0] as { error?: string }).error).toMatch(/Model not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("invalid payloads never touch the file (no refresh either)", async () => {
    const { dir, path, frames, deps, state } = setup();
    try {
      await handleSetModelOverride(deps, cmd({ remove: true, maxTokens: 1 }), "id-1");
      await handleSetModelOverride(deps, cmd({ contextWindow: 0 }), "id-2");
      expect(existsSync(path)).toBe(false);
      expect(state.refreshCalls).toBe(0);
      expect(frames.map((f) => (f as { success: boolean }).success)).toEqual([false, false]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("unreadable existing file is refused unchanged", async () => {
    const { dir, path, frames, deps } = setup();
    try {
      writeFileSync(path, "{oops");
      await handleSetModelOverride(deps, cmd({ contextWindow: 30 }), "id-1");
      expect(readFileSync(path, "utf-8")).toBe("{oops");
      expect(frames).toHaveLength(1);
      expect((frames[0] as { success: boolean; error?: string }).success).toBe(false);
      expect((frames[0] as { error?: string }).error).toMatch(/unreadable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("refresh failure reports written-but-not-refreshed honestly", async () => {
    const { dir, path, frames, deps, state } = setup();
    try {
      state.refreshError = new Error("boom");
      await handleSetModelOverride(deps, cmd({ contextWindow: 30 }), "id-1");
      expect(
        JSON.parse(readFileSync(path, "utf-8")).providers.p.modelOverrides.m.contextWindow,
      ).toBe(30);
      expect((frames[0] as { error?: string }).error).toMatch(/written but refresh failed: boom/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("loader rejecting the merged file surfaces as override-not-applied", async () => {
    const { dir, path, frames, deps } = setup(false);
    try {
      await handleSetModelOverride(deps, cmd({ contextWindow: 30 }), "id-1");
      expect(
        JSON.parse(readFileSync(path, "utf-8")).providers.p.modelOverrides.m.contextWindow,
      ).toBe(30);
      expect((frames[0] as { error?: string }).error).toMatch(/override not applied/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("remove on a missing entry is an idempotent success without a write", async () => {
    const { dir, path, frames, deps } = setup();
    try {
      await handleSetModelOverride(deps, cmd({ remove: true }), "id-1");
      expect(existsSync(path)).toBe(false);
      expect((frames[0] as { success: boolean }).success).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("concurrent invokes serialize; final file reflects both", async () => {
    const { dir, path, frames, deps, state } = setup();
    try {
      await Promise.all([
        handleSetModelOverride(deps, cmd({ contextWindow: 30 }), "id-1"),
        handleSetModelOverride(deps, cmd({ maxTokens: 40 }), "id-2"),
      ]);
      expect(frames).toHaveLength(2);
      expect(frames.every((f) => (f as { success: boolean }).success)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
        providers: { p: { modelOverrides: { m: { contextWindow: 30, maxTokens: 40 } } } },
      });
      expect(state.refreshCalls).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
