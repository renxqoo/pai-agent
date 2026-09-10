/**
 * Spawn-shaping helpers (extracted from session-adapter.ts, sandbox v2 W4:
 * the adapter hit the size cap): the loader-options shaping (untrusted ⇒
 * noExtensions, system prompt), the session-create shaping (tool allowlist,
 * thinking level), and fork inheritance (replacement model/thinking level
 * outrank the spawn-time snapshot).
 */

import type {
  CreateAgentSessionFromServicesOptions,
  CreateAgentSessionRuntimeFactory,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { SessionModel } from "../../protocol.ts";
import type { SpawnShaping } from "../ports/session.ts";

export function shapingOptions(shaping: SpawnShaping | undefined): Record<string, unknown> {
  if (shaping === undefined) return {};
  return {
    ...(shaping.tools !== undefined ? { tools: shaping.tools } : {}),
    ...(shaping.thinkingLevel !== undefined ? { thinkingLevel: shaping.thinkingLevel } : {}),
  };
}

/** Loader options shared by every spawn of this factory (trust + shaping). */
export function resourceOptionsFor(
  deps: { trusted: boolean; shaping: SpawnShaping | undefined },
  base: { cwd: string; extensionFactories: InlineExtension[] },
) {
  const { trusted, shaping } = deps;
  return {
    ...(trusted ? {} : { noExtensions: true }),
    extensionFactories: base.extensionFactories,
    ...(shaping?.systemPrompt !== undefined ? { systemPrompt: shaping.systemPrompt } : {}),
  };
}

/** Session-creation inputs from a runtime factory call: replacement
 * inheritance (fork) outranks the spawn-time model — a resumed worker has no
 * spawn-time snapshot, and a forked branch may be too early (no messages) for
 * session-data restoration. */
export function inheritableSessionOptions(
  factoryOptions: Parameters<CreateAgentSessionRuntimeFactory>[0],
  spawnModel: SessionModel | undefined,
): Partial<
  Pick<CreateAgentSessionFromServicesOptions, "model" | "thinkingLevel" | "sessionStartEvent">
> {
  const inheritedModel = factoryOptions.model ?? spawnModel;
  return {
    ...(factoryOptions.sessionStartEvent !== undefined
      ? { sessionStartEvent: factoryOptions.sessionStartEvent }
      : {}),
    ...(inheritedModel !== undefined ? { model: inheritedModel } : {}),
    ...(factoryOptions.thinkingLevel !== undefined
      ? { thinkingLevel: factoryOptions.thinkingLevel }
      : {}),
  };
}
