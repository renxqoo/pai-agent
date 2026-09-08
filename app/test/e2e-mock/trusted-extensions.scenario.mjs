// Scenario: the security model's first line, exercised for real (design.md
// "Security model"): a project .pi extension is ARBITRARY CODE. An untrusted
// thread must never even import it (marker file written at module
// evaluation); a trusted thread loads it at session creation. This was
// previously only a "static dependency" note in design.md. Plan
// 2026-09-09-production-hardening.md §7.5.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, startHost, writeAgentFiles } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "trusted-extensions";
export const timeoutMs = 90_000;

const EVIL_MARKER = `
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Module-evaluation side effect: writing this file proves the extension was
// imported AT ALL — stronger than proving its handlers never ran.
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "evil-loaded.marker"), "loaded");
export default function () {}
`;

export async function run({ assert }) {
  const world = makeWorld(name);
  const mock = startMockModel({});
  writeAgentFiles(world.agentDir, { mockUrl: mock.url });
  const extDir = join(world.projectDir, ".pi", "extensions");
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(extDir, "evil-marker.js"), EVIL_MARKER);
  const markerPath = join(extDir, "evil-loaded.marker");
  const host = startHost({ agentDir: world.agentDir });
  try {
    await host.waitFrame((f) => f.type === "heartbeat", { label: "first heartbeat", ms: 15_000 });

    // Untrusted (the default): a full working round, and the marker never appears.
    host.send({
      id: "s1",
      type: "thread/start",
      provider: "mock",
      modelId: "mock-main",
      cwd: world.projectDir,
    });
    const untrusted = await host.waitResponse("s1", { ms: 20_000 });
    assert(untrusted.success, "untrusted thread/start succeeds");
    // (trusted is not a protocol response field; untrustedness is proven
    // behaviorally by the marker staying absent below.)
    const tid = untrusted.data.threadId;
    const roundWindow = host.frames.length;
    host.send({ id: "p1", type: "prompt", threadId: tid, message: "untrusted round marker" });
    assert((await host.waitResponse("p1", { ms: 15_000 })).success, "untrusted prompt accepted");
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: "untrusted round settled",
      ms: 30_000,
      since: roundWindow,
    });
    assert(
      !existsSync(markerPath),
      "untrusted thread never imports the project extension (no marker)",
    );
    host.send({ id: "x1", type: "thread/stop", threadId: tid });
    assert(
      (await host.waitResponse("x1", { ms: 15_000 })).success,
      "thread/stop after untrusted round",
    );

    // Trusted: same cwd, explicit opt-in — the extension loads at creation.
    host.send({
      id: "s2",
      type: "thread/start",
      provider: "mock",
      modelId: "mock-main",
      cwd: world.projectDir,
      trusted: true,
    });
    const trusted = await host.waitResponse("s2", { ms: 20_000 });
    assert(trusted.success, "trusted thread/start succeeds");
    let markerSeen = existsSync(markerPath);
    for (let i = 0; i < 40 && !markerSeen; i++) {
      await new Promise((done) => {
        setTimeout(done, 250);
      });
      markerSeen = existsSync(markerPath);
    }
    assert(markerSeen, "trusted thread loads the project extension (marker written)");

    const exitCode = await host.endGracefully();
    assert(exitCode === 0, `stdin EOF graceful exit 0 (got ${exitCode})`);
  } finally {
    host.killTree();
    mock.stop();
    world.cleanup();
  }
}
