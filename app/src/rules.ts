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

export function loadRules(path: string): PermissionRules {
  if (!existsSync(path)) return DEFAULT_RULES;
  return parseRules(readFileSync(path, "utf8"));
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Glob where `*` spans any characters (including `/`); everything else literal. */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
}

export function matches(patterns: string[] | undefined, value: string): boolean {
  return (patterns ?? [])
    .filter((pattern): pattern is string => typeof pattern === "string")
    .some((pattern) => globToRegExp(pattern).test(value));
}

/**
 * Decision order (design.md): mode short-circuits patterns; block beats allow;
 * everything else asks. `allow-all` bypasses block lists by literal semantics.
 */
export function decide(rules: PermissionRules, tool: GatedTool, value: string): PermissionDecision {
  if (rules.mode === "allow-all") return "allow";
  if (rules.mode === "block-all") return "block";
  const toolRules: ToolRules | undefined = rules[tool];
  if (matches(toolRules?.blockPatterns, value)) return "block";
  if (matches(toolRules?.allowPatterns, value)) return "allow";
  return "ask";
}
