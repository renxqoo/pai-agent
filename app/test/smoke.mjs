// Contract-level smoke (real spawn + stdio): walks the command matrix from
// docs/design.md "Testing Criteria" and asserts the response contract —
// exactly one response per id, id echoed, error text in response.error.
// Run: bun test/smoke.mjs   (from app/)

import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
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
    hub.stdin.write(`${JSON.stringify(cmd)}\n`);
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
    ({ threadId } = r.data);
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
// pi persists lazily: the session path is reported before the FILE exists.
// Resuming it must fail loudly (host-side validation) instead of spawning a
// worker over a phantom path.
assert(typeof stateFrame.data.sessionFile === "string", "get_state: sessionFile is a path");
await expectResponse(
  { id: "6", type: "thread/resume", sessionPath: stateFrame.data.sessionFile },
  (r) => {
    assert(
      !r.success && /Session file not found/.test(r.error ?? ""),
      "thread/resume unpersisted session file: rejected",
    );
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
await new Promise((r) => {
  setTimeout(r, 300);
});
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
  await new Promise((r) => {
    setTimeout(r, 500);
  });
  const overflow = allFrames.filter((f) => f.type === "response" && /exceeds/.test(f.error ?? ""));
  assert(overflow.length > 0, "oversized line: reported via parse failure");
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
await new Promise((r) => {
  setTimeout(r, 300);
});
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

// --- v0.6: bash wall clock + get_host_info ------------------------------------

// The wall-clock probe needs a hanging command through the gate: allow
// sleep * (hot-read; the blocked pattern below still denies its own shape).
writeFileSync(
  join(agentDir, "permission-rules.json"),
  JSON.stringify({
    bash: { allowPatterns: ["echo *", "sleep *"], blockPatterns: ["echo blocked-*"] },
  }),
);

// timeoutMs validation matrix (table-driven; happy bounds in unit tests).
for (const [label, timeoutMs] of [
  ["negative", -1],
  ["fractional", 1.5],
  ["over-max", 86_400_001],
  ["string", "1000"],
]) {
  await expectResponse(
    { id: `v12t-${label}`, type: "bash", threadId, command: "echo x", timeoutMs },
    (r) => {
      assert(
        !r.success && /timeoutMs must be an integer/.test(r.error ?? ""),
        `bash: timeoutMs ${label} rejected`,
      );
    },
    `bash timeoutMs ${label} error`,
  );
}
await expectResponse(
  { id: "v12t-ok", type: "bash", threadId, command: "echo timeout-zero-ok", timeoutMs: 0 },
  (r) => {
    assert(r.success, "bash: timeoutMs 0 disables the wall clock");
  },
  "bash timeoutMs zero ok",
);
{
  const t0 = Date.now();
  await expectResponse(
    { id: "v12t-fire", type: "bash", threadId, command: "sleep 30", timeoutMs: 400 },
    (r) => {
      const elapsed = Date.now() - t0;
      assert(r.success, "bash: timed-out command responds success (abort shape)");
      assert(r.data.cancelled === true, "bash: timed-out command reports cancelled:true");
      assert(elapsed < 5_000, `bash: wall clock fired promptly (${elapsed}ms)`);
    },
    "bash timeout fires",
  );
}

await expectResponse(
  { id: "hi1", type: "get_host_info" },
  (r) => {
    assert(r.success, "get_host_info: success");
    const d = r.data;
    assert(
      typeof d.version === "string" &&
        typeof d.piVersion === "string" &&
        typeof d.bunVersion === "string",
      "get_host_info: version strings present",
    );
    assert(typeof d.pid === "number" && d.pid > 0, "get_host_info: pid");
    assert(typeof d.uptimeMs === "number" && d.uptimeMs >= 0, "get_host_info: uptimeMs");
    assert(typeof d.rssBytes === "number" && d.rssBytes > 0, "get_host_info: rssBytes");
    assert(
      d.threads.live >= 1 &&
        typeof d.threads.parked === "number" &&
        typeof d.threads.dead === "number",
      "get_host_info: thread state counts",
    );
    assert(d.subagents.running === 0, "get_host_info: no running subagents on a quiet host");
    const lim = d.limits;
    assert(
      lim.maxThreads === 32 &&
        lim.idleRetireMs === 900_000 &&
        lim.workerStaleMs === 30_000 &&
        lim.workerExitTimeoutMs === 10_000 &&
        lim.maxSubagents === 16 &&
        lim.bashTimeoutMs === 600_000,
      "get_host_info: limits echo the documented defaults",
    );
  },
  "get_host_info shape",
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
    assert(r.success && r.data.entries.length > 0, "get_entries: bash created session entries");
    firstEntryId = r.data.entries[0].id;
    assert(typeof firstEntryId === "string", "get_entries: entry ids are strings");
  },
  "get_entries after bash",
);

{
  // Pagination contract (design.md): limit keeps the most recent window
  // entries and reports hasMore; before pages backward from a known id.
  const total = (await send({ id: "v13a", type: "get_entries", threadId })).data.entries.length;
  const page = await send({
    id: "v13b",
    type: "get_entries",
    threadId,
    limit: Math.max(1, total - 1),
  });
  assert(page.success, "get_entries limit: success");
  assert(page.data.entries.length === Math.max(1, total - 1), "get_entries limit: window size");
  assert(page.data.hasMore === true, "get_entries limit: hasMore when truncated");
  const older = await send({
    id: "v13c",
    type: "get_entries",
    threadId,
    before: page.data.entries[0].id,
  });
  assert(older.success && older.data.entries.length === 1, "get_entries before: one older entry");
  assert(older.data.hasMore === false, "get_entries before: hasMore false without truncation");
  const exact = await send({ id: "v13d", type: "get_entries", threadId, limit: total });
  assert(exact.data.hasMore === false, "get_entries limit: hasMore false when exact");
  const badLimit = await send({ id: "v13e", type: "get_entries", threadId, limit: 0 });
  assert(
    !badLimit.success && /limit/.test(badLimit.error ?? ""),
    "get_entries: invalid limit rejected",
  );
  const badBefore = await send({ id: "v13f", type: "get_entries", threadId, before: "bogus" });
  assert(
    !badBefore.success && /Entry not found/.test(badBefore.error ?? ""),
    "get_entries: bogus before cursor rejected",
  );
}

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
  `${[
    '{"type":"session","version":3,"id":"11111111-1111-1111-1111-111111111111","timestamp":"2026-09-07T00:00:00.000Z","cwd":"/tmp"}',
    '{"type":"message","id":"e1","parentId":null,"timestamp":"2026-09-07T00:00:01.000Z","message":{"role":"user","content":"Hello"}}',
    '{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-09-07T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"provider":"anthropic","model":"fixture-model","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop"}}',
  ].join("\n")}\n`,
);

