import { describe, expect, test } from "bun:test";
import {
  AgentCoreSessionHost,
  liftAgentEvent,
} from "../src/backend/pi-agent-core/session-adapter.ts";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import type { PaiEvent } from "../src/protocol.ts";

/** Structural fake agent: records calls, replays scripted events. */
function makeFakeAgent(script: { model?: unknown; streaming?: boolean } = {}) {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const calls: { prompt: string[]; steer: unknown[]; followUp: unknown[]; aborts: number } = {
    prompt: [],
    steer: [],
    followUp: [],
    aborts: 0,
  };
  const agent = {
    state: {
      model: script.model ?? { provider: "mock", id: "mock-main" },
      isStreaming: script.streaming ?? false,
      messages: [] as unknown[],
    },
    subscribe(listener: (event: AgentEvent) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
    async prompt(message: string): Promise<void> {
      calls.prompt.push(message);
    },
    steer(message: unknown): void {
      calls.steer.push(message);
    },
    followUp(message: unknown): void {
      calls.followUp.push(message);
    },
    abort(): void {
      calls.aborts += 1;
    },
    emit(event: AgentEvent): void {
      // Snapshot: a listener may unsubscribe mid-emit.
      for (const listener of Array.from(listeners)) listener(event);
    },
  } as unknown as Agent;
  return { agent, calls, emit: agent.emit };
}

describe("liftAgentEvent", () => {
  test("agent_end lifts with willRetry:false and synthesizes agent_settled after it", () => {
    const lifted = liftAgentEvent({ type: "agent_end", messages: [] });
    expect(lifted.length).toBe(2);
    expect(lifted[0]).toEqual({ type: "agent_end", messages: [], willRetry: false });
    expect(lifted[1]).toEqual({ type: "agent_settled" });
  });

  test("message_update is stripped by the shared port", () => {
    const [lifted] = liftAgentEvent({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "hi", partial: { big: true } },
    });
    expect(lifted).toEqual({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    });
  });

  test("other members pass through unchanged", () => {
    const event = { type: "turn_start" } as AgentEvent;
    expect(liftAgentEvent(event)).toEqual([event]);
  });
});

describe("AgentCoreSessionHost", () => {
  test("start wires the subscription; events emit with the session id and lift", async () => {
    const fake = makeFakeAgent();
    const frames: Array<{ type: "event"; threadId: string; event: PaiEvent }> = [];
    const host = new AgentCoreSessionHost({
      createAgent: () => fake.agent,
      emit: (frame) => frames.push(frame),
      writeStderr: () => {},
    });
    const thread = await host.start({ cwd: "/tmp", trusted: false });
    const tid = thread.session.sessionId;
    expect(host.threadId()).toBe(tid);

    fake.emit({ type: "agent_start" });
    fake.emit({ type: "agent_end", messages: [] });
    expect(frames.map((f) => f.event.type)).toEqual(["agent_start", "agent_end", "agent_settled"]);
    expect(frames.every((f) => f.type === "event" && f.threadId === tid)).toBeTrue();

    await host.stop();
    expect(host.get()).toBeUndefined();
    expect(host.threadId()).toBe("");
    // Stop unsubscribed: a late event does not emit.
    frames.length = 0;
    fake.emit({ type: "agent_start" });
    expect(frames.length).toBe(0);
  });

  test("prompt during streaming without streamingBehavior fails like the contract", async () => {
    const fake = makeFakeAgent({ streaming: true });
    const host = new AgentCoreSessionHost({
      createAgent: () => fake.agent,
      emit: () => {},
      writeStderr: () => {},
    });
    const thread = await host.start({ cwd: "/tmp", trusted: false });
    await expect(thread.session.prompt("hello")).rejects.toThrow("streamingBehavior");
    expect(fake.calls.prompt.length).toBe(0);
  });

  test("prompt accepts and fires preflight; steer/followUp behaviors queue", async () => {
    const fake = makeFakeAgent();
    const host = new AgentCoreSessionHost({
      createAgent: () => fake.agent,
      emit: () => {},
      writeStderr: () => {},
    });
    const thread = await host.start({ cwd: "/tmp", trusted: false });
    let accepted: boolean | undefined;
    await thread.session.prompt("hello", { preflightResult: (ok) => (accepted = ok) });
    expect(accepted).toBeTrue();
    expect(fake.calls.prompt).toEqual(["hello"]);

    await thread.session.prompt("mid", { streamingBehavior: "steer" });
    expect(fake.calls.steer.length).toBe(1);
    await thread.session.prompt("later", { streamingBehavior: "followUp" });
    expect(fake.calls.followUp.length).toBe(1);
    expect(fake.calls.prompt.length).toBe(1);
  });

  test("stop aborts the agent and is idempotent", async () => {
    const fake = makeFakeAgent();
    const host = new AgentCoreSessionHost({
      createAgent: () => fake.agent,
      emit: () => {},
      writeStderr: () => {},
    });
    await host.start({ cwd: "/tmp", trusted: false });
    await host.stop();
    await host.stop();
    expect(fake.calls.aborts).toBe(1);
  });

  test("double start rejects with the one-session contract wording", async () => {
    const fake = makeFakeAgent();
    const host = new AgentCoreSessionHost({
      createAgent: () => fake.agent,
      emit: () => {},
      writeStderr: () => {},
    });
    await host.start({ cwd: "/tmp", trusted: false });
    await expect(host.start({ cwd: "/tmp", trusted: false })).rejects.toThrow(
      "one session per worker",
    );
  });
});
