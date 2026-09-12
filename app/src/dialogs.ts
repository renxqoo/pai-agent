/**
 * Dialog broker: correlates ui_request frames with ui_response commands by
 * requestId. Contract (design.md): each dialog settles exactly once — via
 * response, timeout, or abort signal — with the default (undefined) for the
 * latter two; late responses are ignored.
 */

import { randomUUID } from "node:crypto";
import type { UiRequestFrame } from "./protocol.ts";

export interface DialogAskOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export type DialogPayload = Record<string, unknown>;

/** Dialog request fields (method plus payload), spread into a ui_request frame. */
export interface DialogRequest {
  method: string;
  [key: string]: unknown;
}

interface PendingDialog {
  threadId: string;
  settle: (payload: DialogPayload | undefined) => void;
  /** v0.14: the request payload as sent on the wire — retained so a client
   * that reloaded mid-dialog can rebuild the prompt (get_pending_dialogs). */
  request: DialogRequest;
}

/** Frame headers are owned by the broker; a payload key with these names must
 * never override them (ui_request shape integrity, incl. the v0.14 rebuild
 * path where get_pending_dialogs re-spreads the retained payload). */
const RESERVED_FRAME_KEYS: ReadonlySet<string> = new Set(["type", "requestId", "threadId"]);

export class DialogBroker {
  private readonly pending = new Map<string, PendingDialog>();
  private readonly emitRequest: (frame: UiRequestFrame) => void;

  constructor(emitRequest: (frame: UiRequestFrame) => void) {
    this.emitRequest = emitRequest;
  }

  ask(
    threadId: string,
    payload: DialogRequest,
    options: DialogAskOptions,
  ): Promise<DialogPayload | undefined> {
    // The explicit undefined pins the resolved type to DialogPayload | undefined.
    // eslint-disable-next-line unicorn/no-useless-undefined
    if (options.signal?.aborted) return Promise.resolve(undefined);

    const requestId = randomUUID();
    const request: DialogRequest = { method: payload.method };
    for (const [key, value] of Object.entries(payload)) {
      // Assignment form would route an own `__proto__` key through the
      // prototype setter and pollute the retained request object.
      if (key !== "method" && key !== "__proto__" && !RESERVED_FRAME_KEYS.has(key)) {
        request[key] = value;
      }
    }
    return new Promise((resolve) => {
      const timerRef: { value?: ReturnType<typeof setTimeout> } = {};
      const { signal } = options;

      const settle = (result: DialogPayload | undefined): void => {
        if (signal) signal.removeEventListener("abort", onAbort);
        if (timerRef.value !== undefined) clearTimeout(timerRef.value);
        this.pending.delete(requestId);
        resolve(result);
      };
      const onAbort = (): void => settle(undefined);

      signal?.addEventListener("abort", onAbort, { once: true });
      timerRef.value =
        options.timeout !== undefined
          ? setTimeout(() => settle(undefined), options.timeout)
          : undefined;

      this.pending.set(requestId, { threadId, settle, request });
      this.emitRequest({ type: "ui_request", requestId, threadId, ...request });
    });
  }

  /** Deliver a client answer. Returns false for unknown (late) requestIds. */
  resolve(requestId: string, payload: DialogPayload): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    entry.settle(payload);
    return true;
  }

  /** v0.14: unsettled dialogs, in ask order (reload convergence). Worker-scoped
   * on purpose: a worker hosts one conversation, and dialogs raised by its
   * subagents register under the grandchild's own threadId. */
  pendingAll(): Array<{ requestId: string; threadId: string; request: DialogRequest }> {
    const out: Array<{ requestId: string; threadId: string; request: DialogRequest }> = [];
    for (const [requestId, entry] of this.pending) {
      out.push({ requestId, threadId: entry.threadId, request: entry.request });
    }
    return out;
  }

  /** Number of unsettled dialogs (worker idle computation). */
  pendingCount(): number {
    return this.pending.size;
  }

  /** Settle every dialog of a thread with the default; called on thread/stop. */
  settleThread(threadId: string): void {
    for (const entry of Array.from(this.pending.values())) {
      if (entry.threadId === threadId) entry.settle(undefined);
    }
  }

  /** Settle every pending dialog with the default; used on shutdown. */
  settleAll(): void {
    for (const entry of Array.from(this.pending.values())) entry.settle(undefined);
  }
}
