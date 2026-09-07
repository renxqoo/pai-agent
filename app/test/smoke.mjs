// Contract-level smoke (real spawn + stdio): walks the command matrix from
// docs/design.md "Testing Criteria" and asserts the response contract —
// exactly one response per id, id echoed, error text in response.error.
// Run: bun test/smoke.mjs   (from app/)

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const seenFrames = [];
const allFrames = [];
let failures = 0;

const watchdog = setTimeout(() => {
  console.error("FAIL smoke timed out; frames seen:", seenFrames.join(","));
  process.exit(1);
}, 90_000);

// Hermetic agent dir: the hub must never touch the user's real ~/.pi
// (settings, auth.json, permission rules) during tests.
const agentDir = mkdtempSync(join(tmpdir(), "pai-cli-smoke-"));

const hub = spawn("bun", ["src/cli.ts"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
});

// stderr is captured (not inherited): the key-leak assertion must cover it too.
let stderrText = "";
hub.stderr.setEncoding("utf8");
hub.stderr.on("data", (chunk) => {
  stderrText += chunk;
});

const pending = new Map();
let buffer = "";
hub.stdout.setEncoding("utf8");
hub.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) !== -1) {
    let line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    const frame = JSON.parse(line);
    seenFrames.push(frame.type);
    allFrames.push(frame);
    if (frame.type === "response" && frame.id !== undefined) {
      pending.get(frame.id)?.(frame);
      pending.delete(frame.id);
    }
  }
});

function send(cmd) {
  return new Promise((resolve) => {
    pending.set(cmd.id, resolve);
    hub.stdin.write(JSON.stringify(cmd) + "\n");
  });
}

function assert(cond, label) {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failures++;
}

async function expectResponse(cmd, check, label) {
  const response = await send(cmd);
  assert(response.id === cmd.id, `${label}: id echoed`);
  assert(
    response.type === "response" && typeof response.command === "string",
    `${label}: is a response frame`,
  );
  check(response);
}

let threadId = "";

// --- matrix -----------------------------------------------------------------

await expectResponse(
  { id: "1", type: "thread/start", cwd: "/tmp" },
  (r) => {
    assert(r.success && typeof r.data.threadId === "string", "thread/start: returns threadId");
    assert(typeof r.data.sessionPath === "string", "thread/start: returns sessionPath");
    threadId = r.data.threadId;
  },
  "thread/start happy",
);

await expectResponse(
  { id: "2", type: "get_state", threadId },
  (r) => {
    assert(r.success && r.data.sessionId === threadId, "get_state: sessionId matches");
    assert(typeof r.data.isStreaming === "boolean", "get_state: isStreaming boolean");
  },
  "get_state happy",
);

let secondId = "";
await expectResponse(
  { id: "3", type: "thread/start", cwd: "/tmp" },
  (r) => {
    assert(r.success && r.data.threadId !== threadId, "second thread: independent id");
    secondId = r.data.threadId;
  },
  "thread/start x2 happy",
);

await expectResponse(
  { id: "4", type: "thread/list" },
  (r) => {
    assert(r.success && r.data.threads.length === 2, "thread/list: two live threads");
  },
  "thread/list happy",
);

const stateFrame = await send({ id: "5", type: "get_state", threadId });
await expectResponse(
  { id: "6", type: "thread/resume", sessionPath: stateFrame.data.sessionFile },
  (r) => {
    assert(!r.success && /already open/.test(r.error ?? ""), "thread/resume double-open: rejected");
  },
  "thread/resume error",
);

let promptAccepted = false;
await expectResponse(
  { id: "7", type: "prompt", threadId, message: "hi" },
  (r) => {
    // No provider auth on this machine: acceptance OR a model error are both
    // contract-conformant; the reply itself never rides on this response.
    promptAccepted = r.success;
    assert(
      r.success || /model|API key/i.test(r.error ?? ""),
      "prompt: accepted or clean model error",
    );
  },
  "prompt fire-and-accept",
);

await expectResponse(
  { id: "8", type: "get_state", threadId: "does-not-exist" },
  (r) => {
    assert(!r.success && /Unknown threadId/.test(r.error ?? ""), "unknown threadId: failure");
  },
  "get_state error",
);

await expectResponse(
  { id: "9", type: "nonsense_command" },
  (r) => {
    assert(!r.success && /Unknown command/.test(r.error ?? ""), "unknown command: failure");
  },
  "unknown command error",
);

