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
import { resolveMatchPath } from "../gate-path.ts";
import { globMatches } from "../rules.ts";

export interface SandboxNetworkPolicy {
  allowedDomains: string[];
  deniedDomains: string[];
}

export interface SandboxFsPolicy {
  denyRead: string[];
  allowWrite: string[];
  denyWrite: string[];
}

/** Persistent user grants (v2 plan §4.3, review P1): a GLOBAL additive
 * relaxation layered over every posture — the network/filesystem arrays are
 * NEVER rewritten by grants (that would cross-pollute postures: a balanced
 * session's Always-dir appended to allowWrite would hand strict sessions
 * the workspace). Still subject to the deny floors. */
export interface SandboxGrantsPolicy {
  domains: string[];
  writeDirs: string[];
  bashPrefixes: string[];
}

/** Credential-env masking for SANDBOXED bash children (v2 plan §4.5):
 * variable NAMES matching these globs are replaced with a fixed sentinel —
 * the real value never enters the sandbox. Unsanboxed reruns (user-approved)
 * keep the real environment. */
export interface SandboxCredentialsPolicy {
  maskEnvVars: string[];
}

/** Handling posture for CONFIRMABLE violations (v0.10): "ask" escalates to a
 * four-way user dialog (v0.12), "deny" keeps the v0.7 hard-block. Protected
 * paths and denyRead matches are never confirmable regardless of this field. */
export type SandboxOnViolation = "ask" | "deny";

/** Security posture (v0.12 plan §4.1): the DEFAULT policy breadth a session
 * starts from — explicit sandbox.json network/filesystem arrays still
 * replace wholesale; grants overlay additively. strict tightens untrusted
 * threads (allowWrite /tmp only, empty network allowlist); open is the
 * honest "allow everything" (hard floors remain). */
export type SandboxPosture = "strict" | "balanced" | "open";

export interface SandboxConfig {
  enabled: boolean;
  onViolation: SandboxOnViolation;
  posture: SandboxPosture;
  network: SandboxNetworkPolicy;
  filesystem: SandboxFsPolicy;
  grants: SandboxGrantsPolicy;
  credentials: SandboxCredentialsPolicy;
}

export type SandboxSource = "global" | "global+project";

/** The BALANCED baseline (= the v0.10 defaults; trusted threads). */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: true,
  onViolation: "ask",
  posture: "balanced",
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
  grants: { domains: [], writeDirs: [], bashPrefixes: [] },
  credentials: {
    maskEnvVars: ["*_API_KEY", "*_TOKEN", "*_SECRET", "*_PASSWORD", "*_KEY", "*_CREDENTIALS"],
  },
};

const UNICODE_SPACES = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;
const CASE_FOLDED_PLATFORM = process.platform === "darwin" || process.platform === "win32";

/** Comparison key: NFC always; case-folded where the filesystem folds. */
export function foldForComparison(value: string): string {
  const normalized = value.normalize("NFC");
  return CASE_FOLDED_PLATFORM ? normalized.toLowerCase() : normalized;
}

/** Containment test in folded space; the filesystem root contains everything.
 * Public for the gate's protected-path hard-block and exemption keys. */
export function pathWithin(path: string, dir: string): boolean {
  return within(path, dir);
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
  const foldedDir = foldForComparison(dir);
  if (foldedDir === "/" || foldedDir === "") return true;
  const foldedPath = foldForComparison(path);
  return foldedPath === foldedDir || foldedPath.startsWith(`${foldedDir}${sep}`);
}

/** Glob match in folded space. */
function foldedGlob(pattern: string, value: string): boolean {
  return globMatches(foldForComparison(pattern), foldForComparison(value));
}

/** Machine-level kill switch (PAI_SANDBOX=off|0|false, case-insensitive). */
export function sandboxDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PAI_SANDBOX;
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === "off" || value === "0" || value === "false";
}

/** The config face of a PAI_SANDBOX=off (or enabled:false) snapshot. */
export const DISABLED_SANDBOX_CONFIG: SandboxConfig = {
  enabled: false,
  onViolation: "deny",
  posture: "balanced",
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  grants: { domains: [], writeDirs: [], bashPrefixes: [] },
  credentials: { maskEnvVars: [] },
};

/** The session-creation snapshot every gate decision (and get_sandbox_state)
 * reads — one truth per session; config changes need a session restart.
 * `protectedPaths` are implicit denyWrite entries (the policy files
 * themselves, incl. the parent conversation's project file for
 * grandchildren) kept OUT of config so get_sandbox_state stays pristine. */
