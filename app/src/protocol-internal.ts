/**
 * INTERNAL worker↔host frames split out of protocol.ts (the file hit the
 * lint size cap after v0.12; protocol.ts re-exports everything — the wire
 * vocabulary's single public truth stays protocol.ts).
 */

/**
 * v0.6 INTERNAL worker→host grant arbitration (global running-grandchild
 * cap, PAI_MAX_SUBAGGENTS — design.md v0.6 / migration §3 addendum).
 * acquire: `{"type":"grant","id":"g-<seq>","n":1}` — host replies with an
 * internal `grant_result` command carrying the same id.
 * release: same frame with `"release":true` — no reply.
 */
export interface WorkerGrantFrame {
  type: "grant";
  id: string;
  n?: number;
  release?: boolean;
}

/** v0.12 INTERNAL worker→host "Always allow" persistence: fire-and-forget
 * (the session already applied its copy); host = single writer of the
 * global sandbox.json grants section (read-merge-atomic-write). */
export interface WorkerSandboxGrantFrame {
  type: "sandbox_grant_persist";
  grant: { kind: "domain" | "writeDir" | "bashPrefix"; value: string };
}

/** v0.6 INTERNAL host→worker grant decision (id = the grant id). The worker
 * resolves its pending acquire and replies with an absorbed ack response;
 * `running` (denials only) feeds the retryable limit-error message. */
export interface WorkerGrantResultCmd {
  type: "grant_result";
  granted: boolean;
  running?: number;
}