let fixtureThreadId = null;
await expectResponse(
  { id: "v16a", type: "thread/resume", sessionPath: join(fixtureDir, "no-such-file.jsonl") },
  (r) => {
    // A missing file must fail loudly: silently "resuming" it as a new empty
    // session loses the client's history with a success response.
    assert(
      !r.success && /Session file not found/.test(r.error ?? ""),
      "thread/resume missing file: rejected",
    );
  },
);
await expectResponse(
  { id: "v16b", type: "thread/resume", sessionPath: "relative/fixture-fork.jsonl" },
  (r) => {
    // Relative paths resolve against the HOST cwd (not the client's) —
    // rejected so the failure mode is explicit.
    assert(
      !r.success && /absolute path/.test(r.error ?? ""),
      "thread/resume relative path: rejected",
    );
  },
);
// Red-team pin (external review probe): a pi-format file OUTSIDE the agent
// sessions directory — even one that exists and parses — must not load,
// and get_entries must never serve its contents back.
{
  const smuggled = join(agentDir, "smuggled.jsonl"); // inside agentDir, outside sessions/
  writeFileSync(smuggled, `${JSON.stringify({ type: "session", id: "smuggled" })}\n`);
  await expectResponse({ id: "v16d", type: "thread/resume", sessionPath: smuggled }, (r) => {
    assert(
      !r.success && /inside the agent sessions directory/.test(r.error ?? ""),
      "thread/resume outside sessions dir: rejected",
    );
  });
  // Symlink escape: a link inside sessions/ pointing outside is equally
  // rejected after realpath normalization.
  const link = join(fixtureDir, "escape-link.jsonl");
  symlinkSync(smuggled, link);
  await expectResponse({ id: "v16e", type: "thread/resume", sessionPath: link }, (r) => {
    assert(
      !r.success && /inside the agent sessions directory/.test(r.error ?? ""),
      "thread/resume symlink escape: rejected",
    );
  });
}
await expectResponse(
  { id: "v16", type: "thread/resume", sessionPath: fixturePath },
  (r) => {
    assert(r.success, `thread/resume fixture (${r.error ?? "ok"})`);
    fixtureThreadId = r.data.threadId;
  },
  "thread/resume fixture",
);
await expectResponse(
  { id: "v16c", type: "thread/resume", sessionPath: fixturePath },
  (r) => {
    // True double-open: the same persisted file is already held by v16.
    assert(!r.success && /already open/.test(r.error ?? ""), "thread/resume double-open: rejected");
  },
  "thread/resume double-open",
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

// --- v0.5: per-conversation permission rules (C5 matrix) ----------------------

const sidecarDir = join(agentDir, "permission-rules");
const sidecarPathOf = (id) => join(sidecarDir, `${id}.json`);
function clearSidecarFileQuiet(id) {
  try {
    rmSync(sidecarPathOf(id), { force: true });
  } catch {
    // best effort only: the agent dir is removed at teardown anyway
  }
}

// Fresh conversation for the matrix (earlier threads carry global-rule history).
let permId = null;
await expectResponse(
  { id: "p0", type: "thread/start", cwd: "/tmp" },
  (r) => {
    assert(r.success, `permission matrix thread started (${r.error ?? "ok"})`);
    permId = r.data.threadId;
  },
  "perm thread/start",
);

await expectResponse(
  { id: "p1", type: "get_permission_rules", threadId: permId },
  (r) => {
    // No sidecar yet: reads the global file (written earlier: echo * allow).
    assert(r.success && r.data.source === "global", "get_permission_rules: global source");
    assert(Array.isArray(r.data.rules?.bash?.allowPatterns), "get_permission_rules: global rules");
  },
  "get_permission_rules global",
);

await expectResponse(
  { id: "p2", type: "set_permission_rules", threadId: permId, rules: { mode: "banana" } },
  (r) => {
    assert(!r.success && /rules\.mode/.test(r.error ?? ""), "set: invalid mode rejected");
  },
  "set invalid mode",
);
await expectResponse(
  { id: "p3", type: "set_permission_rules", threadId: permId, rules: { unknownField: 1 } },
  (r) => {
    assert(!r.success && /unknown rules field/.test(r.error ?? ""), "set: unknown field rejected");
  },
  "set unknown field",
);
await expectResponse(
  { id: "p4", type: "set_permission_rules", threadId: "../evil", rules: { mode: "ask" } },
  (r) => {
    assert(!r.success && /Invalid threadId/.test(r.error ?? ""), "set: unsafe threadId rejected");
    assert(!existsSync(join(agentDir, "evil.json")), "set: unsafe threadId wrote no file");
  },
  "set unsafe threadId",
);
await expectResponse(
  { id: "p4b", type: "get_permission_rules", threadId: "../evil" },
  (r) => {
    assert(!r.success && /Invalid threadId/.test(r.error ?? ""), "get: unsafe threadId rejected");
  },
  "get unsafe threadId",
);
await expectResponse(
  { id: "p4c", type: "set_permission_rules", threadId: permId },
  (r) => {
    assert(!r.success && /rules must be/.test(r.error ?? ""), "set: missing rules rejected");
  },
  "set missing rules",
);

await expectResponse(
  { id: "p5", type: "set_permission_rules", threadId: permId, rules: { mode: "block-all" } },
  (r) => {
    assert(r.success && r.data.source === "thread", "set: success reports thread source");
    assert(existsSync(sidecarPathOf(permId)), "set: sidecar file created");
  },
  "set block-all",
);
await expectResponse(
  { id: "p6", type: "get_permission_rules", threadId: permId },
  (r) => {
    assert(r.success && r.data.source === "thread", "get: thread source after set");
    assert(r.data.rules?.mode === "block-all", "get: sidecar content");
  },
  "get after set",
);
await expectResponse(
  { id: "p7", type: "bash", threadId: permId, command: "echo sidecar-blocked" },
  (r) => {
    // Sidecar block-all overrides the global allowPatterns ("echo *").
    assert(!r.success && /Blocked by permission rules/.test(r.error ?? ""), "bash: sidecar wins");
  },
  "bash blocked by sidecar",
);

await expectResponse(
  { id: "p8", type: "get_permission_rules", threadId: clonedId },
  (r) => {
    assert(r.success && r.data.source === "global", "isolation: other thread still global");
  },
  "isolation get",
);
await expectResponse(
  { id: "p9", type: "bash", threadId: clonedId, command: "echo iso-marker" },
  (r) => {
    assert(
      r.success && /iso-marker/.test(r.data.output ?? ""),
      "isolation: other thread unaffected",
    );
  },
  "isolation bash",
);

await expectResponse(
  { id: "p10", type: "set_permission_rules", threadId: permId, rules: null },
  (r) => {
    assert(r.success && r.data.source === "global", "clear: reports global source");
    assert(!existsSync(sidecarPathOf(permId)), "clear: sidecar file removed");
  },
  "clear sidecar",
);
await expectResponse(
  { id: "p11", type: "bash", threadId: permId, command: "echo after-clear" },
  (r) => {
    assert(r.success && /after-clear/.test(r.data.output ?? ""), "clear: falls back to global");
  },
  "bash after clear",
);

// stop -> resume keeps the sidecar (cross-worker persistence). Uses the
// hand-crafted fixture: pi persists a session file only after the first
// assistant message (session-manager _persist), so a bash-only thread has
// no file and resume would synthesize a new id (v1 boundary, plan §7).
let persistId = null;
await expectResponse(
  { id: "p12", type: "thread/resume", sessionPath: fixturePath },
  (r) => {
    assert(r.success, `persistence: fixture resumed (${r.error ?? "ok"})`);
    persistId = r.data.threadId;
  },
  "persistence resume fixture",
);
await expectResponse(
  { id: "p12b", type: "set_permission_rules", threadId: persistId, rules: { mode: "block-all" } },
  (r) => {
    assert(r.success, "persistence: sidecar set");
  },
  "persistence set",
);
await expectResponse(
  { id: "p12c", type: "get_state", threadId: persistId },
  (r) => {
    assert(r.data.sessionFile === fixturePath, "persistence: session file is the fixture");
  },
  "persistence session file",
);
await expectResponse(
  { id: "p13", type: "thread/stop", threadId: persistId },
  (r) => {
    assert(r.success, "persistence: stopped");
  },
  "persistence stop",
);
await expectResponse(
  { id: "p14", type: "thread/resume", sessionPath: fixturePath },
  (r) => {
    assert(
      r.success && r.data.threadId === persistId,
      "persistence: resumed same id (stop settled before resume)",
    );
  },
  "persistence resume",
);
await expectResponse(
  { id: "p15", type: "get_permission_rules", threadId: persistId },
  (r) => {
    assert(r.success && r.data.source === "thread", "persistence: sidecar survived the cycle");
  },
  "persistence get",
);
await expectResponse(
  { id: "p16", type: "bash", threadId: persistId, command: "echo post-resume" },
  (r) => {
    assert(
      !r.success && /Blocked by permission rules/.test(r.error ?? ""),
      "persistence: still blocked",
    );
  },
  "persistence bash blocked",
);
await expectResponse(
  { id: "p16b", type: "set_permission_rules", threadId: persistId, rules: null },
  (r) => {
    assert(r.success, "persistence: cleanup clear");
  },
  "persistence clear",
);

// Session replacement copies the sidecar to the new id.
const cloneRules = { bash: { allowPatterns: ["echo side-*"] } };
await expectResponse(
  { id: "p17", type: "set_permission_rules", threadId: clonedId, rules: cloneRules },
  (r) => {
    assert(r.success, "clone-copy: sidecar set on source");
  },
  "clone-copy set",
);
let reclonedId = null;
await expectResponse(
  { id: "p18", type: "clone", threadId: clonedId },
  (r) => {
    assert(r.success, "clone-copy: clone succeeded");
    reclonedId = r.data.threadId;
  },
  "clone-copy clone",
);
await expectResponse(
  { id: "p19", type: "get_permission_rules", threadId: reclonedId },
  (r) => {
    assert(r.success && r.data.source === "thread", "clone-copy: new id has sidecar");
    assert(
      JSON.stringify(r.data.rules) === JSON.stringify(cloneRules),
      "clone-copy: content identical",
    );
  },
  "clone-copy get",
);
await expectResponse(
  { id: "p20", type: "get_permission_rules", threadId: clonedId },
  (r) => {
    assert(r.success && r.data.source === "thread", "clone-copy: source sidecar untouched");
  },
  "clone-copy source intact",
);

// Fork copies the sidecar too (§4-C5: fork/clone both named). Uses the
// fixture-backed thread: pi requires the current session file to exist on
// disk before forking (agent-session-runtime), and branched sessions from
// clones are not necessarily flushed yet.
await expectResponse(
  { id: "p20a", type: "set_permission_rules", threadId: persistId, rules: cloneRules },
  (r) => {
    assert(r.success, "fork-copy: sidecar set");
  },
  "fork-copy set",
);
let forkEntryId = null;
await expectResponse(
  { id: "p20b", type: "get_entries", threadId: persistId },
  (r) => {
    assert(r.success && r.data.entries.length > 0, "fork-copy: entries available");
    forkEntryId = r.data.entries.at(-1).id;
  },
  "fork-copy entries",
);
let reforkedId = null;
await expectResponse(
  { id: "p20c", type: "fork", threadId: persistId, entryId: forkEntryId, position: "at" },
  (r) => {
    assert(r.success, `fork-copy: fork succeeded (${r.error ?? "ok"})`);
    reforkedId = r.data.threadId;
  },
  "fork-copy fork",
);
await expectResponse(
  { id: "p20d", type: "get_permission_rules", threadId: reforkedId },
  (r) => {
    assert(r.success && r.data.source === "thread", "fork-copy: new id has sidecar");
    assert(
      JSON.stringify(r.data.rules) === JSON.stringify(cloneRules),
      "fork-copy: content identical",
    );
  },
  "fork-copy get",
);

// Concurrent sets: the file must be exactly one of the two payloads (atomic).
{
  const a = send({
    id: "p21a",
    type: "set_permission_rules",
    threadId: permId,
    rules: { mode: "ask" },
  });
  const b = send({
    id: "p21b",
    type: "set_permission_rules",
    threadId: permId,
    rules: { mode: "block-all" },
  });
  const [ra, rb] = await Promise.all([a, b]);
  assert(ra.success && rb.success, "concurrent set: both succeed");
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(sidecarPathOf(permId), "utf8"));
  } catch {
    assert(false, "concurrent set: file is valid JSON (no tearing)");
  }
  assert(
    parsed?.mode === "ask" || parsed?.mode === "block-all",
    "concurrent set: file is one of the two writes",
  );
}

