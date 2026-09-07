/**
 * Depth-1 inter-agent communication tools (plan stages 8/9): `report` and
 * `send` exist ONLY inside grandchild sessions (shaping.subagent). Each call
 * emits one subagent_message frame to the parent worker — the identity in
 * the frame is advisory only; the parent re-stamps it from its registry.
 * Budgets mirror the parent side: 10 messages per task (report+send
 * combined), 8KB per text; the parent re-checks both (never trust the
 * grandchild's own accounting). These tools never derive tasks: the task
 * tool does not exist inside a grandchild (depth 1).
 */

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SubagentMessageFrame } from "./protocol.ts";

/** Combined per-task cap; must match MAX_MESSAGES_PER_TASK in the registry. */
export const COMM_MESSAGE_CAP = 10;
/** Per-message text cap; must match NOTIFY_OUTPUT_CAP_BYTES in the registry. */
export const COMM_TEXT_CAP_BYTES = 8 * 1024;

export interface CommunicationDeps {
  emit: (frame: SubagentMessageFrame) => void;
  /** The grandchild's own session id (frame threadId before the parent re-stamps). */
  getThreadId: () => string;
  subagentId: string;
  agentName: string;
}

function capText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= COMM_TEXT_CAP_BYTES) return text;
  let sliced = text.slice(0, COMM_TEXT_CAP_BYTES);
  while (Buffer.byteLength(sliced, "utf8") > COMM_TEXT_CAP_BYTES) {
    sliced = sliced.slice(0, -1);
  }
  return `${sliced}\n[message truncated to 8KB]`;
}

function textResult(
  text: string,
  isError?: boolean,
): { content: Array<{ type: "text"; text: string }>; details: undefined; isError?: boolean } {
  return {
    content: [{ type: "text", text }],
    details: undefined,
    ...(isError !== undefined ? { isError } : {}),
  };
}

/** Shared per-spawn budget + emit plumbing (fresh budget per task). */
interface BudgetedChannel {
  /** Called after a successful emit; returns nothing. */
  count: () => void;
  budget: () => string | undefined;
  emitFrame: (text: string, to?: string) => void;
}

function registerReport(pi: ExtensionAPI, deps: CommunicationDeps, channel: BudgetedChannel): void {
  pi.registerTool({
    name: "report",
    label: "Report",
    description:
      "Send a progress finding or partial result to the lead agent while you keep working (for final results, just finish the task). Use sparingly: the total budget across report and send is 10 messages.",
    parameters: Type.Object({
      text: Type.String({ description: "Message for the lead agent (max 8KB)" }),
    }),
    async execute(_toolCallId, params) {
      const { text } = params as { text: string };
      if (typeof text !== "string" || text.length === 0) {
        return textResult("report requires non-empty text", true);
      }
      const exhausted = channel.budget();
      if (exhausted !== undefined) return textResult(exhausted, true);
      channel.emitFrame(capText(text));
      channel.count();
      return textResult("reported to the lead agent");
    },
  });
}

function registerSend(pi: ExtensionAPI, deps: CommunicationDeps, channel: BudgetedChannel): void {
  pi.registerTool({
    name: "send",
    label: "Send",
    description:
      "Send a message to a SIBLING subagent of the same lead (by subagentId) — for example to hand off a file or coordinate. The lead relays it; delivery is not guaranteed if the sibling already finished. Budget: 10 messages total across report and send.",
    parameters: Type.Object({
      to: Type.String({ description: "Target sibling subagentId (sub_…)" }),
      text: Type.String({ description: "Message for the sibling (max 8KB)" }),
    }),
    async execute(_toolCallId, params) {
      const { to, text } = params as { to: string; text: string };
      if (typeof to !== "string" || typeof text !== "string" || text.length === 0) {
        return textResult("send requires non-empty to and text", true);
      }
      if (to === deps.subagentId) {
        return textResult("cannot send to yourself", true);
      }
      const exhausted = channel.budget();
      if (exhausted !== undefined) return textResult(exhausted, true);
      channel.emitFrame(capText(text), to);
      channel.count();
      return textResult(`sent to ${to} via the lead agent`);
    },
  });
}

/** Register report/send for one grandchild spawn (fresh budget per task). */
export function createSubagentCommunicationExtension(deps: CommunicationDeps): InlineExtension {
  return (pi: ExtensionAPI): void => {
    const counter = { sent: 0 };
    const channel: BudgetedChannel = {
      count: (): void => {
        counter.sent += 1;
      },
      budget: (): string | undefined =>
        counter.sent >= COMM_MESSAGE_CAP
          ? `message budget exhausted (${COMM_MESSAGE_CAP} messages per task)`
          : undefined,
      emitFrame: (text: string, to?: string): void => {
        deps.emit({
          type: "subagent_message",
          threadId: deps.getThreadId(),
          subagentId: deps.subagentId,
          agent: deps.agentName,
          text,
          ...(to !== undefined ? { to } : {}),
        });
      },
    };
    registerReport(pi, deps, channel);
    registerSend(pi, deps, channel);
  };
}
