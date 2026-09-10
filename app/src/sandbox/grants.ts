/**
 * Session grant store (sandbox v2 plan §4.3): coarse-grained "don't ask
 * again" units — directories, denyWrite patterns, network domains, bash
 * prefixes — plus the transitional v0.10 exact-command bash exemptions
 * (removed when the prefix model lands, plan W3).
 *
 * Lifecycle = the conversation continuity (plan §4.3): fork/clone keeps the
 * store (same controller instance); grandchildren receive a snapshot copy;
 * nothing here is ever persisted — "always" goes through GrantPersister.
 */

export interface SandboxSessionGrants {
  /** Effect-space directory paths whose writes are session-exempt. */
  writeDirs: Set<string>;
  /** denyWrite entry strings exempted session-wide (basename patterns). */
  writePatterns: Set<string>;
  /** Network hosts exempted for the session. */
  domains: Set<string>;
  /** Bash command prefixes exempted from escalation asks (per composed
   * segment — see policy.ts suggestPrefixes/commandPrefixGranted). */
  bashPrefixes: Set<string>;
}

/** Caps keep the sets bounded — past a cap we keep asking (never silent). */
export const WRITE_DIR_CAP = 64;
export const WRITE_PATTERN_CAP = 16;
export const DOMAIN_CAP = 64;
export const BASH_PREFIX_CAP = 32;

export function freshSessionGrants(): SandboxSessionGrants {
  return {
    writeDirs: new Set<string>(),
    writePatterns: new Set<string>(),
    domains: new Set<string>(),
    bashPrefixes: new Set<string>(),
  };
}

/** Insert honoring the cap; false = at cap (caller keeps asking). */
export function addCapped(set: Set<string>, cap: number, value: string): boolean {
  if (set.has(value)) return true;
  if (set.size >= cap) return false;
  set.add(value);
  return true;
}

/** Read-only snapshot for a grandchild spawn (plan §4.6: in-sandbox
 * relaxations propagate; bashPrefixes/bashCommands — sandbox-escape
 * privileges — never do). */
export function lineageSnapshot(grants: SandboxSessionGrants): {
  writeDirs: string[];
  writePatterns: string[];
  domains: string[];
} {
  return {
    writeDirs: [...grants.writeDirs],
    writePatterns: [...grants.writePatterns],
    domains: [...grants.domains],
  };
}
