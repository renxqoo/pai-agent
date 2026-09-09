/**
 * P3 model-auth port (capability-packs plan §1.3, user ruling R4): model
 * resolution and credential management, independent of the session backend.
 * The coding-agent ModelRuntime is the reference implementation; host
 * (auth/models commands, resolveModel) and worker (grandchild spawns) share
 * one bundle-owned runtime each. auth.json stays host-written only.
 */

import type { RegisterInflight } from "../../inflight-registry.ts";
import type {
  AuthListCmd,
  AuthRemoveKeyCmd,
  AuthSetApiKeyCmd,
  HubFrame,
  SessionModel,
} from "../../protocol.ts";

/** The model-resolution face (snapshot is the find source). v0.9: the
 * members mirror the concrete ModelRuntime API so the runtime satisfies
 * the port structurally — getModel is definition-level (credentials do
 * not gate it), getError surfaces models.json load errors, refresh
 * re-reads the file and recomposes the listed providers. */
export interface PaiModelRuntime {
  getAvailableSnapshot(): ReadonlyArray<SessionModel>;
  getModel(provider: string, modelId: string): SessionModel | undefined;
  getError(): string | undefined;
  refresh(options: { providers?: readonly string[]; allowNetwork?: boolean }): Promise<unknown>;
}

/** Handler deps shared by the auth trio (frames + long-op registry). */
export interface PaiAuthDeps {
  emit: (frame: HubFrame) => void;
  registerInflight: RegisterInflight;
}

/** The auth command face (exactly-one-response and key-redaction contracts
 * live in the implementation, not the caller). */
export interface PaiAuthFace {
  list(deps: PaiAuthDeps, cmd: AuthListCmd, id: string | undefined): Promise<void>;
  setApiKey(deps: PaiAuthDeps, cmd: AuthSetApiKeyCmd, id: string | undefined): Promise<void>;
  removeKey(deps: PaiAuthDeps, cmd: AuthRemoveKeyCmd, id: string | undefined): Promise<void>;
}
