/**
 * Line-level wire helpers for the grandchild driver (split from
 * subagent-process.ts for the 500-line file budget).
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Fast id extraction from a response line without a full JSON.parse. */
export function matchResponseId(line: string): string | undefined {
  if (!line.startsWith('{"id":"')) return undefined;
  const end = line.indexOf('"', 7);
  return end === -1 ? undefined : line.slice(7, end);
}
