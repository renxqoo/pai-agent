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
}

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
    if (options.signal?.aborted) return Promise.resolve(undefined);

    const requestId = randomUUID();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const signal = options.signal;

      const settle = (result: DialogPayload | undefined): void => {
        if (signal) signal.removeEventListener("abort", onAbort);
        if (timer !== undefined) clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(result);
      };
      const onAbort = (): void => settle(undefined);

      signal?.addEventListener("abort", onAbort, { once: true });
      timer =
        options.timeout !== undefined
          ? setTimeout(() => settle(undefined), options.timeout)
          : undefined;

      this.pending.set(requestId, { threadId, settle });
      this.emitRequest({ type: "ui_request", requestId, threadId, ...payload });
    });
  }

  /** Deliver a client answer. Returns false for unknown (late) requestIds. */
  resolve(requestId: string, payload: DialogPayload): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    entry.settle(payload);
    return true;
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
