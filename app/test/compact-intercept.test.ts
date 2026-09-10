import { describe, expect, test } from "bun:test";
import { parseCompactInvocation } from "../src/compact-invocation.ts";
import { workerHandlers } from "../src/worker-commands.ts";
import type { CapabilityBit } from "../src/backend/capabilities.ts";
import type { PaiThread } from "../src/backend/ports/session.ts";
import type { WorkerContext } from "../src/worker-context.ts";

/**
 * v0.11 prompt-path /compact interception (design.md「恰好一次」exception):
 * table-driven lexing, then handler-level behavior — compact timing (the
 * response settles with the operation), images / already-compacting
 * failures, capability-off pass-through, and inflight registration.
 */

// --- lexing -------------------------------------------------------------------

const LEX_CASES: ReadonlyArray<{ message: string; customInstructions?: string }> = [
  { message: "/compact" },
  { message: "/compact " },
  { message: "/compact  " },
  { message: "/compact focus on tests", customInstructions: "focus on tests" },
  { message: "/compact  keep   inner  spacing\t", customInstructions: "keep   inner  spacing" },
  { message: "/compact\nfocus on tests", customInstructions: "focus on tests" },
  { message: "/compact\ttrim-tail   ", customInstructions: "trim-tail" },
];

const NON_MATCH_CASES: ReadonlyArray<string> = [
  "",
  "/compactfoo",
  "/compact-x",
  "/COMPACT",
  "/Compact",
  " /compact",
  "\t/compact",
  "text /compact more",
  "/skills",
  "compact",
];

describe("parseCompactInvocation lexing (v0.11)", () => {
  for (const { message, customInstructions } of LEX_CASES) {
    test(`${JSON.stringify(message)} -> customInstructions ${JSON.stringify(customInstructions)}`, () => {
      expect(parseCompactInvocation(message)).toEqual({ customInstructions });
    });
  }
  for (const message of NON_MATCH_CASES) {
    test(`${JSON.stringify(message)} -> no match`, () => {
      expect(parseCompactInvocation(message)).toBeUndefined();
    });
  }
});

// --- handler behavior -----------------------------------------------------------

interface RecordedSession {
  promptMessages: string[];
  compactCalls: Array<string | undefined>;
  isCompacting: boolean;
}

function makeThread(overrides?: Partial<RecordedSession>): {
  thread: PaiThread;
  recorded: RecordedSession;
} {
  const recorded: RecordedSession = {
    promptMessages: [],
    compactCalls: [],
    isCompacting: overrides?.isCompacting ?? false,
  };
  const thread = {
    cwd: "/tmp/proj",
    sessionPath: undefined,
    session: {
      sessionId: "t1",
      sessionFile: undefined,
      sessionName: undefined,
      model: undefined,
      thinkingLevel: "off",
      isStreaming: false,
      isCompacting: recorded.isCompacting,
      messages: [],
      sessionManager: {},
      extensionRunner: { getRegisteredCommands: () => [] },
      promptTemplates: [],
      resourceLoader: { getSkills: () => ({ skills: [] }) },
      prompt: (message: string) => {
        recorded.promptMessages.push(message);
        return Promise.resolve();
      },
      compact: (customInstructions?: string) => {
        recorded.compactCalls.push(customInstructions);
        return Promise.resolve({ summary: "compacted" });
      },
      abortCompaction: () => {},
    },
  };
  return { thread: thread as unknown as PaiThread, recorded };
}

interface Harness {
  ctx: WorkerContext;
  responses: Array<{
    id: string | undefined;
    command: string;
    ok: boolean;
    data?: unknown;
    error?: string;
  }>;
  inflightAborts: Array<() => unknown>;
}

function makeHarness(thread: PaiThread, capabilities: ReadonlySet<CapabilityBit>): Harness {
  const responses: Harness["responses"] = [];
  const inflightAborts: Harness["inflightAborts"] = [];
  const ctx = {
    sessions: undefined,
    broker: undefined,
    emit: () => {},
    capabilities,
    bashTimeoutMs: 0,
    registerInflight: (abort: () => unknown) => {
      inflightAborts.push(abort);
      return { unregister: () => {} };
    },
    triggerShutdown: () => {},
    success: (id: string | undefined, command: string, data?: unknown) => {
      responses.push({ id, command, ok: true, data });
    },
    failure: (id: string | undefined, command: string, error: string) => {
      responses.push({ id, command, ok: false, error });
    },
    requireThread: (threadId: string, command: string, id: string | undefined) => {
      if (threadId === "t1") return thread;
      responses.push({ id, command, ok: false, error: "unknown" });
      return;
    },
    routeSubagentUi: () => false,
    killSubagents: () => {},
    steerSubagent: () => Promise.resolve(true),
    resolveGrant: () => {},
    checkPermission: undefined,
  } as unknown as WorkerContext;
  return { ctx, responses, inflightAborts };
}