// Parse failures have no id; track full frames to locate them precisely.
hub.stdin.write("{not json\n");
hub.stdin.write("null\n");
await new Promise((r) => setTimeout(r, 300));
const parseFrames = allFrames.filter((f) => f.type === "response" && f.command === "parse");
assert(
  parseFrames.length === 2,
  `parse: bad JSON and null each produce a failure frame (got ${parseFrames.length})`,
);
{
  const probe = await send({ id: "10", type: "get_models" });
  assert(
    probe.success && Array.isArray(probe.data.models),
    "get_models: still serving after parse errors",
  );
}

// Oversized line (16 MiB limit): dropped with a parse failure, hub survives.
{
  const pad = "z".repeat(17 * 1024 * 1024);
  hub.stdin.write(`${pad}\n`);
  await new Promise((r) => setTimeout(r, 500));
  const overflow = allFrames.filter((f) => f.type === "response" && /exceeds/.test(f.error ?? ""));
  assert(overflow.length >= 1, "oversized line: reported via parse failure");
  const probe = await send({ id: "10b", type: "thread/list" });
  assert(probe.success, "thread/list: still serving after oversized line");
}

await expectResponse(
  { id: "11", type: "ui_response", requestId: "late", payload: {} },
  (r) => {
    assert(r.success, "ui_response: always acked");
  },
  "ui_response ack (late id)",
);

await expectResponse(
  { id: "12", type: "thread/stop", threadId: "ghost" },
  (r) => {
    assert(r.success, "thread/stop: idempotent on unknown id");
  },
  "thread/stop idempotent",
);

await expectResponse(
  { id: "13", type: "set_thinking_level", threadId, level: "high" },
  (r) => {
    assert(r.success, "set_thinking_level: accepted");
  },
  "set_thinking_level happy",
);

await expectResponse(
  { id: "14", type: "get_thinking_levels", threadId },
  (r) => {
    assert(r.success && Array.isArray(r.data.levels), "get_thinking_levels: array");
  },
  "get_thinking_levels happy",
);

await expectResponse(
  { id: "15", type: "set_model", threadId, provider: "x", modelId: "y" },
  (r) => {
    assert(!r.success && /Model not found/.test(r.error ?? ""), "set_model bogus: failure");
  },
  "set_model error",
);

await expectResponse(
  { id: "16", type: "thread/list_saved", cwd: "/tmp" },
  (r) => {
    assert(r.success && Array.isArray(r.data.sessions), "thread/list_saved: array");
  },
  "thread/list_saved happy",
);

await expectResponse(
  { id: "17", type: "thread/stop", threadId: secondId },
  (r) => {
    assert(r.success, "thread/stop live: success");
  },
  "thread/stop live happy",
);

// --- auth (v0.2): API key lifecycle + zero key echo --------------------------

const KEY_MARKER = "sk-ant-smoke-LEAK-MARKER-9f3a";
const assertNoKeyLeak = () => {
  assert(
    !allFrames.some((f) => JSON.stringify(f).includes(KEY_MARKER)),
    "auth: key never appears in any output frame",
  );
  assert(!stderrText.includes(KEY_MARKER), "auth: key never appears on stderr");
};

await expectResponse(
  { id: "a1", type: "auth/list" },
  (r) => {
    assert(r.success && Array.isArray(r.data.credentials), "auth/list: credentials array");
    assert(r.data.credentials.length === 0, "auth/list: empty in hermetic agent dir");
  },
  "auth/list initial",
);

await expectResponse(
  { id: "a2", type: "auth/set_api_key", provider: "no-such-provider", apiKey: KEY_MARKER },
  (r) => {
    assert(
      !r.success && /Unknown provider/.test(r.error ?? ""),
      "auth/set_api_key: unknown provider rejected",
    );
  },
  "auth/set_api_key unknown provider",
);
assertNoKeyLeak();

// Adversarial-review regression: providers whose login flow asks select/text
// for extra fields (bedrock auth method, cloudflare account id) must be
// rejected by the bridge instead of having the key echoed back inside a
// provider error message.
await expectResponse(
  { id: "a2b", type: "auth/set_api_key", provider: "amazon-bedrock", apiKey: KEY_MARKER },
  (r) => {
    assert(
      !r.success && /additional interactive input/.test(r.error ?? ""),
      "auth/set_api_key: multi-prompt provider rejected",
    );
  },
  "auth/set_api_key multi-prompt provider",
);
assertNoKeyLeak();

