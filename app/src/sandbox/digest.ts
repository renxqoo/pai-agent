/**
 * Sandbox violation digest (pure, table-tested — test/sandbox/digest.test.ts):
 * classify raw seatbelt/seccomp violation lines and a command's failure text
 * into a rerun-decision digest. Extracted verbatim from
 * backend/pi-coding-agent/sandbox-bash.ts (sandbox v2 plan
 * docs/plans/2026-09-10-sandbox-v2.md §三 W1; behavior byte-identical).
 */

import { dirname } from "node:path";
import { realpathSync } from "node:fs";
import { denyEntryMatches, foldForComparison } from "./config.ts";

/** Probe-validated violation-line grammar (darwin, sandbox-runtime 0.0.75 —
 * plan §十一): policy lines carry the operation and a literal path or
 * destination; unrelated denials (sysctl-read, mach-lookup, …) are noise
 * that even perfectly innocent commands produce. */
const FILE_WRITE_DENY = /deny\(\d+\) file-write\S*\s+(\/\S+)/;
const FILE_READ_DENY = /deny\(\d+\) file-read\S*\s+(\/\S+)/;
const NETWORK_OUTBOUND_DENY = /deny network-outbound \S+/;

export interface ViolationDigest {
  /** A file-write or network-outbound denial: re-running unsandboxed would
   * change the outcome. */
  rerunCandidate: boolean;
  /** Evidence of a denyRead-policy hit: the rerun is NEVER offered. ANY
   * file-read denial counts — denyRead is the ONLY read policy, so a
   * file-read deny IS a denyRead hit regardless of path attribution (globs,
   * relative echoes defeat root matching); write denials whose target
   * matches a denyRead ENTRY (denyEntryMatches, glob-aware) floor too. */
  denyReadHit: boolean;
}

/** Classify raw violation lines against the policy (pure, table-tested). */
export function digestViolationLines(
  lines: readonly string[],
  denyReadEntries: readonly string[],
  cwd: string,
): ViolationDigest {
  let rerunCandidate = false;
  let denyReadHit = false;
  for (const line of lines) {
    const writeMatch = FILE_WRITE_DENY.exec(line);
    if (writeMatch !== null || NETWORK_OUTBOUND_DENY.test(line)) rerunCandidate = true;
    if (FILE_READ_DENY.test(line)) {
      // Attribution-free: the OS layer logs literal paths, which glob and
      // relative denyRead entries can never match — any read deny floors.
      denyReadHit = true;
    }
    if (writeMatch !== null) {
      // Write into a denyRead entry floors too (credential trees stay out of
      // the click-to-allow flow — same rule as the write-tool layer, P2).
      const target = writeMatch[1] ?? "";
      if (denyReadEntries.some((entry) => denyEntryMatches(entry, cwd, target))) {
        denyReadHit = true;
      }
    }
  }
  return { rerunCandidate, denyReadHit };
}

/** Offer the confirm-rerun dialog at all (pure, table-tested): only a
 * non-zero exit (the command itself declared failure) with a policy-relevant
 * denial and no denyRead floor hit, and only when someone can be asked. */
export function shouldOfferRerun(deps: {
  exitCode: number | null;
  digest: ViolationDigest;
  canAsk: boolean;
}): boolean {
  const { exitCode, digest, canAsk } = deps;
  return (
    exitCode !== null && exitCode !== 0 && canAsk && digest.rerunCandidate && !digest.denyReadHit
  );
}

/** Sandbox-denial signature in the command's own failure output. Kernel
 * seatbelt log lines lag the process exit by MANY SECONDS under load
 * (e2e-measured >10s, occasionally >15s) and unified-log coalescing can drop
 * repeats entirely — a line-gated offer would be unusably flaky. The
 * signature is therefore FIRST-CLASS candidate evidence (instant); the
 * read/write ambiguity it carries is compensated by a THREE-channel denyRead
 * floor below. */
const SANDBOX_DENIAL_SIGNATURE = /operation not permitted|permission denied|not on the allow list/i;

/** Sandbox-denial signature probe (shared with the violation-settle windows). */
export function sandboxDenialSignature(text: string): boolean {
  return SANDBOX_DENIAL_SIGNATURE.test(text);
}

