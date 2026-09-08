/**
 * Effect-space match values for gated file tools: the permission gate must
 * judge the path the tool will actually write, not the model's raw string
 * (red-team finding: raw-prefix allows are defeated by `..` traversal and
 * symlinked directory components). Lexical resolve against the session cwd
 * first, then realpath the deepest existing ancestor — missing trailing
 * components (the common new-file write) stay lexical.
 */

import { realpathSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

export function resolveMatchPath(
  cwd: string,
  raw: string,
  realpath: (path: string) => string = realpathSync,
): string {
  const lexical = resolvePath(cwd, raw);
  try {
    return realpath(lexical);
  } catch {
    let dir = dirname(lexical);
    for (;;) {
      try {
        return join(realpath(dir), lexical.slice(dir.length));
      } catch {
        const parent = dirname(dir);
        if (parent === dir) return lexical;
        dir = parent;
      }
    }
  }
}