export interface SandboxSnapshot {
  config: SandboxConfig;
  source: "global" | "global+project";
  protectedPaths: string[];
}

/** Build the session snapshot (moved verbatim from the v0.10 gate; the
 * agentDir is injected by the binding — the package never reads pi state). */
export function buildSnapshot(options: {
  agentDir: string;
  trusted: boolean;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  parentProtectedPaths?: string[];
  posture?: SandboxPosture;
}): SandboxSnapshot {
  const { agentDir, trusted, cwd } = options;
  const env = options.env ?? process.env;
  const parentProtectedPaths = options.parentProtectedPaths ?? [];
  if (sandboxDisabledByEnv(env)) {
    return { config: DISABLED_SANDBOX_CONFIG, source: "global", protectedPaths: [] };
  }
  const { config, source } = loadSandboxConfig({
    agentDir,
    cwd,
    trusted,
    ...(options.posture !== undefined ? { posture: options.posture } : {}),
  });
  // The sandbox's own policy files are ALWAYS denyWrite for the tools
  // (adversarial review P6): the sandboxed writer must not be able to weaken
  // a future session's snapshot. Grandchildren additionally protect the
  // PARENT conversation's project file — their task cwd may be a subdirectory
  // (batch-2 review P3). Entries resolve into EFFECT SPACE (realpath of the
  // deepest existing ancestor): tool paths arrive realpathed, so a lexical
  // entry would miss through any symlinked cwd/agentDir and the confirm
  // flow's hard floor would go confirmable (escalation review P1).
  const protectedPaths = [
    join(agentDir, "sandbox.json"),
    join(cwd, ".pi", "sandbox.json"),
    ...parentProtectedPaths,
  ].map((entry) => resolveMatchPath(cwd, entry));
  return { config, source, protectedPaths };
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

/** The default policy breadth for one posture (plan §4.1): explicit
 * sandbox.json arrays still REPLACE these wholesale (mergeConfig); only
 * unset sections take the posture's shape. */
export function defaultConfigForPosture(posture: SandboxPosture): SandboxConfig {
  const base = copyDefault();
  if (posture === "strict") {
    return {
      ...base,
      posture,
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { ...base.filesystem, allowWrite: ["/tmp"] },
    };
  }
  if (posture === "open") {
    return {
      ...base,
      posture,
      // "*" = no effective allowlist (an EMPTY list means "ask for every
      // host" in the runtime's semantics — the opposite of open).
      network: { allowedDomains: ["*"], deniedDomains: base.network.deniedDomains },
      filesystem: { ...base.filesystem, allowWrite: [".", "/tmp", "~"] },
    };
  }
  // (grants stay empty in every posture baseline — they are additive only)
  return { ...base, posture };
}

function copyDefault(): SandboxConfig {
  return {
    enabled: DEFAULT_SANDBOX_CONFIG.enabled,
    onViolation: DEFAULT_SANDBOX_CONFIG.onViolation,
    posture: DEFAULT_SANDBOX_CONFIG.posture,
    network: { ...DEFAULT_SANDBOX_CONFIG.network },
    filesystem: { ...DEFAULT_SANDBOX_CONFIG.filesystem },
    grants: { ...DEFAULT_SANDBOX_CONFIG.grants },
    credentials: { ...DEFAULT_SANDBOX_CONFIG.credentials },
  };
}

/** Section-wise merge; arrays replace, anything malformed is skipped. */
function mergeConfig(base: SandboxConfig, override: Record<string, unknown>): SandboxConfig {
  const merged: SandboxConfig = {
    enabled: base.enabled,
    onViolation: base.onViolation,
    posture: base.posture,
    network: { ...base.network },
    filesystem: { ...base.filesystem },
    grants: { ...base.grants },
    credentials: { ...base.credentials },
  };
  if (typeof override.enabled === "boolean") merged.enabled = override.enabled;
  if (
    override.posture === "strict" ||
    override.posture === "balanced" ||
    override.posture === "open"
  ) {
    merged.posture = override.posture;
  }
  // Bad values are treated as unset (fall back to the inherited/default ask).
  if (override.onViolation === "ask" || override.onViolation === "deny") {
    merged.onViolation = override.onViolation;
  }
  mergeNetwork(merged, override);
  mergeFilesystem(merged, override);
  mergeGrants(merged, override);
  mergeCredentials(merged, override);
  return merged;
}

/** Section mergers (arrays replace wholesale; malformed shapes skip). */
function mergeNetwork(merged: SandboxConfig, override: Record<string, unknown>): void {
  const { network } = override;
  if (typeof network !== "object" || network === null) return;
  const { allowedDomains, deniedDomains } = network as Record<string, unknown>;
  const allowed = stringArray(allowedDomains);
  const denied = stringArray(deniedDomains);
  if (allowed !== undefined) merged.network.allowedDomains = allowed;
  if (denied !== undefined) merged.network.deniedDomains = denied;
}

function mergeFilesystem(merged: SandboxConfig, override: Record<string, unknown>): void {
  const { filesystem: fs } = override;
  if (typeof fs !== "object" || fs === null) return;
  const { denyRead, allowWrite, denyWrite } = fs as Record<string, unknown>;
  const read = stringArray(denyRead);
  const allow = stringArray(allowWrite);
  const deny = stringArray(denyWrite);
  if (read !== undefined) merged.filesystem.denyRead = read;
  if (allow !== undefined) merged.filesystem.allowWrite = allow;
  if (deny !== undefined) merged.filesystem.denyWrite = deny;
}

function mergeCredentials(merged: SandboxConfig, override: Record<string, unknown>): void {
  const { credentials } = override;
  if (typeof credentials !== "object" || credentials === null) return;
  const mask = stringArray((credentials as Record<string, unknown>).maskEnvVars);
  if (mask !== undefined) merged.credentials.maskEnvVars = mask;
}

function mergeGrants(merged: SandboxConfig, override: Record<string, unknown>): void {
  const { grants } = override;
  if (typeof grants !== "object" || grants === null) return;
  const section = grants as Record<string, unknown>;
  const domains = stringArray(section.domains);
  const writeDirs = stringArray(section.writeDirs);
  const bashPrefixes = stringArray(section.bashPrefixes);
  if (domains !== undefined) merged.grants.domains = domains;
  if (writeDirs !== undefined) merged.grants.writeDirs = writeDirs;
  if (bashPrefixes !== undefined) merged.grants.bashPrefixes = bashPrefixes;
}

/** Host-side single-writer append (plan §4.3): one Always-grant lands in the
 * global file's grants section, deduped; returns the NEW file text, null
 * when the existing file is malformed (never throws — the caller decides
 * the failure note), or the input unchanged on a dedupe no-op. */
export function appendGlobalGrant(raw: string, grant: SandboxPersistGrantInput): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const file = { ...(parsed as Record<string, unknown>) };
  const section =
    typeof file["grants"] === "object" && file["grants"] !== null && !Array.isArray(file["grants"])
      ? { ...(file["grants"] as Record<string, unknown>) }
      : {};
  const keys = { domain: "domains", writeDir: "writeDirs", bashPrefix: "bashPrefixes" } as const;
  const key = keys[grant.kind];
  const list = Array.isArray(section[key]) ? (section[key] as unknown[]) : [];
  if (!list.includes(grant.value)) list.push(grant.value);
  section[key] = list;
  file["grants"] = section;
  return `${JSON.stringify(file, null, 2)}
`;
}

