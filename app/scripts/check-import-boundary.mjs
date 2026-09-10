#!/usr/bin/env node
/**
 * Import-boundary gate for the sandbox component package (sandbox v2 plan
 * docs/plans/2026-09-10-sandbox-v2.md §三): src/sandbox/** must stay decoupled
 * from the hub — it may import node builtins, its own package files, npm
 * packages, and exactly two shared pure utilities (gate-path, rules). Any
 * import of protocol, dialogs, worker modules, host modules, or backend
 * modules is a boundary violation.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PKG_DIR = join(ROOT, "src", "sandbox");

/** Allowed relative imports from outside the package (shared pure utils). */
const ALLOWED_EXTERNAL = new Set(["../gate-path.ts", "../rules.ts"]);

/** Forbidden import specifiers (substring match against the resolved path). */
const FORBIDDEN = [
  "src/protocol.ts",
  "src/dialogs.ts",
  "src/worker-commands.ts",
  "src/worker-context.ts",
  "src/worker-pool.ts",
  "src/worker-frames.ts",
  "src/worker-process.ts",
  "src/worker.ts",
  "src/host.ts",
  "src/host-commands.ts",
  "src/bash-commands.ts",
  "src/cli.ts",
  "src/backend/",
];

function walk(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) entries.push(...walk(full));
    else if (name.endsWith(".ts")) entries.push(full);
  }
  return entries;
}

const violations = [];
for (const file of walk(PKG_DIR)) {
  const text = readFileSync(file, "utf8");
  const staticSpecs = [...text.matchAll(/(?:from\s+|import\s+)"([^"]+)"/g)].map((m) => m[1]);
  const dynamicSpecs = [...text.matchAll(/import\(\s*"([^"]+)"/g)].map((m) => m[1]);
  const specs = [...staticSpecs, ...dynamicSpecs];
  for (const spec of specs) {
    if (!spec.startsWith(".")) continue; // node: / npm — allowed
    if (spec.startsWith("./")) continue; // intra-package — allowed
    if (ALLOWED_EXTERNAL.has(spec)) continue;
    const resolved = relative(ROOT, join(PKG_DIR, spec)).replaceAll("\\", "/");
    if (FORBIDDEN.some((bad) => resolved.includes(bad) || spec.includes(bad))) {
      violations.push(`${relative(ROOT, file)}: forbidden import "${spec}"`);
    } else {
      violations.push(`${relative(ROOT, file)}: import "${spec}" is not on the allowlist`);
    }
  }
}

if (violations.length > 0) {
  console.error(`check-import-boundary: ${violations.length} violation(s)`);
  for (const line of violations) console.error(`  ${line}`);
  process.exit(1);
}
process.stdout.write("check-import-boundary: clean\n");
