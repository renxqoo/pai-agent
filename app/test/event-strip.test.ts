import { describe, expect, test } from "bun:test";
import { stripCumulativeSnapshot } from "../src/backend/ports/event-strip.ts";

describe("stripCumulativeSnapshot", () => {
  test("message_update drops the top-level message and the delta partial", () => {
    const stripped = stripCumulativeSnapshot({
      type: "message_update",
      message: { role: "assistant", content: "cumulative snapshot" },
      assistantMessageEvent: { type: "text_delta", delta: "hi", partial: { big: true } },
      usage: { input: 1 },
    });
    expect(stripped).toEqual({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
      usage: { input: 1 },
    });
  });

  test("message_update without an assistantMessageEvent drops the message only", () => {
    const stripped = stripCumulativeSnapshot({
      type: "message_update",
      message: { role: "assistant" },
      usage: { input: 2 },
    });
    expect(stripped).toEqual({ type: "message_update", usage: { input: 2 } });
  });

  test("non-message_update events pass through by reference (zero copy)", () => {
    const event = { type: "agent_settled" };
    expect(stripCumulativeSnapshot(event)).toBe(event);
    const rich = { type: "message_end", message: { role: "assistant" } };
    expect(stripCumulativeSnapshot(rich)).toBe(rich);
  });

  test("future unknown members pass through by reference (passthrough invariant)", () => {
    const unknown = { type: "some_future_event", payload: { x: 1 } };
    expect(stripCumulativeSnapshot(unknown)).toBe(unknown);
  });
});