// Non-live threads never wake a worker for rule access (host-local).
{
  const before = await send({ id: "p22a", type: "thread/list" });
  const liveBefore = before.data.threads.filter((t) => t.state === "live").length;
  await expectResponse(
    { id: "p22b", type: "get_permission_rules", threadId: "ghost-thread-1" },
    (r) => {
      assert(r.success && r.data.source === "global", "ghost get: global, no error");
    },
    "ghost get",
  );
  await expectResponse(
    {
      id: "p22c",
      type: "set_permission_rules",
      threadId: "ghost-thread-1",
      rules: { mode: "ask" },
    },
    (r) => {
      assert(r.success, "ghost set: accepted without spawning a worker");
    },
    "ghost set",
  );
  const after = await send({ id: "p22d", type: "thread/list" });
  const liveAfter = after.data.threads.filter((t) => t.state === "live").length;
  assert(liveAfter === liveBefore, "ghost access: live worker count unchanged (no wake)");
  assert(existsSync(sidecarPathOf("ghost-thread-1")), "ghost set: file written");
  clearSidecarFileQuiet("ghost-thread-1");
}

// --- v0.5: agents/list (host-local, keyless) -----------------------------------

{
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(
    join(agentDir, "agents", "user-agent.md"),
    "---\nname: user-agent\ndescription: smoke user agent\ntools: bash\n---\nUser prompt.\n",
  );
  const smokeProject = mkdtempSync(join(tmpdir(), "pai-cli-smoke-agents-"));
  mkdirSync(join(smokeProject, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(smokeProject, ".pi", "agents", "proj-agent.md"),
    "---\nname: proj-agent\ndescription: smoke project agent\n---\nProject prompt.\n",
  );

  await expectResponse(
    { id: "q1", type: "agents/list" },
    (r) => {
      assert(r.success && Array.isArray(r.data.agents), "agents/list: array");
      assert(
        r.data.agents.some((a) => a.name === "user-agent"),
        "agents/list: user agent",
      );
      assert(!r.data.agents.some((a) => a.name === "proj-agent"), "agents/list: project hidden");
    },
    "agents/list no thread",
  );
  let trustedId = null;
  await expectResponse(
    { id: "q2", type: "thread/start", cwd: smokeProject, trusted: true },
    (r) => {
      assert(r.success, `trusted thread started (${r.error ?? "ok"})`);
      trustedId = r.data.threadId;
    },
    "agents/list trusted thread start",
  );
  await expectResponse(
    { id: "q3", type: "agents/list", threadId: trustedId },
    (r) => {
      const proj = r.data.agents?.find((a) => a.name === "proj-agent");
      assert(r.success && proj?.source === "project", "agents/list trusted: project visible");
    },
    "agents/list trusted",
  );
  let untrustedId = null;
  await expectResponse(
    { id: "q4", type: "thread/start", cwd: smokeProject },
    (r) => {
      assert(r.success, `untrusted thread started (${r.error ?? "ok"})`);
      untrustedId = r.data.threadId;
    },
    "agents/list untrusted thread start",
  );
  await expectResponse(
    { id: "q5", type: "agents/list", threadId: untrustedId },
    (r) => {
      assert(r.success, "agents/list untrusted: success");
      assert(
        !r.data.agents?.some((a) => a.name === "proj-agent"),
        "agents/list untrusted: project hidden",
      );
    },
    "agents/list untrusted",
  );
  await expectResponse(
    { id: "q6", type: "agents/list", threadId: "ghost-thread-2" },
    (r) => {
      assert(!r.success && /Unknown threadId/.test(r.error ?? ""), "agents/list ghost: failure");
    },
    "agents/list ghost",
  );
  await send({ id: "q7", type: "thread/stop", threadId: trustedId });
  await send({ id: "q8", type: "thread/stop", threadId: untrustedId });
  rmSync(smokeProject, { recursive: true, force: true });
}

// --- lifecycle --------------------------------------------------------------

await new Promise((r) => {
  setTimeout(r, 1500);
});
assert(seenFrames.includes("heartbeat"), "heartbeat: at least one frame");
// Event-stream assertion runs only where a provider is configured; on a
// keyless machine prompt is rejected at preflight and pi emits no events.
if (promptAccepted) {
  assert(seenFrames.includes("event"), "event frames: at least one (from prompt path)");
} else {
  console.log("SKIP event frames: no provider auth (opt-in real-LLM gate)");
}

hub.stdin.end();
const exitCode = await new Promise((r) => {
  hub.on("exit", r);
});
clearTimeout(watchdog);
assert(exitCode === 0, `stdin EOF: exit 0 (got ${exitCode})`);
rmSync(agentDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nsmoke: ALL PASS" : `\nsmoke: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
