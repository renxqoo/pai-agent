// Scenario: torn-write recovery (the power-loss class). A JSONL session file
// whose last line was cut mid-write (or that contains a garbage line) must
// resume by recovering the intact prefix — never a crash, never a silent
// empty history for the intact part, never a hub_error storm. Behavior
// probed 2026-09-09 (bun 1.4.2) and pinned here; documented in api.md.
// Plan 2026-09-09-production-hardening.md §7.6.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, startHost, writeAgentFiles } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "torn-session-file";
export const timeoutMs = 90_000;

const HEADER =
  '{"type":"session","version":3,"id":"11111111-1111-1111-1111-111111111111","timestamp":"2026-09-07T00:00:00.000Z","cwd":"/tmp"}';
// Distinct header id: two fixtures must never resume as the same session id.
const HEADER_2 =
  '{"type":"session","version":3,"id":"22222222-2222-2222-2222-222222222222","timestamp":"2026-09-07T00:00:00.000Z","cwd":"/tmp"}';
const USER =
  '{"type":"message","id":"e1","parentId":null,"timestamp":"2026-09-07T00:00:01.000Z","message":{"role":"user","content":"Hello torn"}}';
const ASSISTANT =
  '{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-09-07T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi torn!"}],"provider":"p","model":"m","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop"}}';
const TORN_TAIL = '{"type":"message","id":"e3","parentId":"e2","tim';

export async function run({ assert }) {
  const world = makeWorld(name);
  const mock = startMockModel({});
  writeAgentFiles(world.agentDir, { mockUrl: mock.url });

  const fixtures = {
    // Last line cut mid-JSON, no trailing newline: the power-loss signature.
    "torn-tail.jsonl": [HEADER, USER, ASSISTANT, TORN_TAIL].join("\n"),
    // Corrupt garbage in the middle between intact messages.
    "garbage-mid.jsonl": [HEADER, USER, "{not json at all", ASSISTANT].join("\n"),
    // Valid header, zero messages.
    "header-only.jsonl": HEADER_2,
    // Zero bytes (crash before the first persist ever wrote a header).
    "empty.jsonl": "",
  };
  for (const [fileName, content] of Object.entries(fixtures)) {
    writeFileSync(join(world.agentDir, "sessions", fileName), content);
  }

  const host = startHost({ agentDir: world.agentDir });
  try {
    await host.waitFrame((f) => f.type === "heartbeat", { label: "first heartbeat", ms: 15_000 });

    const resume = async (file) => {
      host.send({
        id: file,
        type: "thread/resume",
        sessionPath: join(world.agentDir, "sessions", file),
      });
      return host.waitResponse(file, { ms: 20_000 });
    };
    const rolesOf = async (tid, id) => {
      host.send({ id, type: "get_messages", threadId: tid });
      const r = await host.waitResponse(id, { ms: 20_000 });
      return r.success ? r.data.messages.map((m) => m.role).join(",") : `error:${r.error}`;
    };

    const torn = await resume("torn-tail.jsonl");
    assert(torn.success, "torn tail: resume succeeds");
    assert(
      torn.success && (await rolesOf(torn.data.threadId, "g1")) === "user,assistant",
      "torn tail: intact prefix recovered (torn line dropped)",
    );
    host.send({ id: "x1", type: "thread/stop", threadId: torn.data.threadId });
    await host.waitResponse("x1", { ms: 15_000 });

    const garbage = await resume("garbage-mid.jsonl");
    assert(garbage.success, "garbage mid-file: resume succeeds");
    assert(
      garbage.success && (await rolesOf(garbage.data.threadId, "g2")) === "user,assistant",
      "garbage mid-file: both intact messages survive",
    );
    host.send({ id: "x2", type: "thread/stop", threadId: garbage.data.threadId });
    await host.waitResponse("x2", { ms: 15_000 });

    const headerOnly = await resume("header-only.jsonl");
    assert(headerOnly.success, "header-only: resume succeeds");
    assert(
      headerOnly.success && (await rolesOf(headerOnly.data.threadId, "g3")) === "",
      "header-only: empty conversation",
    );
    assert(
      headerOnly.success && headerOnly.data.threadId !== torn.data.threadId,
      "resumes are distinct threads",
    );
    host.send({ id: "x3", type: "thread/stop", threadId: headerOnly.data.threadId });
    await host.waitResponse("x3", { ms: 15_000 });

    const empty = await resume("empty.jsonl");
    assert(empty.success, "empty file: resume succeeds (pi synthesizes a fresh session id)");
    assert(
      empty.success && empty.data.threadId !== "11111111-1111-1111-1111-111111111111",
      "empty file: synthesized id, not the fixture's absent header id",
    );
    host.send({ id: "x4", type: "thread/stop", threadId: empty.data.threadId });
    await host.waitResponse("x4", { ms: 15_000 });

    assert(
      !host.frames.some((f) => f.type === "hub_error"),
      "no hub_error frames across all torn-file resumes",
    );
    host.send({ id: "ls", type: "thread/list" });
    assert(
      (await host.waitResponse("ls", { ms: 15_000 })).success,
      "host still fully responsive afterwards",
    );

    const exitCode = await host.endGracefully();
    assert(exitCode === 0, `stdin EOF graceful exit 0 (got ${exitCode})`);
  } finally {
    host.killTree();
    mock.stop();
    world.cleanup();
  }
}
