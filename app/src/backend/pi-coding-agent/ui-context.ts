/**
 * ExtensionUIContext factory: extension dialogs become ui_request frames via
 * the DialogBroker; TUI-only members degrade to no-ops (same strategy as pi's
 * built-in RPC mode). Dialog members live in createDialogMembers, the
 * capture-free TUI no-ops in TUI_NOOPS.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { DialogAskOptions, DialogBroker, DialogRequest } from "../../dialogs.ts";
import type { HubFrame, UiRequestFrame } from "../../protocol.ts";

interface FireAndForget {
  method: "notify" | "setStatus";
  fields: Record<string, unknown>;
}

interface DialogDeps {
  threadId: string;
  broker: DialogBroker;
  emit: (frame: HubFrame) => void;
}

function askDialog<T>(
  deps: DialogDeps,
  request: { payload: DialogRequest; options: DialogAskOptions | undefined },
  result: { defaultValue: T; parse: (response: Record<string, unknown>) => T },
): Promise<T> {
  const { payload, options } = request;
  const { defaultValue, parse } = result;
  if (options?.signal?.aborted) return Promise.resolve(defaultValue);
  return deps.broker
    .ask(deps.threadId, payload, {
      signal: options?.signal,
      timeout: options?.timeout,
    })
    .then((response) => {
      if (!response || response.cancelled === true) return defaultValue;
      return parse(response);
    });
}

function fireAndForget(deps: DialogDeps, { method, fields }: FireAndForget): void {
  const frame: UiRequestFrame = {
    type: "ui_request",
    requestId: randomUUID(),
    threadId: deps.threadId,
    method,
    ...fields,
  };
  deps.emit(frame);
}

function statusUpdate(deps: DialogDeps, statusKey: string, statusText: string): void {
  fireAndForget(deps, { method: "setStatus", fields: { statusKey, statusText } });
}

function createDialogMembers(deps: DialogDeps) {
  return {
    select: (title: string, optionList: unknown, options: DialogAskOptions | undefined) =>
      askDialog(
        deps,
        { payload: { method: "select", title, options: optionList }, options },
        {
          defaultValue: undefined,
          parse: (response) => (typeof response.value === "string" ? response.value : undefined),
        },
      ),

    confirm: (title: string, message: string, options: DialogAskOptions | undefined) =>
      askDialog(
        deps,
        { payload: { method: "confirm", title, message }, options },
        { defaultValue: false, parse: (response) => response.confirmed === true },
      ),

    input: (title: string, placeholder: string, options: DialogAskOptions | undefined) =>
      askDialog(
        deps,
        { payload: { method: "input", title, placeholder }, options },
        {
          defaultValue: undefined,
          parse: (response) => (typeof response.value === "string" ? response.value : undefined),
        },
      ),

    editor: (title: string, prefill: string) =>
      askDialog(
        deps,
        { payload: { method: "editor", title, prefill }, options: undefined },
        {
          defaultValue: undefined,
          parse: (response) => (typeof response.value === "string" ? response.value : undefined),
        },
      ),
  };
}

/** TUI-only members that capture nothing: safe to share across threads. */
const TUI_NOOPS = {
  onTerminalInput: () => () => {},
  setWorkingMessage: () => {},
  setWorkingVisible: () => {},
  setWorkingIndicator: () => {},
  setHiddenThinkingLabel: () => {},
  setWidget: () => {},
  setFooter: () => {},
  setHeader: () => {},
  addAutocompleteProvider: () => {},
  setEditorComponent: () => {},
  getEditorComponent(): ReturnType<ExtensionUIContext["getEditorComponent"]> {
    return undefined;
  },
  getAllThemes: () => [],
  getTheme(): ReturnType<ExtensionUIContext["getTheme"]> {
    return undefined;
  },
  setTheme: () => ({ success: false, error: "Theme switching not supported by pai-cli" }),
  getToolsExpanded: () => false,
  setToolsExpanded: () => {},
};

export function createUiContext(
  threadId: string,
  broker: DialogBroker,
  emit: (frame: HubFrame) => void,
): ExtensionUIContext {
  const deps: DialogDeps = { threadId, broker, emit };
  return {
    ...TUI_NOOPS,
    ...createDialogMembers(deps),

    notify: (message: string, notifyType: unknown): void => {
      fireAndForget(deps, { method: "notify", fields: { message, notifyType } });
    },

    setStatus: (key: string, text: string): void => {
      statusUpdate(deps, key, text);
    },

    setTitle(title: string): void {
      statusUpdate(deps, "__title", title);
    },

    custom: async () => undefined as never,

    setEditorText(text: string): void {
      statusUpdate(deps, "__editor_text", text);
    },
    pasteToEditor(text: string): void {
      statusUpdate(deps, "__editor_text", text);
    },
    getEditorText: () => "",

    get theme() {
      return { name: "dark" } as never;
    },
  };
}
