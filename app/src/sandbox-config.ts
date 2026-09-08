/**
 * Sandbox configuration (docs/plans/2026-09-09-sandbox.md §2): pure load /
 * merge / trust-gate / path-policy matching. Table-tested; the only side
 * effects are explicit file reads passed in as deps.
 *
 * Effect-space symmetry (adversarial review P1–P5): tool inputs and policy
 * entries go through the SAME resolver — a mirror of pi's tool-path
 * normalization (trim, unicode-space collapse, leading "@", "~" expansion,
 * file:// URLs) followed by gate-path's realpath shrink of the deepest
 * existing ancestor. Comparisons are NFC-normalized, and case-folded on
 * platforms with case-insensitive filesystems (darwin/win32).
 *
 * - Global `<agentDir>/sandbox.json` always loads; project `<cwd>/.pi/sandbox.json`
 *   merges on top ONLY for trusted threads (user ruling: a hostile repo must
 *   not be able to weaken its own sandbox). Arrays replace wholesale.
 * - Bad/missing files degrade to defaults (never throw).
 * - PAI_SANDBOX=off|0|false force-disables at machine level (escape hatch).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, sep } from "node:path";
import { resolveMatchPath } from "./gate-path.ts";
import { globMatches } from "./rules.ts";

export interface SandboxNetworkPolicy {
  allowedDomains: string[];
  deniedDomains: string[];
}

export interface SandboxFsPolicy {
  denyRead: string[];
  allowWrite: string[];
  denyWrite: string[];
}

export interface SandboxConfig {
  enabled: boolean;
  network: SandboxNetworkPolicy;
  filesystem: SandboxFsPolicy;
}

export type SandboxSource = "global" | "global+project";

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: true,
  network: {
    // Loopback first: local dev registries and the hermetic e2e mock server
    // must work out of the box; then the package/CI hosts pi's example ships.
    allowedDomains: [
      "127.0.0.1",
      "localhost",
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
  },
};

const UNICODE_SPACES = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;
const CASE_FOLDED_PLATFORM = process.platform === "darwin" || process.platform === "win32";

/** Comparison key: NFC always; case-folded where the filesystem folds. */
function fold(value: string): string {
  const normalized = value.normalize("NFC");
  return CASE_FOLDED_PLATFORM ? normalized.toLowerCase() : normalized;
}

/** Mirror of pi's tool-path input normalization (paths.ts normalizePath). */
function normalizeToolPathInput(raw: string): string {
  let normalized = raw.trim().replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/")) return join(homedir(), normalized.slice(2));
  if (normalized.startsWith("file://")) {
    try {
      return fileURLToPath(normalized);
    } catch {
      return normalized; // malformed URL: fall through, the tool will fail too
    }
  }
  return normalized;
}

/** Tool path → effect space (pi normalization + gate-path realpath shrink). */
export function resolveToolPath(cwd: string, rawPath: string): string {
  return resolveMatchPath(cwd, normalizeToolPathInput(rawPath));
}

/** Policy entry → the same effect space ("." → cwd, "~..." → home). */
function entryEffectSpace(cwd: string, entry: string): string {
  let expanded: string;
  if (entry === ".") expanded = cwd;
  else if (entry === "~") expanded = homedir();
  else if (entry.startsWith("~/")) expanded = join(homedir(), entry.slice(2));
  else expanded = isAbsolute(entry) ? entry : join(cwd, entry);
  return resolveMatchPath(cwd, expanded);
}

/** Containment in folded space; the filesystem root contains everything. */
function within(path: string, dir: string): boolean {
  const foldedDir = fold(dir);
  if (foldedDir === "/" || foldedDir === "") return true;
  const foldedPath = fold(path);
  return foldedPath === foldedDir || foldedPath.startsWith(`${foldedDir}${sep}`);
}

/** Glob match in folded space. */
function foldedGlob(pattern: string, value: string): boolean {
  return globMatches(fold(pattern), fold(value));
}

/** Machine-level kill switch (PAI_SANDBOX=off|0|false, case-insensitive). */
export function sandboxDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PAI_SANDBOX;
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === "off" || value === "0" || value === "false";
}

function readJsonIfExists(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined; // bad JSON degrades to absent
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string" && item.length > 0) ? value : undefined;
}

function copyDefault(): SandboxConfig {
  return {
    enabled: DEFAULT_SANDBOX_CONFIG.enabled,
    network: { ...DEFAULT_SANDBOX_CONFIG.network },
    filesystem: { ...DEFAULT_SANDBOX_CONFIG.filesystem },
  };
}

