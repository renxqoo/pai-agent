/**
 * Sandbox component ports (docs/plans/2026-09-10-sandbox-v2.md §三): the
 * package's ONLY outward seams. Implementations live in the backend binding
 * (pi dialog ctx, worker→host persist frame); the package itself never
 * imports protocol/dialog/worker/host code — enforced by
 * scripts/check-import-boundary.mjs.
 */

/** v2 four-way dialog choices (exact-match parsed; anything else — timeout,
 * cancel, unknown value, throwing channel — settles as "deny", fail-closed). */
export const SANDBOX_CHOICE_ONCE = "Allow once";
export const SANDBOX_CHOICE_SESSION = "Allow for this session";
export const SANDBOX_CHOICE_ALWAYS = "Always allow";
export const SANDBOX_CHOICE_DENY = "Deny";

/** Dialog wall clock (aligned with the permission gate's CONFIRM_TIMEOUT_MS). */
export const SANDBOX_DIALOG_TIMEOUT_MS = 300_000;

/** What the dialog is about to widen — also the grant key each scope mints. */
export type SandboxAskKind =
  /** write/edit outside allowWrite → grant the parent directory. */
  | "write-dir"
  /** write/edit matching a denyWrite entry → grant the pattern for the session. */
  | "write-pattern"
  /** bash outside-sandbox rerun / pre-declared escalation → grant a command prefix. */
  | "bash-escalation"
  /** an unallowlisted network host → grant the domain. */
  | "network-domain";

export interface SandboxAskRequest {
  kind: SandboxAskKind;
  /** The grantable unit as shown to the user (directory, denyWrite entry,
   * command prefix, or host). */
  value: string;
  /** Context line (the resolved target path or command) shown in the title. */
  detail: string;
}

export type SandboxAskChoice = "once" | "session" | "always" | "deny";

export type SandboxAskPort = (
  request: SandboxAskRequest,
  opts?: { signal?: AbortSignal },
) => Promise<SandboxAskChoice>;

/** Best-effort persistence for "Always allow" grants (worker→host frame in
 * production; fire-and-forget — the session already applied its own copy). */
export interface SandboxPersistedGrant {
  kind: "domain" | "writeDir" | "bashPrefix";
  value: string;
}

export interface SandboxGrantPersister {
  persist(grant: SandboxPersistedGrant): void;
}

/** Default sink until the W5 worker→host frame lands (and for probe
 * backends): grants stay session-scoped. */
export const noopPersister: SandboxGrantPersister = { persist: () => {} };

/** The permission gate's view into containment (v2 plan §4.4 B): when bash
 * will run silently sandboxed (or a write classifies clean), the advisory
 * gate's fallback ask is skipped. */
export interface ContainmentOracle {
  silentBash(): boolean;
  classifyWrite(resolvedPath: string): "clean" | "violation";
}
