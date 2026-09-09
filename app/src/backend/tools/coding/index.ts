/**
 * The coding toolset for non-extension backends (capability-packs follow-up):
 * pi-agent-core's four harness tool factories (bash/read/write/edit), adapted
 * onto the bare Agent's AgentTool face with a NodeExecutionEnv bound to the
 * conversation cwd, plus the beforeToolCall permission gate (decision logic
 * shared with the default backend via rules.decide; ask goes to the host
 * dialog broker). The harness tools' chord Context is satisfied with
 * BACKGROUND_CONTEXT + the Agent's abort signal.
 */

import {
  type AgentHarnessToolInvocation,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentTool,
  type AgentToolResult,
  type AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  BACKGROUND_CONTEXT,
  type Context,
  withAbortSignal,
} from "@earendil-works/pi-agent-core/harness/context";
import type { JsonValue } from "@earendil-works/chord";
import type { Static, TSchema } from "typebox";
import type { ToolPermissionGate } from "./permission-gate.ts";

/** The harness tool face the four factories produce (structural; the
 * invocation parameter is unused by all four tools). */
interface HarnessToolFace<TParameters extends TSchema, TDetails> {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  // eslint-disable-next-line max-params -- mirrors the upstream harness signature
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    onUpdate: AgentToolUpdateCallback<TDetails>,
    toolContext: { env: NodeExecutionEnv },
    invocation: AgentHarnessToolInvocation,
    context: Context,
  ) => Promise<AgentToolResult<TDetails>>;
}

/** The four coding tools never read the invocation face (durable replay
 * memos are a harness-runtime concern); this stub only satisfies the
 * harness signature outside AgentHarness. */
function unusedInvocation(): AgentHarnessToolInvocation {
  return {
    invocationId: "pai-coding-shim",
    operationId: "pai-coding-shim",
    turnId: "pai-coding-shim",
    getMemo: async () => null as JsonValue | undefined,
    setMemo: async () => {},
  };
}

/** Adapt one harness tool onto the bare Agent's tool face. */
function adaptCodingTool<TParameters extends TSchema, TDetails>(
  tool: HarnessToolFace<TParameters, TDetails>,
  env: NodeExecutionEnv,
): AgentTool<TParameters, TDetails> {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    // eslint-disable-next-line max-params -- upstream AgentTool signature
    async execute(toolCallId, params, signal, onUpdate) {
      const context =
        signal !== undefined ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
      return tool.execute(
        toolCallId,
        params,
        onUpdate ?? (() => {}),
        { env },
        unusedInvocation(),
        context,
      );
    },
  };
}

export interface CodingToolsetDeps {
  /** Conversation cwd: bash executes and relative paths resolve here. */
  cwd: string;
  /** Permission gate (beforeToolCall); omit for an ungated toolset. */
  gate?: ToolPermissionGate;
}

export interface CodingToolset {
  tools: AgentTool<TSchema, unknown>[];
  beforeToolCall: ToolPermissionGate | undefined;
}

/** Build the four coding tools bound to one cwd, with the optional gate. */
export function createCodingToolset(deps: CodingToolsetDeps): CodingToolset {
  const env = new NodeExecutionEnv({ cwd: deps.cwd });
  return {
    tools: [
      adaptCodingTool(createBashTool(), env),
      adaptCodingTool(createReadTool(), env),
      adaptCodingTool(createWriteTool(), env),
      adaptCodingTool(createEditTool(), env),
    ],
    beforeToolCall: deps.gate,
  };
}
