// Scenario: the permission gate's three outcomes driven deterministically by a
// scripted tool call (the real-LLM e2e can only hope the model calls the tool;
// the mock always does). Ask -> dialog -> user deny; allow pattern -> silent
// execution; block pattern beats allow, refusal without a dialog. Plan
// 2026-09-09-production-hardening.md §7.2.

import { makeWorld, startHost, writeAgentFiles, writeRules } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "tool-permission";
export const timeoutMs = 90_000;

const COMMAND = "echo perm-marker";

function toolStep() {
  return { kind: "tool", name: "bash", args: { command: COMMAND } };
}

function textStep(text) {
  return { kind: "text", text };
}

export async function run({ assert }) {
  const world = makeWorld(name);
  const mock = startMockModel({
    models: {
      // deny round, allow round, block round: each = tool call + wrap-up text.
      "mock-main": [
        toolStep(),
        textStep("denied-wrap-up"),
        toolStep(),
        textStep("allowed-wrap-up"),
        toolStep(),
        textStep("blocked-wrap-up"),
      ],
    },
  });
  writeAgentFiles(world.agentDir, {
    mockUrl: mock.url,
    rules: { mode: "ask", bash: {} },
  });
  const host = startHost({ agentDir: world.agentDir });
  const promptRound = async ({ id, label }) => {
    host.send({ id, type: "prompt", threadId: tid, message: label });
    const resp = await host.waitResponse(id, { ms: 15_000 });
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: `${label} settled`,
      ms: 30_000,
    });
    return resp;
  };
  const lastBashResult = async ({ id }) => {
    host.send({ id, type: "get_messages", threadId: tid });
    const r = await host.waitResponse(id, { ms: 15_000 });
    const results = r.data.messages.filter((m) => m.role === "toolResult" && m.toolName === "bash");
    return results.at(-1);
  };
  let tid = "";
  try {
    host.send({
      id: "s1",
      type: "thread/start",
      provider: "mock",
      modelId: "mock-main",
      cwd: world.projectDir,
    });
    const start = await host.waitResponse("s1", { ms: 20_000 });
    assert(start.success, "thread/start succeeds");
    tid = start.data.threadId;

    // Phase 1: ask mode; settle can only happen after the dialog is answered.
    const denyWindow = host.frames.length;
    host.send({ id: "p1", type: "prompt", threadId: tid, message: "run the perm command now" });
    assert((await host.waitResponse("p1", { ms: 15_000 })).success, "prompt(deny round) accepted");
    const dialog = await host.waitFrame((f) => f.type === "ui_request" && f.method === "confirm", {
      label: "confirm dialog",
      ms: 20_000,
    });
    assert(dialog.threadId === tid, "confirm dialog tagged with threadId");
    assert(
      typeof dialog.message === "string" && dialog.message.includes(COMMAND),
      "confirm dialog shows the command",
    );
    host.send({
      id: "u1",
      type: "ui_response",
      requestId: dialog.requestId,
      payload: { confirmed: false },
    });
    assert((await host.waitResponse("u1", { ms: 15_000 })).success, "ui_response(deny) acked");
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: "deny round settled",
      ms: 30_000,
    });
    const dialogsInRound = host.frames
      .slice(denyWindow)
      .filter((f) => f.type === "ui_request" && f.method === "confirm").length;
    assert(
      dialogsInRound === 1,
      `exactly one confirm dialog in the deny round (got ${dialogsInRound})`,
    );
    const denied = await lastBashResult({ id: "m1" });
    assert(
      denied !== undefined && JSON.stringify(denied.content).includes("User denied"),
      "denied call returns a User-denied tool result",
    );

    // Phase 2: allow pattern (hot rewrite; the gate re-reads per call).
    writeRules(world.agentDir, { bash: { allowPatterns: [COMMAND] } });
    const allowWindow = host.frames.length;
    assert(
      (await promptRound({ id: "p2", label: "run the perm command again", since: allowWindow }))
        .success,
      "prompt(allow round) accepted",
    );
    assert(
      !host.frames
        .slice(allowWindow)
        .some((f) => f.type === "ui_request" && f.method === "confirm"),
      "allowlisted command never raises a dialog",
    );
    const toolFrames = host.frames
      .slice(allowWindow)
      .filter(
        (f) => f.type === "event" && String(f.event?.type ?? "").startsWith("tool_execution"),
      );
    assert(toolFrames.length > 0, "allowlisted command emits tool_execution events");
    const allowed = await lastBashResult({ id: "m2" });
    assert(
      allowed !== undefined && JSON.stringify(allowed.content).includes("perm-marker"),
      "allowlisted command really executed (output in tool result)",
    );

    // Phase 3: block pattern beats allow, no dialog.
    writeRules(world.agentDir, {
      bash: { allowPatterns: [COMMAND], blockPatterns: ["*perm-marker*"] },
    });
    const blockWindow = host.frames.length;
    assert(
      (await promptRound({ id: "p3", label: "run the perm command once more", since: blockWindow }))
        .success,
      "prompt(block round) accepted",
    );
    assert(
      !host.frames
        .slice(blockWindow)
        .some((f) => f.type === "ui_request" && f.method === "confirm"),
      "blocklisted command is refused without a dialog",
    );
    const blocked = await lastBashResult({ id: "m3" });
    assert(
      blocked !== undefined &&
        JSON.stringify(blocked.content).includes("Blocked by permission rules"),
      "blocklisted command returns a rule-blocked tool result",
    );

    const exitCode = await host.endGracefully();
    assert(exitCode === 0, `stdin EOF graceful exit 0 (got ${exitCode})`);
  } finally {
    host.killTree();
    mock.stop();
    world.cleanup();
  }
}