/** The persisted-grant wire shape (worker→host frame payload). */
export interface SandboxPersistGrantInput {
  kind: "domain" | "writeDir" | "bashPrefix";
  value: string;
}

/** Enum guard for the thread-parameter posture (defense in depth — the
 * admission layer fails bad values; a stray caller must not bypass the
 * untrusted→strict inference with a typo, review R6). */
function validPostureValue(value: unknown): value is SandboxPosture {
  return value === "strict" || value === "balanced" || value === "open";
}

export interface LoadSandboxDeps {
  agentDir: string;
  cwd: string;
  trusted: boolean;
  /** Posture from the thread parameter (thread.start/resume) — outranks the
   * files; undefined = infer (file posture, else trusted→balanced /
   * untrusted→strict). */
  posture?: SandboxPosture;
  /** Test seam (defaults to the real fs); null/undefined both mean absent. */
  readJson?: (path: string) => Record<string, unknown> | null | undefined;
}

export function loadSandboxConfig(deps: LoadSandboxDeps): {
  config: SandboxConfig;
  source: SandboxSource;
} {
  const readJson = deps.readJson ?? readJsonIfExists;
  // Phase 1: discover the file-declared posture (project over global).
  const globalOverride = readJson(join(deps.agentDir, "sandbox.json"));
  const projectOverride = deps.trusted
    ? readJson(join(deps.cwd, ".pi", "sandbox.json"))
    : undefined;
  const filePosture = [
    ...(projectOverride != null ? [projectOverride] : []),
    ...(globalOverride != null ? [globalOverride] : []),
  ]
    .map((o) => o.posture)
    .find((p): p is SandboxPosture => p === "strict" || p === "balanced" || p === "open");
  const paramPosture = validPostureValue(deps.posture) ? deps.posture : undefined;
  const resolved = paramPosture ?? filePosture ?? (deps.trusted ? "balanced" : "strict");
  // Phase 2: merge the files over the posture-shaped baseline. A file that
  // DECLARED the posture contributes it again (no-op); arrays still replace.
  let config = defaultConfigForPosture(resolved);
  if (globalOverride != null) config = mergeConfig(config, globalOverride);
  let source: SandboxSource = "global";
  if (projectOverride != null) {
    config = mergeConfig(config, projectOverride);
    source = "global+project";
  }
  config.posture = resolved;
  return { config, source };
}

