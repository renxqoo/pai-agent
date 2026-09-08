/**
 * Wire event stripping (design.md v0.1 §frames, v0.8 vocabulary): streaming
 * events carry cumulative snapshots (the message plus the partial assistant
 * message inside each delta) that must be stripped before serialization —
 * frame size stays constant per delta or long replies amplify to quadratic
 * wire traffic. Top-level usage is kept. Non-message_update events pass
 * through by reference (zero-copy; performance budget 1). Single truth for
 * every backend's wire lift (coding-agent adapter, grandchild relay,
 * agent-core lift).
 */

interface StrippableEvent {
  type?: unknown;
  message?: unknown;
  assistantMessageEvent?: { partial?: unknown } & Record<string, unknown>;
}

/** Strip the cumulative snapshot of one message_update event. */
export function stripCumulativeSnapshot<T extends object>(event: T): T {
  const shaped = event as StrippableEvent;
  if (shaped.type !== "message_update") return event;
  const { message: _message, assistantMessageEvent, ...rest } = shaped;
  if (assistantMessageEvent === undefined) {
    return rest as T;
  }
  const { partial: _partial, ...delta } = assistantMessageEvent;
  return { ...rest, assistantMessageEvent: delta } as T;
}
