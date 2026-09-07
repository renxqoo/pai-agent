/**
 * Response frame builders shared by host and worker. They live at module
 * level (pure) because the host<->worker strict head match relies on these
 * literals serializing with id/type first; the worker-pool unit test asserts
 * the real output.
 */

import type { ResponseFrame } from "./protocol.ts";

export function responseSuccess(
  id: string | undefined,
  command: string,
  data?: unknown,
): ResponseFrame {
  return {
    id,
    type: "response",
    command,
    success: true,
    ...(data !== undefined ? { data } : {}),
  };
}

export function responseFailure(
  id: string | undefined,
  command: string,
  error: string,
): ResponseFrame {
  return { id, type: "response", command, success: false, error };
}