const setKey = await send({
  id: "a3",
  type: "auth/set_api_key",
  provider: "anthropic",
  apiKey: KEY_MARKER,
});
assert(setKey.success, `auth/set_api_key: accepted (${setKey.error ?? "ok"})`);

await expectResponse(
  { id: "a4", type: "auth/list" },
  (r) => {
    const anthropic = r.data.credentials?.find((c) => c.provider === "anthropic");
    assert(anthropic?.type === "api_key", "auth/list: anthropic api_key present");
  },
  "auth/list after set",
);
assertNoKeyLeak();

{
  const authFile = join(agentDir, "auth.json");
  assert(existsSync(authFile), "auth: persisted to agent dir auth.json");
  assert(readFileSync(authFile, "utf8").includes("anthropic"), "auth: provider entry in auth.json");
}

await expectResponse(
  { id: "a5", type: "auth/remove_key", provider: "anthropic" },
  (r) => {
    assert(r.success, "auth/remove_key: success");
  },
  "auth/remove_key",
);

await expectResponse(
  { id: "a6", type: "auth/list" },
  (r) => {
    assert(
      !r.data.credentials?.some((c) => c.provider === "anthropic"),
      "auth/list: anthropic gone after remove",
    );
  },
  "auth/list after remove",
);
assertNoKeyLeak();

// OAuth protection: a non-api_key credential must not be overwritten by
// set_api_key nor deleted by remove_key (fixture: fake oauth entry).
writeFileSync(
  join(agentDir, "auth.json"),
  JSON.stringify({ anthropic: { type: "oauth", token: "t" } }),
);
await expectResponse(
  { id: "a7", type: "auth/set_api_key", provider: "anthropic", apiKey: KEY_MARKER },
  (r) => {
    assert(
      !r.success && /oauth credential/.test(r.error ?? ""),
      "auth/set_api_key: oauth credential protected",
    );
  },
  "auth/set_api_key oauth guard",
);
await expectResponse(
  { id: "a8", type: "auth/remove_key", provider: "anthropic" },
  (r) => {
    assert(
      !r.success && /only api_key/.test(r.error ?? ""),
      "auth/remove_key: oauth credential protected",
    );
  },
  "auth/remove_key oauth guard",
);
assertNoKeyLeak();

// remove_key on a provider with no stored credential is idempotent success.
await expectResponse(
  { id: "a9", type: "auth/remove_key", provider: "openai" },
  (r) => {
    assert(r.success, "auth/remove_key: idempotent without credential");
  },
  "auth/remove_key idempotent",
);

// --- v0.3: session metadata, tree, queue, commands ---------------------------

await expectResponse(
  { id: "v1", type: "set_session_name", threadId, name: "  smoke-test  " },
  (r) => {
    assert(r.success, "set_session_name: success (trimmed)");
  },
  "set_session_name happy",
);
await expectResponse(
  { id: "v2", type: "get_state", threadId },
  (r) => {
    assert(r.data.sessionName === "smoke-test", "get_state: sessionName set and trimmed");
  },
  "get_state sessionName",
);

await expectResponse(
  { id: "v3", type: "set_session_name", threadId, name: "   " },
  (r) => {
    assert(!r.success && /empty/.test(r.error ?? ""), "set_session_name: blank rejected");
  },
  "set_session_name blank error",
);

await expectResponse(
  { id: "v4", type: "clear_queue", threadId },
  (r) => {
    assert(
      r.success && Array.isArray(r.data.steering) && Array.isArray(r.data.followUp),
      "clear_queue: returns arrays",
    );
  },
  "clear_queue happy",
);

await expectResponse(
  { id: "v5", type: "get_tree", threadId },
  (r) => {
    assert(
      r.success && Array.isArray(r.data.tree) && "leafId" in r.data,
      "get_tree: tree + leafId",
    );
  },
  "get_tree happy",
);

await expectResponse(
  { id: "v6", type: "get_session_stats", threadId },
  (r) => {
    assert(r.success && typeof r.data.sessionFile === "string", "get_session_stats: shape");
  },
  "get_session_stats happy",
);

await expectResponse(
  { id: "v7", type: "get_fork_messages", threadId },
  (r) => {
    assert(r.success && Array.isArray(r.data.messages), "get_fork_messages: array");
  },
  "get_fork_messages happy",
);

