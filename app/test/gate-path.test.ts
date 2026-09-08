import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMatchPath } from "../src/gate-path.ts";
import { matches } from "../src/rules.ts";

/** Real dir root (realpath'd) so expectations never fight macOS /tmp aliases. */
function makeRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "pai-gate-")));
}

describe("resolveMatchPath (effect-space match values, red-team regression)", () => {
  test("dot-dot traversal no longer lands inside an allow prefix", () => {
    const root = makeRoot();
    try {
      mkdirSync(join(root, "proj"));
      const raw = `${root}/proj/../../escaped.txt`;
      // Old behavior (raw-string matching) is exactly the vulnerability:
      expect(matches([`${root}/proj/*`], raw)).toBe(true);
      const resolved = resolveMatchPath(root, raw);
      expect(resolved).toBe(join(realpathSync(join(root, "..")), "escaped.txt"));
      expect(matches([`${root}/proj/*`], resolved)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("symlinked directory components collapse before matching", () => {
    const root = makeRoot();
    try {
      mkdirSync(join(root, "proj"));
      mkdirSync(join(root, "outside"));
      symlinkSync(join(root, "outside"), join(root, "proj", "link"));
      const raw = `${root}/proj/link/pwned.txt`;
      expect(matches([`${root}/proj/*`], raw)).toBe(true); // old raw match
      const resolved = resolveMatchPath(root, raw);
      expect(resolved).toBe(`${root}/outside/pwned.txt`);
      expect(matches([`${root}/proj/*`], resolved)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("in-scope paths keep matching, missing tail stays lexical", () => {
    const root = makeRoot();
    try {
      mkdirSync(join(root, "proj", "src"), { recursive: true });
      const resolved = resolveMatchPath(join(root, "proj"), "src/new-file.ts");
      expect(resolved).toBe(`${root}/proj/src/new-file.ts`);
      expect(matches([`${root}/proj/*`], resolved)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("relative raw values resolve against the session cwd", () => {
    const root = makeRoot();
    try {
      mkdirSync(join(root, "proj"));
      expect(resolveMatchPath(join(root, "proj"), "../notes.md")).toBe(join(root, "notes.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("existing target collapses fully (final-component symlinks too)", () => {
    const root = makeRoot();
    try {
      mkdirSync(join(root, "proj"));
      mkdirSync(join(root, "outside"));
      writeFileSync(join(root, "outside", "real.ts"), "x");
      symlinkSync(join(root, "outside", "real.ts"), join(root, "proj", "alias.ts"));
      expect(resolveMatchPath(root, `${root}/proj/alias.ts`)).toBe(`${root}/outside/real.ts`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
