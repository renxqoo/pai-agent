/**
 * Shared env-knob parsing: a positive finite integer or the fallback. Bad or
 * missing values never throw — callers degrade to defaults.
 */
export function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Like readIntEnv but `0` is a legal explicit value (e.g. "disable the
 * bash wall clock"), so only negative/non-numeric input falls back. */
export function readNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
