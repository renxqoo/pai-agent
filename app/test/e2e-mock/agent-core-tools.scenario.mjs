// Scenario: the pi-agent-core probe backend with the coding toolset mounted
// (capability-packs follow-up): the mock model issues a write tool call; the
// beforeToolCall gate asks over the dialog protocol (ui_request -> confirmed
// -> file created); a second host with block-all rules rejects the same call
// without any dialog and the file never appears.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, startHost, writeAgentFiles } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "agent-core-tools";
export const timeoutMs = 90_000;

const TOOL_STEP = {
  kind: "tool",
  name: "write",
  args: { path: "probe-tool.txt", content: "written by the probe coding tool" },
};

async function probeRound({ world, rules, expectDialog }) {
  const mock = startMockModel({
    models: {
      "mock-main": [
        TOOL_STEP,
        { kind: "text", text: expectDialog ? "tool round complete" : "after the block" },
      ],
    },
  });
  writeAgentFiles(world.agentDir, {
    mockUrl: mock.url,
    ...(rules !== undefined ? { rules } : {}),
  });
  const host = startHost({ agentDir: world.agentDir, env: { PAI_BACKEND: "pi-agent-core" } });
  try {
    await host.waitFrame((f) => f.type === "heartbeat", { label: "heartbeat", ms: 15_000 });
    host.send({
      id: "s1",
      type: "thread/start",
      provider: "mock",
      modelId: "mock-main",
      cwd: world.projectDir,
    });
    const start = await host.waitResponse("s1", { ms: 20_000 });
    if (!start.success) throw new Error(`thread/start failed: ${start.error}`);
    const tid = start.data.threadId;

    const since = host.frames.length;
    host.send({ id: "p1", type: "prompt", threadId: tid, message: "use the write tool" });
    const prompt = await host.waitResponse("p1", { ms: 15_000 });
    if (!prompt.success) throw new Error(`prompt failed: ${prompt.error}`);

    let dialog = null;
    if (expectDialog) {
      dialog = await host.waitFrame((f) => f.type === "ui_request" && f.method === "confirm", {
        label: "permission confirm dialog",
        ms: 20_000,
        since,
      });
      host.send({
        id: "u1",
        type: "ui_response",
        requestId: dialog.requestId,
        payload: { confirmed: true },
      });
      await host.waitResponse("u1", { ms: 15_000 });
    }

    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: "tool round settled",
      ms: 60_000,
      since,
    });

    const dialogs = host.frames.filter(
      (f) => f.type === "ui_request" && f.method === "confirm",
    ).length;
    const filePath = join(world.projectDir, "probe-tool.txt");
    return {
      dialogs,
      fileExists: existsSync(filePath),
      fileContent: existsSync(filePath) ? readFileSync(filePath, "utf8") : undefined,
      exitCode: await host.endGracefully(),
    };
  } finally {
    host.killTree();
    mock.stop();
    world.cleanup();
  }
}

export async function run({ assert }) {
  // Ask path: default rules (no rules file) -> confirm dialog -> allow.
  const asked = await probeRound({
    world: makeWorld(`${name}-ask`),
    rules: undefined,
    expectDialog: true,
    expectFile: true,
  });
  assert(asked.dialogs === 1, `ask mode opens exactly one confirm dialog (got ${asked.dialogs})`);
  assert(asked.fileExists, "confirmed write creates the file under the conversation cwd");
  assert(
    asked.fileContent === "written by the probe coding tool",
    "file content matches the tool args",
  );
  assert(asked.exitCode === 0, `ask host exits 0 (got ${asked.exitCode})`);

  // Block path: block-all rules -> no dialog, no file.
  const blocked = await probeRound({
    world: makeWorld(`${name}-block`),
    rules: { mode: "block-all" },
    expectDialog: false,
    expectFile: false,
  });
  assert(blocked.dialogs === 0, "block-all never asks (blocked before the dialog)");
  assert(!blocked.fileExists, "blocked write never touches the filesystem");
  assert(blocked.exitCode === 0, `block host exits 0 (got ${blocked.exitCode})`);
}
