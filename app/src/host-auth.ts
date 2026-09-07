/**
 * Host-side auth command handlers (v0.2 semantics, moved verbatim from the
 * original hub): list stored credentials, persist an API key through the
 * provider's sanctioned login flow, remove a key credential. Security lines
 * are load-bearing — see the inline notes before touching them.
 */

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { AuthListCmd, AuthRemoveKeyCmd, AuthSetApiKeyCmd, HubFrame } from "./protocol.ts";
import { responseFailure, responseSuccess } from "./frames.ts";
import type { RegisterInflight } from "./inflight-registry.ts";

export interface HostAuthDeps {
  modelRuntime: ModelRuntime;
  emit: (frame: HubFrame) => void;
  registerInflight: RegisterInflight;
}

export async function handleAuthList(
  deps: HostAuthDeps,
  cmd: AuthListCmd,
  id: string | undefined,
): Promise<void> {
  const credentials = await deps.modelRuntime.listCredentials();
  deps.emit(
    responseSuccess(
      id,
      cmd.type,
      // providerId -> provider: one naming convention on the wire.
      { credentials: credentials.map((c) => ({ provider: c.providerId, type: c.type })) },
    ),
  );
}

/** Validation gate before auth.json is touched; returns the failure message. */
async function setKeyValidationError(
  modelRuntime: ModelRuntime,
  cmd: AuthSetApiKeyCmd,
): Promise<string | undefined> {
  if (typeof cmd.provider !== "string" || cmd.provider.length === 0) {
    return "provider must be a non-empty string";
  }
  if (typeof cmd.apiKey !== "string" || cmd.apiKey.length === 0) {
    return "apiKey must be a non-empty string";
  }
  // Validate against the builtin catalog (credential-independent):
  // getAvailableSnapshot() only lists providers that already have
  // credentials, so it cannot gate the very act of adding one.
  // models.json custom providers are out of scope for v0.2 (their
  // credentials live in models.json, not auth.json).
  const provider = builtinProviders().find((p) => p.id === cmd.provider);
  if (provider === undefined) {
    // Reject before touching auth.json: an unknown provider would otherwise
    // persist a garbage credential entry.
    return `Unknown provider: ${cmd.provider}`;
  }
  // Ambient-only providers omit apiKey.login and cannot take a stored key.
  if (provider.auth.apiKey?.login === undefined) {
    return `Provider does not support stored API keys: ${cmd.provider}`;
  }
  // Never silently overwrite a different credential type (e.g. an OAuth
  // subscription login) — that would destroy it.
  const existing = (await modelRuntime.listCredentials()).find(
    (c) => c.providerId === cmd.provider,
  );
  if (existing !== undefined && existing.type !== "api_key") {
    return `Provider has a ${existing.type} credential; remove it first`;
  }
  return undefined;
}

/** login("api_key") through the provider's sanctioned flow. Returns a
 * REDACTED error message, or undefined on success. */
async function loginWithKey(deps: {
  modelRuntime: ModelRuntime;
  provider: string;
  apiKey: string;
  signal: AbortSignal;
}): Promise<string | undefined> {
  const { modelRuntime, provider, apiKey, signal } = deps;
  // Security: the key must never appear in any frame, including the error
  // path — the bridge only ever answers the FIRST secret prompt (some
  // providers ask select/text for extra fields, e.g. bedrock or cloudflare
  // account IDs; answering those with the key would leak it into error
  // messages or persist it into wrong fields), and every emitted error
  // message is redacted as defense in depth. login("api_key") persists —
  // setRuntimeApiKey alone is runtime-only and would not survive a host
  // restart. Workers pick the stored key up on their next credential read
  // (auth.json is stat-checked on every read).
  let keyAnswered = false;
  try {
    await modelRuntime.login(provider, "api_key", {
      signal,
      prompt: async (p) => {
        if (p.type === "secret" && !keyAnswered) {
          keyAnswered = true;
          return apiKey;
        }
        throw new Error(
          `Provider requires additional interactive input (${p.type}); not supported by auth/set_api_key`,
        );
      },
      notify: () => {},
    });
  } catch (error) {
    return String(error instanceof Error ? error.message : error).replaceAll(apiKey, "[redacted]");
  }
  return undefined;
}

export async function handleAuthSetApiKey(
  deps: HostAuthDeps,
  cmd: AuthSetApiKeyCmd,
  id: string | undefined,
): Promise<void> {
  const validationError = await setKeyValidationError(deps.modelRuntime, cmd);
  if (validationError !== undefined) {
    deps.emit(responseFailure(id, cmd.type, validationError));
    return;
  }
  const abort = new AbortController();
  const inflight = deps.registerInflight(() => abort.abort());
  try {
    const loginError = await loginWithKey({
      modelRuntime: deps.modelRuntime,
      provider: cmd.provider,
      apiKey: cmd.apiKey,
      signal: abort.signal,
    });
    if (loginError !== undefined) {
      deps.emit(responseFailure(id, cmd.type, loginError));
      return;
    }
  } finally {
    inflight.unregister();
  }
  deps.emit(responseSuccess(id, cmd.type, { provider: cmd.provider }));
}

export async function handleAuthRemoveKey(
  deps: HostAuthDeps,
  cmd: AuthRemoveKeyCmd,
  id: string | undefined,
): Promise<void> {
  if (typeof cmd.provider !== "string" || cmd.provider.length === 0) {
    deps.emit(responseFailure(id, cmd.type, "provider must be a non-empty string"));
    return;
  }
  // logout deletes the WHOLE stored credential (removeRuntimeApiKey only
  // clears the runtime overlay), so guard the type: this command must not
  // destroy an OAuth credential.
  const existing = (await deps.modelRuntime.listCredentials()).find(
    (c) => c.providerId === cmd.provider,
  );
  if (existing !== undefined && existing.type !== "api_key") {
    deps.emit(
      responseFailure(
        id,
        cmd.type,
        `Provider has a ${existing.type} credential; only api_key credentials can be removed with auth/remove_key`,
      ),
    );
    return;
  }
  await deps.modelRuntime.logout(cmd.provider);
  deps.emit(responseSuccess(id, cmd.type));
}