/** Hosts named by network-outbound deny lines (micro-repro grammar:
 * "deny network-outbound example.org:443 (host is not on the allow list)").
 * The ask callback is the primary pre-connection path; this extraction
 * serves the post-failure fallback. */
export function extractDeniedHosts(lines: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const line of lines) {
    if (!NETWORK_OUTBOUND_DENY.test(line)) continue;
    const raw = /deny network-outbound ([^\s(]+)/.exec(line)?.[1] ?? "";
    const host = raw.replace(/:\d+$/, "");
    if (host.length > 0) hosts.add(host);
  }
  return [...hosts];
}

/** Directory literals named by file-write deny lines — the write-dir grant
 * granularity for the in-sandbox rerun path. */
export function extractDeniedWriteDirs(lines: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const line of lines) {
    const path = FILE_WRITE_DENY.exec(line)?.[1];
    if (path !== undefined) dirs.add(dirname(path));
  }
  return [...dirs];
}

/** Write target echoed by the failing tool itself ("tee: /path: Operation
 * not permitted"). Kernel seatbelt lines lag or drop entirely (e2e-measured
 * >10s, coalesced repeats) — the tool's own error names the path instantly,
 * making the write-dir classification robust without line evidence. A read
 * denial here is not a concern in practice: reads are unrestricted outside
 * denyRead, and denyRead roots floor through the TEXT channels of
 * digestFailure before classification runs. */
const TEXT_WRITE_DENY = /(\/[^\s:]+): [^\n]*(?:operation not permitted|permission denied)/i;

export function extractDeniedWriteDirFromText(
  failureText: string,
  realpath: (path: string) => string = realpathSync,
): string | undefined {
  const path = TEXT_WRITE_DENY.exec(failureText)?.[1];
  if (path === undefined || path.length === 0) return undefined;
  const dir = dirname(path);
  // Canonicalize (macOS /var → /private/var): the granted key must match
  // the effect-space form the write-tool classification compares against.
  try {
    return realpath(dir);
  } catch {
    return dir;
  }
}

/** Policy-relevant line test for this commandId's violation events. */
export function isPolicyRelevantLine(line: string): boolean {
  return (
    FILE_WRITE_DENY.test(line) || FILE_READ_DENY.test(line) || NETWORK_OUTBOUND_DENY.test(line)
  );
}

/** Digest one failed run from BOTH evidence channels: the violation store
 * (precise but lagging) and text (instant but non-discriminating).
 *
 * denyRead floor — three text-ish channels plus the precise line channel:
 * 1. ANY file-read violation line (denyRead is the only read policy);
 * 2. write-line targets matching a denyRead ENTRY (denyEntryMatches, glob);
 * 3. the FAILURE text naming a denyRead root (tools echo the path — both
 *    forms via denyReadRootVariants);
 * 4. the COMMAND text naming a denyRead root (relative-echo shapes like
 *    `cd ~/.ssh && cat id_rsa` carry the root in the command string).
 * Residual leak: a path fully synthesized with the root substring absent
 * from command AND error output — deliberate extreme obfuscation, with the
 * full command still shown to the user before any approval. */
export function digestFailure(deps: {
  lines: readonly string[];
  failureText: string;
  commandText: string;
  /** Raw denyRead policy ENTRIES (glob-aware) — matched against
   * violation-line paths via denyEntryMatches. */
  denyReadEntries: readonly string[];
  /** denyRead roots in both observable forms (effect space + lexical) for
   * the text floors. */
  denyReadRoots: readonly string[];
  cwd: string;
}): ViolationDigest {
  const { lines, failureText, commandText, denyReadEntries, denyReadRoots, cwd } = deps;
  const fromLines = digestViolationLines(lines, denyReadEntries, cwd);
  // Text floors match roots AND raw entries: commands carry the literal
  // entry form ("cd ~/.ssh && cat id_rsa" — the tilde form never expands).
  const rootCandidates = [...denyReadRoots, ...denyReadEntries];
  const hitRootIn = (text: string): boolean => {
    const folded = foldForComparison(text);
    return rootCandidates.some((root) => folded.includes(foldForComparison(root)));
  };
  return {
    rerunCandidate: fromLines.rerunCandidate || SANDBOX_DENIAL_SIGNATURE.test(failureText),
    denyReadHit: fromLines.denyReadHit || hitRootIn(failureText) || hitRootIn(commandText),
  };
}
