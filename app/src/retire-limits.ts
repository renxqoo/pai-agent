/**
 * Retire-threshold policy (one verb, one file): defaults, env knobs, and the
 * runtime clamps behind set_idle_retire_ms / set_rss_retire_bytes. Pure —
 * the pool applies them; table tests drive the clamps directly.
 */

import { readIntEnv, readNonNegativeIntEnv } from "./int-env.ts";

export const IDLE_RETIRE_MS_DEFAULT = 900_000;
/** RSS hard cap (set_rss_retire_bytes): 0 = disabled (opt-in — retiring a
 * BUSY worker mid-turn is destructive, so the cap never defaults on). */
export const RSS_RETIRE_BYTES_DEFAULT = 0;
/** Clamp window: a cap below a bun worker's baseline RSS would retire every
 * respawn instantly (resume → retire loop); 2 TiB is far past sane. */
export const RSS_RETIRE_BYTES_MIN = 256 * 1024 * 1024;
export const RSS_RETIRE_BYTES_MAX = 2 * 1024 ** 4;

/** set_idle_retire_ms: clamp to [1s, 24h]; garbage falls back to the default. */
export function clampIdleRetireMs(ms: number): number {
  return Number.isFinite(ms)
    ? Math.min(86_400_000, Math.max(1_000, Math.round(ms)))
    : IDLE_RETIRE_MS_DEFAULT;
}

/** set_rss_retire_bytes: 0 disables; otherwise clamp to
 * [RSS_RETIRE_BYTES_MIN, RSS_RETIRE_BYTES_MAX]; garbage falls back to the
 * default (disabled). */
export function clampRssRetireBytes(bytes: number): number {
  return Number.isFinite(bytes) && bytes > 0
    ? Math.min(RSS_RETIRE_BYTES_MAX, Math.max(RSS_RETIRE_BYTES_MIN, Math.round(bytes)))
    : RSS_RETIRE_BYTES_DEFAULT;
}

/** The env-knob baseline the pool constructor reads (PAI_IDLE_RETIRE_MS /
 * PAI_RSS_RETIRE_BYTES; 0 is a legal explicit "off" for the RSS cap). */
export function retireLimitsFromEnv(): { idleRetireMs: number; rssRetireBytes: number } {
  return {
    idleRetireMs: readIntEnv("PAI_IDLE_RETIRE_MS", IDLE_RETIRE_MS_DEFAULT),
    // The env value passes through the SAME clamp as the runtime command:
    // a hostile/typo'd knob (PAI_RSS_RETIRE_BYTES=1) must never produce a
    // retire-everything death loop just because it came from the environment.
    rssRetireBytes: clampRssRetireBytes(
      readNonNegativeIntEnv("PAI_RSS_RETIRE_BYTES", RSS_RETIRE_BYTES_DEFAULT),
    ),
  };
}