/**
 * Deny matching, by entry shape (entry resolved to effect space first):
 * - glob entry: glob against the full resolved path (stars cross
 *   separators); bare relative globs (".env.*", "*.pem") additionally match
 *   the BASENAME — the pi-example intent, at any depth;
 * - non-glob entry: directory containment OR basename equality.
 */
export function denyEntryMatches(entry: string, cwd: string, resolvedPath: string): boolean {
  const expanded = entryEffectSpace(cwd, entry);
  const base = resolvedPath.split(sep).at(-1) ?? resolvedPath;
  if (entry.includes("*")) {
    if (foldedGlob(expanded, resolvedPath)) return true;
    return !entry.startsWith("~") && !isAbsolute(entry) && foldedGlob(entry, base);
  }
  if (within(resolvedPath, expanded)) return true;
  return foldForComparison(base) === foldForComparison(entry);
}

/**
 * Classified write violation for one effect-space-resolved absolute path:
 * undefined when allowed. `kind` drives v0.10 confirmability (outside-allow
 * and deny-write are dialog-escalatable; the GATE additionally hard-blocks
 * protected-path targets regardless of the matched entry string). `reason`
 * strings are byte-identical to the v0.7 block messages.
 */
export interface WriteViolation {
  kind: "outside-allow" | "deny-write";
  /** deny-write: the matched denyWrite entry (raw policy string). */
  entry?: string;
  reason: string;
}

/**
 * Write policy classification: allowed = inside some allowWrite entry AND
 * outside every denyWrite match. Glob entries in allowWrite are ignored (a
 * globbed write boundary is a footgun).
 */
export function classifyWriteViolation(
  policy: SandboxFsPolicy,
  cwd: string,
  resolvedPath: string,
): WriteViolation | undefined {
  const insideRoot = policy.allowWrite
    .filter((entry) => !entry.includes("*"))
    .some((entry) => within(resolvedPath, entryEffectSpace(cwd, entry)));
  if (!insideRoot) {
    return {
      kind: "outside-allow",
      reason: `Sandbox policy: write outside allowed paths (${resolvedPath})`,
    };
  }
  for (const entry of policy.denyWrite) {
    if (denyEntryMatches(entry, cwd, resolvedPath)) {
      return {
        kind: "deny-write",
        entry,
        reason: `Sandbox policy: denyWrite match ${entry} (${resolvedPath})`,
      };
    }
  }
  return undefined;
}

/** Write policy: undefined when allowed, otherwise the violation reason. */
export function writeViolation(
  policy: SandboxFsPolicy,
  cwd: string,
  resolvedPath: string,
): string | undefined {
  return classifyWriteViolation(policy, cwd, resolvedPath)?.reason;
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

/** Effect-space form of the denyRead entries (v0.10 bash violation filter:
 * file-read denials touching these roots suppress the rerun offer). */
export function denyReadEffectRoots(policy: SandboxFsPolicy, cwd: string): string[] {
  return policy.denyRead.map((entry) => entryEffectSpace(cwd, entry));
}

/** denyRead roots in BOTH observable forms — effect space (realpathed) and
 * lexical expansion (~ / relative resolved, no realpath): tools and shells
 * echo the path exactly as given (/var/... on macOS), while the effect
 * space is /private/var/... — a floor that matches only one form leaks. */
/** Lexical expansion without realpath: "~"→home, relative→cwd-joined. */
function lexicalEntry(entry: string, cwd: string): string {
  if (entry === "~") return homedir();
  if (entry.startsWith("~/")) return join(homedir(), entry.slice(2));
  return isAbsolute(entry) ? entry : join(cwd, entry);
}

export function denyReadRootVariants(policy: SandboxFsPolicy, cwd: string): string[] {
  const variants = new Set<string>();
  for (const entry of policy.denyRead) {
    variants.add(entryEffectSpace(cwd, entry));
    variants.add(lexicalEntry(entry, cwd));
  }
  return [...variants];
}
