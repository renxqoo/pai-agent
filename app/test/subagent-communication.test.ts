import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  COMM_MESSAGE_CAP,
  COMM_TEXT_CAP_BYTES,
  createSubagentCommunicationExtension,
} from "../src/subagent-communication.ts";
import type { SubagentMessageFrame } from "../src/protocol.ts";

/**
 * Depth-1 communication tools (plan stages 8/9): frame shape, shared
 * report+send budget, 8KB text cap, self-send rejection. The parent-side
 * re-checks (registry queueMessage) have their own tests.
 */

/** Narrowed execute view: the trailing SDK arguments are unused here. */
type ExecFn = (
  toolCallId: string,
  params: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

interface RegisteredTool {
  execute: ExecFn;
}

function makeExtension(): {
  tools: Map<string, RegisteredTool>;
  frames: SubagentMessageFrame[];
} {
  const tools = new Map<string, RegisteredTool>();
  const frames: SubagentMessageFrame[] = [];
  const pi = {
    registerTool: (def: RegisteredTool & { name: string }) => {
      tools.set(def.name, def);
    },
  } as unknown as ExtensionAPI;
  createSubagentCommunicationExtension({
    emit: (frame) => {
      frames.push(frame);
    },
    getThreadId: () => "g-sess-9",
    subagentId: "sub_self00",
    agentName: "echoer",
  })(pi);
  return { tools, frames };
}

async function run(
  tools: Map<string, RegisteredTool>,
  name: string,
  params: Record<string, unknown>,
): Promise<{ text: string; isError: boolean | undefined }> {
  const def = tools.get(name);
  if (def === undefined) throw new Error(`tool ${name} not registered`);
  const result = await def.execute("c-1", params);
  const [first] = result.content;
  return {
    text: first !== undefined && first.type === "text" ? (first.text ?? "") : "",
    isError: result.isError,
  };
}

describe("depth-1 communication tools (stages 8/9)", () => {
  test("report emits an enveloped frame with advisory identity", async () => {
    const { tools, frames } = makeExtension();
    const r = await run(tools, "report", { text: "found the flaky test" });
    expect(r.isError).toBeUndefined();
    expect(frames).toEqual([
      {
        type: "subagent_message",
        threadId: "g-sess-9",
        subagentId: "sub_self00",
        agent: "echoer",
        text: "found the flaky test",
      },
    ]);
  });

  test("send carries the target; self-send is rejected", async () => {
    const { tools, frames } = makeExtension();
    const ok = await run(tools, "send", { to: "sub_sib001", text: "handoff" });
    expect(ok.isError).toBeUndefined();
    expect(frames[0]).toMatchObject({ to: "sub_sib001", text: "handoff" });
    const self = await run(tools, "send", { to: "sub_self00", text: "hi me" });
    expect(self.isError).toBe(true);
    expect(self.text).toContain("cannot send to yourself");
    expect(frames.length).toBe(1); // the self-send emitted nothing
  });

  test("report and send share one budget: the 11th call errors", async () => {
    const { tools, frames } = makeExtension();
    for (let i = 0; i < COMM_MESSAGE_CAP; i++) {
      const params = i % 2 === 0 ? { text: `m${i}` } : { to: "sub_sib001", text: `m${i}` };
      const r = await run(tools, i % 2 === 0 ? "report" : "send", params);
      expect(r.isError).toBeUndefined();
    }
    expect(frames.length).toBe(COMM_MESSAGE_CAP);
    const over = await run(tools, "report", { text: "one too many" });
    expect(over.isError).toBe(true);
    expect(over.text).toContain("message budget exhausted");
    expect(frames.length).toBe(COMM_MESSAGE_CAP);
  });

  test("oversized text is byte-capped with a truncation marker", async () => {
    const { tools, frames } = makeExtension();
    const big = "é".repeat(COMM_TEXT_CAP_BYTES); // 2 bytes per char
    const r = await run(tools, "report", { text: big });
    expect(r.isError).toBeUndefined();
    const [frame] = frames;
    if (frame === undefined) throw new Error("no frame");
    expect(Buffer.byteLength(frame.text, "utf8")).toBeLessThanOrEqual(
      COMM_TEXT_CAP_BYTES + 64, // truncation marker overhead
    );
    expect(frame.text).toContain("message truncated to 8KB");
    // No replacement characters from slicing a multi-byte boundary.
    expect(frame.text.includes("\uFFFD")).toBe(false);
  });

  test("empty text is rejected without emitting", async () => {
    const { tools, frames } = makeExtension();
    const empty = await run(tools, "report", { text: "" });
    expect(empty.isError).toBe(true);
    expect(frames.length).toBe(0);
  });
});
