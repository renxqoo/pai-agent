/**
 * Sandbox policy composition (sandbox v2 plan §4.3): session grants overlay
 * the snapshot classification, the four-way ask titles live here (pure,
 * pinned by tests), and bash prefix matching composes through rules.ts's
 * segment splitter.
 */

import { dirname } from "node:path";
import { commandSegments } from "../rules.ts";
import {
  type SandboxFsPolicy,
  type WriteViolation,
  classifyWriteViolation,
  denyEntryMatches,
  pathWithin,
} from "./config.ts";
import type { SandboxSessionGrants } from "./grants.ts";
import type { SandboxAskKind, SandboxAskRequest } from "./ports.ts";

/** The grantable view of one write classification: `ask` is undefined only
 * when the write is clean (grants already cover it or it never violated). */
export interface WriteClassification {
  clean: boolean;
  /** The underlying v0.7 violation (block reason strings stay byte-identical). */
  violation: WriteViolation | undefined;
  ask: { kind: "write-dir" | "write-pattern"; value: string } | undefined;
}

/** Classify with the session-grant overlay: a write outside allowWrite is
 * clean when its parent dir is session-granted; a denyWrite hit is clean
 * when the matched entry is pattern-granted. Grant granularity IS the
 * dialog granularity (plan §4.3: directory / basename-pattern). */
export function classifyWriteWithGrants(deps: {
  policy: SandboxFsPolicy;
  cwd: string;
  resolvedPath: string;
  grants: SandboxSessionGrants;
}): WriteClassification {
  const { policy, cwd, resolvedPath, grants } = deps;
  const violation = classifyWriteViolation(policy, cwd, resolvedPath);
  if (violation === undefined) return { clean: true, violation: undefined, ask: undefined };
  if (violation.kind === "outside-allow") {
    for (const dir of grants.writeDirs) {
      if (pathWithin(resolvedPath, dir)) {
        return { clean: true, violation: undefined, ask: undefined };
      }
    }
    return {
      clean: false,
      violation,
      ask: { kind: "write-dir", value: dirname(resolvedPath) },
    };
  }
  const entry = violation.entry ?? "";
  if ([...grants.writePatterns].some((pattern) => denyEntryMatches(pattern, cwd, resolvedPath))) {
    return { clean: true, violation: undefined, ask: undefined };
  }
  return { clean: false, violation, ask: { kind: "write-pattern", value: entry } };
}

/** Four-way ask titles (English, protocol-visible through ui_request). The
 * value line doubles as the "rule as written" preview for Always-allow. */
export function askTitle(request: SandboxAskRequest): string {
  switch (request.kind) {
    case "write-dir":
      return `Sandbox: allow writes under ${request.value}? (${request.detail})`;
    case "write-pattern":
      return `Sandbox: allow ${request.value} writes? (${request.detail})`;
    case "bash-escalation":
      return `Sandbox denied this command — re-run without sandbox? (${request.detail})`;
    case "network-domain":
      return `Sandbox: allow network access to ${request.value}? (${request.detail})`;
  }
}

/** Suggested prefix grants for one command: the first two whitespace tokens
 * of every composed segment, capped at five (Claude's compound-approval
 * precedent — approving one command may mint several sub-rules). Empty for
 * commands the splitter refuses (substitution/redirects never compose). */
export function suggestPrefixes(command: string): string[] {
  const segments = commandSegments(command);
  if (segments === undefined) return [];
  return segments.slice(0, 5).map((segment) => {
    const tokens = segment.split(/\s+/);
    return tokens.length >= 2 ? `${tokens[0]} ${tokens[1]}` : (tokens[0] ?? segment);
  });
}

/** Prefix-grant probe: EVERY composed segment must be covered by some
 * granted prefix (plain startsWith — codex semantics). Unsplittable or
 * empty commands are never covered. */
export function commandPrefixGranted(command: string, prefixes: ReadonlySet<string>): boolean {
  const segments = commandSegments(command);
  if (segments === undefined || prefixes.size === 0) return false;
  const list = [...prefixes];
  return segments.every((segment) =>
    list.some((prefix) => prefix.length > 0 && segment.startsWith(prefix)),
  );
}

/** Ask kinds that carry a persistent Always grant (denyWrite patterns are
 * session-only by ruling — credential-shaped files re-ask every session). */
export function alwaysGrantFor(
  kind: SandboxAskKind,
): "domain" | "writeDir" | "bashPrefix" | undefined {
  if (kind === "network-domain") return "domain";
  if (kind === "write-dir") return "writeDir";
  if (kind === "bash-escalation") return "bashPrefix";
  return undefined;
}
