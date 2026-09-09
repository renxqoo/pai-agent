/**
 * v0.9 set_model_override (design.md 契约 v0.9 增补; plan
 * docs/plans/2026-09-09-model-overrides.md): host-side merge writer for the
 * agentDir models.json modelOverrides section plus a hot snapshot refresh.
 * Pure planning/merge first (table-tested); the handler owns file IO behind
 * a single in-process writer chain — host commands dispatch concurrently
 * (host.ts `void handleCommand`), so read-modify-write must serialize.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HubFrame, SetModelOverrideCmd, SessionModel } from "./protocol.ts";
import { responseFailure, responseSuccess } from "./frames.ts";
import type { PaiModelRuntime } from "./backend/ports/model-auth.ts";

export type OverrideField = "contextWindow" | "maxTokens";
type FieldValue = number | null;
type JsonRecord = Record<string, unknown>;

/** Either a validated intent or the first validation error (wire message). */
export type OverridePlan =
  | { kind: "remove" }
  | { kind: "set"; fields: Partial<Record<OverrideField, FieldValue>> }
  | { kind: "invalid"; error: string };

export interface OverrideTarget {
  provider: string;
  modelId: string;
}

/** Pure payload validation → intent (no IO; table-tested). */
export function planOverride(cmd: SetModelOverrideCmd): OverridePlan {
  if (typeof cmd.provider !== "string" || cmd.provider.length === 0) {
    return { kind: "invalid", error: "provider must be a non-empty string" };
  }
  if (typeof cmd.modelId !== "string" || cmd.modelId.length === 0) {
    return { kind: "invalid", error: "modelId must be a non-empty string" };
  }
  const names: OverrideField[] = ["contextWindow", "maxTokens"];
  const fields: Partial<Record<OverrideField, FieldValue>> = {};
  let provided = 0;
  for (const name of names) {
    const value = cmd[name];
    if (value === undefined) continue;
    provided++;
    if (
      value !== null &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    ) {
      return { kind: "invalid", error: `${name} must be a positive integer` };
    }
    fields[name] = value;
  }
  if (cmd.remove === true) {
    if (provided > 0) {
      return { kind: "invalid", error: "remove cannot be combined with contextWindow/maxTokens" };
    }
    return { kind: "remove" };
  }
  if (provided === 0) {
    return { kind: "invalid", error: "nothing to set: provide contextWindow/maxTokens or remove" };
  }
  return { kind: "set", fields };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Copy without one key (rest-spread shape; no dynamic delete). defineProperty
 * keeps JSON-legal own "__proto__" data keys as own keys (assignment would
 * hit the prototype setter and silently drop them). */
function omitKey(record: JsonRecord, key: string): JsonRecord {
  const next: JsonRecord = {};
  for (const [name, value] of Object.entries(record)) {
    if (name !== key) {
      Object.defineProperty(next, name, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return next;
}

type OverrideSlot =
  | {
      ok: true;
      providers: JsonRecord;
      providerEntry: JsonRecord;
      overrides: JsonRecord;
    }
  | { ok: false; error: string };

/** Own-property read that never resolves through the prototype
 * (JSON-legal ids like "__proto__" must not hit Object.prototype). */
function ownValue(record: JsonRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

type MaybeRecord = { ok: true; record: JsonRecord } | { ok: false; error: string };

/** One level of the slot path: undefined → fresh {}, object → itself,
 * anything else → the unreadable error for that level. */
function level(value: unknown, error: string): MaybeRecord {
  if (value === undefined) return { ok: true, record: {} };
  if (!isRecord(value)) return { ok: false, error };
  return { ok: true, record: value };
}

/** Shape-validate and read the provider/overrides slot (pure). */
function readSlot(config: JsonRecord, target: OverrideTarget): OverrideSlot {
  const { provider, modelId } = target;
  const providers = level(
    config.providers,
    "models.json is unreadable: providers is not an object",
  );
  if (!providers.ok) return providers;
  const providerEntry = level(
    ownValue(providers.record, provider),
    `models.json is unreadable: provider ${provider} is not an object`,
  );
  if (!providerEntry.ok) return providerEntry;
  const overrides = level(
    providerEntry.record.modelOverrides,
    `models.json is unreadable: provider ${provider} modelOverrides is not an object`,
  );
  if (!overrides.ok) return overrides;
  const current = ownValue(overrides.record, modelId);
  if (current !== undefined && !isRecord(current)) {
    return {
      ok: false,
      error: `models.json is unreadable: override for ${provider}/${modelId} is not an object`,
    };
  }
  return {
    ok: true,
    providers: providers.record,
    providerEntry: providerEntry.record,
    overrides: overrides.record,
  };
}

/** Field-wise entry merge: numbers assign, null clears; an emptied entry
 * deletes itself (the file never grows tombstones). */
function mergeEntry(
  overrides: JsonRecord,
  modelId: string,
  fields: Partial<Record<OverrideField, FieldValue>>,
): { overrides: JsonRecord; changed: boolean } {
  const entry = isRecord(overrides[modelId]) ? (overrides[modelId] as JsonRecord) : {};
  let nextEntry = entry;
  let changed = false;
  for (const name of ["contextWindow", "maxTokens"] as const) {
    const value = fields[name];
    if (value === undefined) continue;
    if (value === null) {
      if (Object.hasOwn(nextEntry, name)) {
        nextEntry = omitKey(nextEntry, name);
        changed = true;
      }
    } else if (nextEntry[name] !== value) {
      nextEntry = { ...nextEntry, [name]: value };
      changed = true;
    }
  }
  if (Object.keys(nextEntry).length > 0) {
    return { overrides: { ...overrides, [modelId]: nextEntry }, changed };
  }
  if (Object.hasOwn(overrides, modelId)) {
    return { overrides: omitKey(overrides, modelId), changed: true };
  }
  return { overrides, changed };
}

/** Pure JSON→JSON merge: touch only providers[provider].modelOverrides[modelId];
 * every other member (unknown fields included) passes through untouched. */
export function applyOverride(
  config: JsonRecord,
  target: OverrideTarget,
  plan: OverridePlan,
): { ok: true; config: JsonRecord; changed: boolean } | { ok: false; error: string } {
  if (plan.kind === "invalid") return { ok: false, error: plan.error };
  const slot = readSlot(config, target);
  if (!slot.ok) return slot;
  let nextOverrides = slot.overrides;
  let changed = false;
  if (plan.kind === "remove") {
    if (Object.hasOwn(nextOverrides, target.modelId)) {
      nextOverrides = omitKey(nextOverrides, target.modelId);
      changed = true;
    }
  } else {
    const merged = mergeEntry(nextOverrides, target.modelId, plan.fields);
    ({ overrides: nextOverrides, changed } = merged);
  }
  if (!changed) return { ok: true, config, changed: false };
  const nextProviderEntry =
    Object.keys(nextOverrides).length > 0
      ? { ...slot.providerEntry, modelOverrides: nextOverrides }
      : omitKey(slot.providerEntry, "modelOverrides");
  const nextProviders =
    Object.keys(nextProviderEntry).length > 0
      ? { ...slot.providers, [target.provider]: nextProviderEntry }
      : omitKey(slot.providers, target.provider);
  return { ok: true, config: { ...config, providers: nextProviders }, changed: true };
}

/** Mirrors coding-agent utils/json.ts stripJsonComments + text.ts stripBom:
 * models.json may carry // comments and trailing commas. Divergence fails
 * closed here (unreadable → refuse to write), never corrupts the file. */
export function parseModelsJson(text: string): JsonRecord {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const stripped = noBom
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (error) {
    throw new Error(
      `models.json is unreadable: ${error instanceof Error ? error.message : error}`,
      {
        cause: error,
      },
    );
  }
  if (!isRecord(parsed)) throw new Error("models.json is unreadable: top level is not an object");
  return parsed;
}

export interface ModelOverrideDeps {
  emit: (frame: HubFrame) => void;
  modelRuntime: PaiModelRuntime;
  modelsJsonPath: () => string;
}

/** Host command entry: validate → definition-level existence (one disk-only
 * refresh retry, so a provider section the app just wrote to models.json is
 * usable without a host restart — subagent-tool precedent) → serialized
 * read-modify-write + refresh → exactly one response. */
export async function handleSetModelOverride(
  deps: ModelOverrideDeps,
  cmd: SetModelOverrideCmd,
  id: string | undefined,
): Promise<void> {
  const plan = planOverride(cmd);
  if (plan.kind === "invalid") {
    deps.emit(responseFailure(id, cmd.type, plan.error));
    return;
  }
  let model = deps.modelRuntime.getModel(cmd.provider, cmd.modelId);
  if (model === undefined) {
    await deps.modelRuntime
      .refresh({ providers: [cmd.provider], allowNetwork: false })
      .catch(() => {});
    model = deps.modelRuntime.getModel(cmd.provider, cmd.modelId);
  }
  if (model === undefined) {
    deps.emit(responseFailure(id, cmd.type, `Model not found: ${cmd.provider}/${cmd.modelId}`));
    return;
  }
  try {
    const applied = await serializeWrite(() => writeOverride(deps, cmd, plan));
    deps.emit(responseSuccess(id, cmd.type, { model: applied }));
  } catch (error) {
    deps.emit(
      responseFailure(id, cmd.type, error instanceof Error ? error.message : String(error)),
    );
  }
}

/** Single in-process writer: read-modify-write sections never interleave. */
let writeChain: Promise<unknown> = Promise.resolve();
function serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
  const run = writeChain.then(operation, operation);
  // The chain token swallows outcomes (the caller owns `run`'s rejection).
  writeChain = run.catch(() => "suppressed");
  return run;
}

async function writeOverride(
  deps: ModelOverrideDeps,
  cmd: SetModelOverrideCmd,
  plan: OverridePlan,
): Promise<SessionModel> {
  const path = deps.modelsJsonPath();
  let text: string | undefined;
  try {
    text = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config = text === undefined ? {} : parseModelsJson(text);
  const result = applyOverride(config, { provider: cmd.provider, modelId: cmd.modelId }, plan);
  if (!result.ok) throw new Error(result.error);
  if (result.changed) await writeAtomic(path, result.config);
  try {
    await deps.modelRuntime.refresh({ providers: [cmd.provider], allowNetwork: false });
  } catch (error) {
    throw new Error(
      `models.json written but refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return resolveApplied(deps, cmd, plan);
}

async function writeAtomic(path: string, config: JsonRecord): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`);
  await rename(tmp, path);
}

/** Post-write verification (honest failure over silent no-op): the refreshed
 * definition must carry exactly the values just written, or the loader
 * rejected the merged file (e.g. a pre-existing schema error elsewhere). */
function resolveApplied(
  deps: ModelOverrideDeps,
  cmd: SetModelOverrideCmd,
  plan: OverridePlan,
): SessionModel {
  const model = deps.modelRuntime.getModel(cmd.provider, cmd.modelId);
  if (model === undefined) {
    throw new Error(`override not applied: ${cmd.provider}/${cmd.modelId} missing after refresh`);
  }
  if (plan.kind === "set") {
    for (const name of ["contextWindow", "maxTokens"] as const) {
      const value = plan.fields[name];
      if (value !== undefined && value !== null && model[name] !== value) {
        throw new Error(
          `override not applied: models.json was rejected by the model loader (${name})`,
        );
      }
    }
  }
  return model;
}
