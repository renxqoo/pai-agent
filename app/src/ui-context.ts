/**
 * ExtensionUIContext factory: extension dialogs become ui_request frames via
 * the DialogBroker; TUI-only members degrade to no-ops (same strategy as pi's
 * built-in RPC mode). All boilerplate lives here so threads.ts stays thin.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { DialogAskOptions, DialogBroker, DialogRequest } from "./dialogs.ts";
import type { HubFrame, UiRequestFrame } from "./protocol.ts";

interface FireAndForget {
  method: "notify" | "setStatus";
  fields: Record<string, unknown>;
}

export function createUiContext(
  threadId: string,
  broker: DialogBroker,
  emit: (frame: HubFrame) => void,
): ExtensionUIContext {
  function askDialog<T>(
    payload: DialogRequest,
    options: DialogAskOptions | undefined,
    defaultValue: T,
    parse: (response: Record<string, unknown>) => T,
  ): Promise<T> {
    if (options?.signal?.aborted) return Promise.resolve(defaultValue);
    return broker
      .ask(threadId, payload, {
        signal: options?.signal,
        timeout: options?.timeout,
      })
      .then((response) => {
        if (!response || response.cancelled === true) return defaultValue;
        return parse(response);
      });
  }

  function fireAndForget({ method, fields }: FireAndForget): void {
    const frame: UiRequestFrame = {
      type: "ui_request",
      requestId: randomUUID(),
      threadId,
      method,
      ...fields,
    };
    emit(frame);
  }

  return {
    select: (title, optionList, options) =>
      askDialog({ method: "select", title, options: optionList }, options, undefined, (response) =>
        typeof response.value === "string" ? response.value : undefined,
      ),

    confirm: (title, message, options) =>
      askDialog(
        { method: "confirm", title, message },
        options,
        false,
        (response) => response.confirmed === true,
      ),

    input: (title, placeholder, options) =>
      askDialog({ method: "input", title, placeholder }, options, undefined, (response) =>
        typeof response.value === "string" ? response.value : undefined,
      ),

    editor: (title, prefill) =>
      askDialog({ method: "editor", title, prefill }, undefined, undefined, (response) =>
        typeof response.value === "string" ? response.value : undefined,
      ),

    notify: (message, notifyType): void => {
      fireAndForget({ method: "notify", fields: { message, notifyType } });
    },

    onTerminalInput: () => () => {},

    setStatus: (key, text): void => {
      fireAndForget({ method: "setStatus", fields: { statusKey: key, statusText: text } });
    },

    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},

    setTitle(title): void {
      fireAndForget({ method: "setStatus", fields: { statusKey: "__title", statusText: title } });
    },

    custom: async () => undefined as never,

    setEditorText(text): void {
      fireAndForget({
        method: "setStatus",
        fields: { statusKey: "__editor_text", statusText: text },
      });
    },
    pasteToEditor(text): void {
      fireAndForget({
        method: "setStatus",
        fields: { statusKey: "__editor_text", statusText: text },
      });
    },
    getEditorText: () => "",

    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,

    get theme() {
      return { name: "dark" } as never;
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching not supported by pai-cli" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}