const PROMPT_HANDLER = workerHandlers.get("prompt");

/** Dispatch one prompt through the handler with the worker dispatcher's
 * catch semantics (worker.ts createLineHandler): a thrown handler error
 * becomes the exactly-one failure response. */
function sendPrompt(
  harness: Harness,
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  if (PROMPT_HANDLER === undefined) throw new Error("prompt handler missing");
  return PROMPT_HANDLER(
    harness.ctx,
    { type: "prompt", threadId: "t1", message, ...extra },
    "req-1",
  ).catch((error: unknown) => {
    harness.responses.push({
      id: "req-1",
      command: "prompt",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

describe("prompt /compact interception (v0.11)", () => {
  test("hit: compact runs with trimmed instructions; response settles after it (command stays prompt)", async () => {
    const { thread, recorded } = makeThread();
    const harness = makeHarness(thread, new Set<CapabilityBit>(["session.compact"]));
    await sendPrompt(harness, "/compact  focus on tests ");
    expect(recorded.promptMessages).toEqual([]);
    expect(recorded.compactCalls).toEqual(["focus on tests"]);
    expect(harness.responses).toEqual([
      { id: "req-1", command: "prompt", ok: true, data: { summary: "compacted" } },
    ]);
    expect(harness.inflightAborts.length).toBe(1);
  });

  test("hit without instructions: compact(undefined)", async () => {
    const { thread, recorded } = makeThread();
    const harness = makeHarness(thread, new Set<CapabilityBit>(["session.compact"]));
    await sendPrompt(harness, "/compact");
    expect(recorded.compactCalls).toEqual([undefined]);
    expect(harness.responses[0]?.ok).toBe(true);
  });

  test("images attached: fixed failure, compact never called", async () => {
    const { thread, recorded } = makeThread();
    const harness = makeHarness(thread, new Set<CapabilityBit>(["session.compact"]));
    await sendPrompt(harness, "/compact", {
      images: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
    });
    expect(recorded.compactCalls).toEqual([]);
    expect(harness.responses).toEqual([
      {
        id: "req-1",
        command: "prompt",
        ok: false,
        error: "Compact command does not accept images",
      },
    ]);
    expect(harness.inflightAborts.length).toBe(0);
  });

  test("already compacting: fixed failure wording", async () => {
    const { thread, recorded } = makeThread({ isCompacting: true });
    const harness = makeHarness(thread, new Set<CapabilityBit>(["session.compact"]));
    await sendPrompt(harness, "/compact");
    expect(recorded.compactCalls).toEqual([]);
    expect(harness.responses).toEqual([
      { id: "req-1", command: "prompt", ok: false, error: "Compaction already in progress" },
    ]);
  });

  test("capability off (pi-agent-core shape): no interception, message passes through verbatim", async () => {
    const { thread, recorded } = makeThread();
    const harness = makeHarness(thread, new Set<CapabilityBit>());
    await sendPrompt(harness, "/compact focus on tests");
    expect(recorded.compactCalls).toEqual([]);
    expect(recorded.promptMessages).toEqual(["/compact focus on tests"]);
    expect(harness.responses).toEqual([]);
  });

  test("lexically missed message goes the ordinary prompt path", async () => {
    const { thread, recorded } = makeThread();
    const harness = makeHarness(thread, new Set<CapabilityBit>(["session.compact"]));
    await sendPrompt(harness, "/compactfoo");
    expect(recorded.compactCalls).toEqual([]);
    expect(recorded.promptMessages).toEqual(["/compactfoo"]);
  });

  test("compact failure propagates as the failure response (error passthrough)", async () => {
    const { thread } = makeThread();
    (thread.session as { compact: () => Promise<unknown> }).compact = () =>
      Promise.reject(new Error("Nothing to compact (session too small)"));
    const harness = makeHarness(thread, new Set<CapabilityBit>(["session.compact"]));
    await sendPrompt(harness, "/compact");
    expect(harness.responses).toEqual([
      {
        id: "req-1",
        command: "prompt",
        ok: false,
        error: "Nothing to compact (session too small)",
      },
    ]);
  });
});