/** Section-wise merge; arrays replace, anything malformed is skipped. */
function mergeConfig(base: SandboxConfig, override: Record<string, unknown>): SandboxConfig {
  const merged: SandboxConfig = {
    enabled: base.enabled,
    network: { ...base.network },
    filesystem: { ...base.filesystem },
  };
  if (typeof override.enabled === "boolean") merged.enabled = override.enabled;
  const { network, filesystem: fs } = override;
  if (typeof network === "object" && network !== null) {
    const { allowedDomains, deniedDomains } = network as Record<string, unknown>;
    const allowed = stringArray(allowedDomains);
    const denied = stringArray(deniedDomains);
    if (allowed !== undefined) merged.network.allowedDomains = allowed;
    if (denied !== undefined) merged.network.deniedDomains = denied;
  }
  if (typeof fs === "object" && fs !== null) {
    const { denyRead, allowWrite, denyWrite } = fs as Record<string, unknown>;
    const read = stringArray(denyRead);
    const allow = stringArray(allowWrite);
    const deny = stringArray(denyWrite);
    if (read !== undefined) merged.filesystem.denyRead = read;
    if (allow !== undefined) merged.filesystem.allowWrite = allow;
    if (deny !== undefined) merged.filesystem.denyWrite = deny;
  }
  return merged;
}

export interface LoadSandboxDeps {
  agentDir: string;
  cwd: string;
  trusted: boolean;
  /** Test seam (defaults to the real fs); null/undefined both mean absent. */
  readJson?: (path: string) => Record<string, unknown> | null | undefined;
}

export function loadSandboxConfig(deps: LoadSandboxDeps): {
  config: SandboxConfig;
  source: SandboxSource;
} {
  const readJson = deps.readJson ?? readJsonIfExists;
  let config = copyDefault();
  const globalOverride = readJson(join(deps.agentDir, "sandbox.json"));
  if (globalOverride != null) config = mergeConfig(config, globalOverride);
  let source: SandboxSource = "global";
  if (deps.trusted) {
    const projectOverride = readJson(join(deps.cwd, ".pi", "sandbox.json"));
    if (projectOverride != null) {
      config = mergeConfig(config, projectOverride);
      source = "global+project";
    }
  }
  return { config, source };
}

/**
 * Deny matching, by entry shape (entry resolved to effect space first):
 * - glob entry: glob against the full resolved path (stars cross
 *   separators); bare relative globs (".env.*", "*.pem") additionally match
 *   the BASENAME — the pi-example intent, at any depth;
 * - non-glob entry: directory containment OR basename equality.
 */
function denyEntryMatches(entry: string, cwd: string, resolvedPath: string): boolean {
  const expanded = entryEffectSpace(cwd, entry);
  const base = resolvedPath.split(sep).at(-1) ?? resolvedPath;
  if (entry.includes("*")) {
    if (foldedGlob(expanded, resolvedPath)) return true;
    return !entry.startsWith("~") && !isAbsolute(entry) && foldedGlob(entry, base);
  }
  if (within(resolvedPath, expanded)) return true;
  return fold(base) === fold(entry);
}

/**
 * Write policy for one effect-space-resolved absolute path: undefined when
 * allowed, otherwise the violation reason. Allowed = inside some allowWrite
 * entry AND outside every denyWrite match. Glob entries in allowWrite are
 * ignored (a globbed write boundary is a footgun).
 */
export function writeViolation(
  policy: SandboxFsPolicy,
  cwd: string,
  resolvedPath: string,
): string | undefined {
  const insideRoot = policy.allowWrite
    .filter((entry) => !entry.includes("*"))
    .some((entry) => within(resolvedPath, entryEffectSpace(cwd, entry)));
  if (!insideRoot) return `Sandbox policy: write outside allowed paths (${resolvedPath})`;
  for (const entry of policy.denyWrite) {
    if (denyEntryMatches(entry, cwd, resolvedPath)) {
      return `Sandbox policy: denyWrite match ${entry} (${resolvedPath})`;
    }
  }
  return undefined;
}

/** Read policy: undefined when allowed, otherwise the violation reason. */
export function readViolation(
  policy: SandboxFsPolicy,
  cwd: string,
  resolvedPath: string,
): string | undefined {
  for (const entry of policy.denyRead) {
    if (denyEntryMatches(entry, cwd, resolvedPath)) {
      return `Sandbox policy: denyRead match ${entry} (${resolvedPath})`;
    }
  }
  return undefined;
}
