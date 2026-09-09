/**
 * The pi-agent-core probe session (capability-packs plan W3): one in-memory
 * Agent per conversation, lifted onto the P1 port face. Chat subset only —
 * fork/clone/compaction/bash/subagents are capability-gated off upstream of
 * these stubs; every stub throws rather than silently misbehaving (defense
 * in depth under the dispatcher's capability gate).
 *
 * Event lift (R2): pi-agent-core's AgentEvent names are already inside the
 * pai vocabulary; message_update is stripped by the shared port; agent_end
 * gains willRetry:false; agent_settled is synthesized after each agent_end
 * (probe fidelity note: with a queued followUp the settled fires per run,
 * not per drain — coding-agent drains first).
 */

import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import { AgentCoreSession, unsupported } from "./agent-core-session.ts";
import { stripCumulativeSnapshot } from "../ports/event-strip.ts";
import type { PaiEvent, SessionModel } from "../../protocol.ts";
import type { PaiSessionHost, PaiSandboxState, PaiThread, SpawnShaping } from "../ports/session.ts";

const DISABLED_SANDBOX: PaiSandboxState = {
  snapshot: {
    config: {
      enabled: false,
      onViolation: "deny",
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {},
    },
    source: "global",
  },
  runtime: { active: false },
  exemptions: { writePaths: new Set<string>(), bashCommands: new Set<string>() },
};

/** Lift one native AgentEvent into wire events (settled synthesized). */
export function liftAgentEvent(event: AgentEvent): PaiEvent[] {
  if (event.type === "agent_end") {
    return [{ ...event, willRetry: false } as PaiEvent, { type: "agent_settled" }];
  }
  return [stripCumulativeSnapshot(event) as PaiEvent];
}

/** The P1 host face for the probe: one in-memory session per worker. */
export class AgentCoreSessionHost implements PaiSessionHost {
  private thread: PaiThread | undefined;
  private unsubscribe: () => void = () => {};
  private readonly createAgent: (model: SessionModel | undefined, cwd: string) => Agent;
  private readonly emit: (frame: { type: "event"; threadId: string; event: PaiEvent }) => void;
  private readonly writeStderr: (text: string) => void;

  constructor(deps: {
    createAgent: (model: SessionModel | undefined, cwd: string) => Agent;
    emit: (frame: { type: "event"; threadId: string; event: PaiEvent }) => void;
    writeStderr: (text: string) => void;
  }) {
    this.createAgent = deps.createAgent;
    this.emit = deps.emit;
    this.writeStderr = deps.writeStderr;
  }

  get(): PaiThread | undefined {
    return this.thread;
  }

  threadId(): string {
    return this.thread?.session.sessionId ?? "";
  }

  getInjectedRules(): undefined {
    return undefined;
  }

  getSandboxState(): PaiSandboxState {
    return DISABLED_SANDBOX;
  }

  async start(options: {
    cwd: string;
    trusted: boolean;
    model?: SessionModel;
    shaping?: SpawnShaping;
  }): Promise<PaiThread> {
    if (this.thread !== undefined) {
      throw new Error("Worker already hosts a conversation; one session per worker process");
    }
    const agent = this.createAgent(options.model, options.cwd);
    const session = new AgentCoreSession(agent);
    const thread: PaiThread = { session, cwd: options.cwd, sessionPath: undefined };
    this.unsubscribe = agent.subscribe((event: AgentEvent) => {
      for (const lifted of liftAgentEvent(event)) {
        this.emit({ type: "event", threadId: session.sessionId, event: lifted });
      }
    });
    this.thread = thread;
    return thread;
  }

  resume(): Promise<PaiThread> {
    return unsupported("session.resume");
  }

  fork(): Promise<never> {
    return unsupported("session.fork");
  }

  clone(): Promise<never> {
    return unsupported("session.clone");
  }

  async stop(): Promise<void> {
    const { thread } = this;
    if (!thread) return;
    this.thread = undefined;
    this.unsubscribe();
    thread.session.abort().catch((error: unknown) => {
      this.writeStderr(`pi-agent-core abort during stop failed: ${String(error)}\n`);
    });
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}
