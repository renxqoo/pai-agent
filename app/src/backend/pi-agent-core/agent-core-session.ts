/**
 * The pi-agent-core probe session (capability-packs plan W3): the P1
 * PaiSession face over one in-memory Agent. Chat subset only — capability-
 * off members are stubs that throw rather than silently misbehave (defense
 * in depth under the dispatcher capability gate).
 */

import { randomUUID } from "node:crypto";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
  PaiImage,
  PaiNavigateOptions,
  PaiPromptOptions,
  PaiSession,
} from "../ports/session.ts";

/** pi-ai user message with optional image content (wire ImagePayload). */
function userMessage(message: string, images?: ReadonlyArray<PaiImage>) {
  const content: Array<TextContent | ImageContent> = [{ type: "text", text: message }];
  for (const image of images ?? []) content.push(image);
  return { role: "user" as const, content, timestamp: Date.now() };
}

/** Capability-off member stub: reaching it means the gate was bypassed. */
export function unsupported(member: string): never {
  throw new Error(`pi-agent-core backend does not support ${member}`);
}

export class AgentCoreSession implements PaiSession {
  readonly sessionId: string;
  readonly sessionFile = undefined;
  private sessionNameValue: string | undefined;
  private readonly agent: Agent;

  constructor(agent: Agent) {
    this.sessionId = randomUUID();
    this.agent = agent;
  }

  get sessionName(): string | undefined {
    return this.sessionNameValue;
  }

  get model(): unknown {
    return this.agent.state.model;
  }

  get thinkingLevel(): unknown {
    return "off";
  }

  get isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  get isCompacting(): boolean {
    return false;
  }

  get messages(): ReadonlyArray<unknown> {
    return this.agent.state.messages;
  }

  get sessionManager(): PaiSession["sessionManager"] {
    return {
      getCwd: () => process.cwd(),
      getEntries: () => [],
      getLeafId: () => null,
      getTree: () => null,
    };
  }

  get extensionRunner(): PaiSession["extensionRunner"] {
    return {
      emitUserBash: async () => {},
      getRegisteredCommands: () => [],
    };
  }

  get promptTemplates(): ReadonlyArray<{ name: string; description?: string }> {
    return [];
  }

  get resourceLoader(): PaiSession["resourceLoader"] {
    return { getSkills: () => ({ skills: [] }) };
  }

  async prompt(message: string, options?: PaiPromptOptions): Promise<void> {
    const images = options?.images;
    if (options?.streamingBehavior === "steer") {
      this.agent.steer(userMessage(message, images));
      return;
    }
    if (options?.streamingBehavior === "followUp") {
      this.agent.followUp(userMessage(message, images));
      return;
    }
    if (this.agent.state.isStreaming) {
      throw new Error(
        'Session is streaming; prompt requires streamingBehavior "steer" or "followUp"',
      );
    }
    // Fire-and-accept (the preflight contract): validation above passed, so
    // the run is accepted; later failures ride the event stream.
    const run = this.agent.prompt(message, images as ImageContent[] | undefined);
    options?.preflightResult?.(true);
    return run;
  }

  steer(message: string, images?: ReadonlyArray<PaiImage>): Promise<unknown> {
    this.agent.steer(userMessage(message, images));
    return Promise.resolve();
  }

  followUp(message: string, images?: ReadonlyArray<PaiImage>): Promise<unknown> {
    this.agent.followUp(userMessage(message, images));
    return Promise.resolve();
  }

  abort(): Promise<unknown> {
    this.agent.abort();
    return Promise.resolve();
  }

  abortCompaction(): unknown {
    return unsupported("compaction");
  }

  compact(): Promise<unknown> {
    return unsupported("compaction");
  }

  clearQueue(): unknown {
    return unsupported("queue.clear");
  }

  setModel(): Promise<unknown> {
    return unsupported("set_model");
  }

  setThinkingLevel(): void {
    unsupported("thinking levels");
  }

  getAvailableThinkingLevels(): unknown {
    return [];
  }

  setSessionName(name: string): void {
    this.sessionNameValue = name;
  }

  getSessionStats(): unknown {
    return {
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      tokens: { total: 0 },
      cost: 0,
    };
  }

  navigateTree(_targetId: string, _options: PaiNavigateOptions): Promise<unknown> {
    return unsupported("navigate_tree");
  }

  getUserMessagesForForking(): unknown {
    return { messages: [] };
  }

  executeBash(): Promise<unknown> {
    return unsupported("bash.exec");
  }

  abortBash(): void {
    unsupported("bash.exec");
  }

  recordBashResult(): void {
    unsupported("bash.exec");
  }
}