await expectResponse(
  { id: "v8", type: "get_commands", threadId },
  (r) => {
    assert(r.success && Array.isArray(r.data.commands), "get_commands: array");
  },
  "get_commands happy",
);

await expectResponse(
  { id: "v9", type: "get_entries", threadId, since: "bogus-entry" },
  (r) => {
    assert(
      !r.success && /Entry not found/.test(r.error ?? ""),
      "get_entries: bogus since cursor rejected",
    );
  },
  "get_entries bad cursor error",
);

await expectResponse(
  { id: "v10", type: "prompt", threadId, message: "hi", images: [{ type: "photo" }] },
  (r) => {
    assert(!r.success && /image/.test(r.error ?? ""), "prompt: malformed images rejected");
  },
  "prompt malformed images error",
);

// --- v0.3: bash (real subprocess, keyless) -----------------------------------

// Permission rules live under the hermetic agent dir: direct bash goes
// through the same gate as the agent's bash tool. Unmatched commands would
// "ask" (dialog) — allow echo * so only the blocked pattern exercises denial.
writeFileSync(
  join(agentDir, "permission-rules.json"),
  JSON.stringify({ bash: { allowPatterns: ["echo *"], blockPatterns: ["echo blocked-*"] } }),
);

const bashFramesBefore = allFrames.filter(
  (f) => f.type === "event" && f.event?.type === "bash_execution_update",
).length;
await expectResponse(
  { id: "v11", type: "bash", threadId, command: "echo hub-bash-smoke" },
  (r) => {
    assert(r.success && /hub-bash-smoke/.test(r.data.output ?? ""), "bash: output captured");
    assert(r.data.exitCode === 0, "bash: exit code 0");
  },
  "bash happy",
);
await new Promise((r) => setTimeout(r, 300));
const bashFramesAfter = allFrames.filter(
  (f) => f.type === "event" && f.event?.type === "bash_execution_update",
).length;
assert(
  bashFramesAfter > bashFramesBefore,
  "bash: streaming bash_execution_update event frames arrived",
);

await expectResponse(
  { id: "v12", type: "abort_bash", threadId },
  (r) => {
    assert(r.success, "abort_bash: success when nothing running");
  },
  "abort_bash idle",
);

await expectResponse(
  { id: "v12b", type: "bash", threadId, command: "echo blocked-marker" },
  (r) => {
    assert(
      !r.success && /Blocked by permission rules/.test(r.error ?? ""),
      "bash: rule-blocked command rejected",
    );
  },
  "bash blocked by rules",
);
await expectResponse(
  { id: "v12c", type: "bash", threadId, command: "echo allowed-marker" },
  (r) => {
    assert(
      r.success && /allowed-marker/.test(r.data.output ?? ""),
      "bash: non-matching command still runs",
    );
  },
  "bash allowed by rules",
);

await expectResponse(
  { id: "v12d", type: "prompt", threadId, message: "hi", streamingBehavior: "banana" },
  (r) => {
    assert(
      !r.success && /streamingBehavior/.test(r.error ?? ""),
      "prompt: invalid streamingBehavior rejected",
    );
  },
  "prompt bad streamingBehavior error",
);

{
  // A command object without `type` must still get a well-formed failure.
  const r = await send({ id: "v12e", x: 1 });
  assert(!r.success && r.command === "unknown", "untyped command: command field is a string");
}

// --- v0.3: entries + fork/clone (real session data from bash) -----------------

let firstEntryId = null;
await expectResponse(
  { id: "v13", type: "get_entries", threadId },
  (r) => {
    assert(r.success && r.data.entries.length >= 1, "get_entries: bash created session entries");
    firstEntryId = r.data.entries[0].id;
    assert(typeof firstEntryId === "string", "get_entries: entry ids are strings");
  },
  "get_entries after bash",
);

await expectResponse(
  { id: "v14", type: "fork", threadId, entryId: "no-such-entry" },
  (r) => {
    assert(!r.success && /entry/i.test(r.error ?? ""), "fork: bogus entry rejected");
  },
  "fork bad entry error",
);

await expectResponse(
  { id: "v15", type: "navigate_tree", threadId, targetId: "no-such-target" },
  (r) => {
    assert(!r.success, "navigate_tree: bogus target rejected");
  },
  "navigate_tree bad target error",
);

