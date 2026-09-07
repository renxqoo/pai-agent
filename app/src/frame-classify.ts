/**
 * Worker frame classification (pure): prefix dispatch plus the strict
 * response-head match the host uses to avoid parsing giant data frames.
 */

/**
 * Response frames serialize as {"id":"…","type":"response","command":"…",…}
 * (id first when present). Giant data responses are classified by this
 * strict head match (no escapes inside the id) instead of a full parse;
 * anything the regex cannot match exactly falls back to JSON.parse. The
 * key order is asserted by unit test to match the worker's literals.
 */
const RESPONSE_HEAD_WITH_ID = /^\{"id":"([^"\\]*)","type":"response","command":"([^"\\]*)"/;
const RESPONSE_HEAD_NO_ID = /^\{"type":"response","command":"([^"\\]*)"/;

export interface ResponseHead {
  id: string | undefined;
  command: string;
}

/** Returns undefined for lines that are not response frames, null for
 * response frames the strict head match cannot classify. */
export function matchResponseHead(line: string): ResponseHead | undefined | null {
  if (line.startsWith('{"id":"')) {
    const match = RESPONSE_HEAD_WITH_ID.exec(line);
    if (match) return { id: match[1] ?? "", command: match[2] ?? "" };
    return null;
  }
  if (line.startsWith('{"type":"response"')) {
    const match = RESPONSE_HEAD_NO_ID.exec(line);
    if (match) return { id: undefined, command: match[1] ?? "" };
    return null;
  }
  return undefined;
}

/** Commands whose responses update the routing table before forwarding. */
export const CONTROL_COMMANDS: ReadonlySet<string> = new Set([
  "thread/start",
  "thread/resume",
  "thread/stop",
  "fork",
  "clone",
]);