// Fork needs a persisted session with an assistant response (pi refuses
// otherwise); prompt cannot get there keylessly, so resume a hand-crafted
// session file (format: docs/session-format.md) for the real fork path.
const fixtureDir = join(agentDir, "sessions", "--tmp--");
mkdirSync(fixtureDir, { recursive: true });
const fixturePath = join(fixtureDir, "fixture-fork.jsonl");
writeFileSync(
  fixturePath,
  [
    '{"type":"session","version":3,"id":"11111111-1111-1111-1111-111111111111","timestamp":"2026-09-07T00:00:00.000Z","cwd":"/tmp"}',
    '{"type":"message","id":"e1","parentId":null,"timestamp":"2026-09-07T00:00:01.000Z","message":{"role":"user","content":"Hello"}}',
    '{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-09-07T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"provider":"anthropic","model":"fixture-model","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop"}}',
  ].join("\n") + "\n",
);

let fixtureThreadId = null;
await expectResponse(
  { id: "v16", type: "thread/resume", sessionPath: fixturePath },
  (r) => {
    assert(r.success, `thread/resume fixture (${r.error ?? "ok"})`);
    fixtureThreadId = r.data.threadId;
  },
  "thread/resume fixture",
);

await expectResponse(
  { id: "v17", type: "get_entries", threadId: fixtureThreadId },
  (r) => {
    // Resume appends a thinking_level_change entry, so assert membership and
    // a string leaf rather than an exact count.
    assert(r.success && r.data.entries.length >= 2, "fixture: entries present");
    const ids = r.data.entries.map((e) => e.id);
    assert(ids.includes("e1") && ids.includes("e2"), "fixture: e1/e2 present");
    assert(typeof r.data.leafId === "string", "fixture: leafId is a string");
  },
  "fixture get_entries",
);

let forkedId = null;
await expectResponse(
  { id: "v18", type: "fork", threadId: fixtureThreadId, entryId: "e2", position: "at" },
  (r) => {
    assert(r.success && r.data.threadId !== fixtureThreadId, "fork: new threadId");
    assert(r.data.previousThreadId === fixtureThreadId, "fork: previousThreadId reported");
    forkedId = r.data.threadId;
  },
  "fork at happy",
);
await expectResponse(
  { id: "v19", type: "get_state", threadId: fixtureThreadId },
  (r) => {
    assert(!r.success && /Unknown threadId/.test(r.error ?? ""), "fork: old threadId ceased");
  },
  "fork old id gone",
);
await expectResponse(
  { id: "v20", type: "get_state", threadId: forkedId },
  (r) => {
    assert(r.success && r.data.sessionId === forkedId, "fork: new threadId usable");
  },
  "fork new id usable",
);

// Clone the forked thread at its current leaf.
let clonedId = null;
await expectResponse(
  { id: "v21", type: "clone", threadId: forkedId },
  (r) => {
    assert(r.success && r.data.threadId !== forkedId, "clone: new threadId");
    assert(r.data.previousThreadId === forkedId, "clone: previousThreadId reported");
    clonedId = r.data.threadId;
  },
  "clone happy",
);
assert(typeof clonedId === "string" && clonedId.length > 0, "clone: captured new id");

await expectResponse(
  { id: "v22", type: "navigate_tree", threadId: clonedId, targetId: "e1" },
  (r) => {
    // createBranchedSession keeps original entry ids, so e1 exists in the
    // clone; navigating without summarize needs no model.
    assert(r.success, `navigate_tree on clone succeeds (${r.error ?? "ok"})`);
  },
  "navigate_tree on clone",
);

// --- lifecycle --------------------------------------------------------------

await new Promise((r) => setTimeout(r, 1500));
assert(seenFrames.includes("heartbeat"), "heartbeat: at least one frame");
// Event-stream assertion runs only where a provider is configured; on a
// keyless machine prompt is rejected at preflight and pi emits no events.
if (promptAccepted) {
  assert(seenFrames.includes("event"), "event frames: at least one (from prompt path)");
} else {
  console.log("SKIP event frames: no provider auth (opt-in real-LLM gate)");
}

hub.stdin.end();
const exitCode = await new Promise((r) => hub.on("exit", r));
clearTimeout(watchdog);
assert(exitCode === 0, `stdin EOF: exit 0 (got ${exitCode})`);
rmSync(agentDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nsmoke: ALL PASS" : `\nsmoke: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
