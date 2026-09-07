// E2E: simulates an Electron client driving EVERY protocol command through a
// real LLM (GLM via .env: GLM_BASE_URL / GLM_API_KEY / GLM_MODEL — the key is
// never printed, written to disk, or echoed in frames).
// Opt-in gate (needs .env): npm run e2e
//
// Journey: model catalog -> thread -> streaming prompt w/ read tool -> steer
// queue -> permission dialog round-trip (real agent bash call) -> rule-blocked
// tool call -> direct bash (allowed + blocked) -> stats/entries cursor ->
// fork/clone/navigate -> resume-after-stop -> abort -> compact -> leak scan.
// Worker-architecture journeys (docs/migration/design.md §6): early-fork
// survival, kill -9 resilience (exactly-one synthesized failure + thread_died
// + auto-recovery), concurrent same-path resume, idle retire -> transparent
// wake, host SIGKILL -> workers self-exit via stdin EOF.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const assert = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failures++;
};

const watchdog = setTimeout(() => {
  console.error(
    "FAIL e2e timed out; frames:",
    seen
      .map((f) => f.type)
      .slice(-30)
      .join(","),
  );
  process.exit(1);
}, 360_000);

// --- environment -------------------------------------------------------------
const env = {};
for (const line of (await Bun.file(".env").text()).split("\n")) {
  const i = line.indexOf("=");
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const apiKey = env.GLM_API_KEY;
const modelId = env.GLM_MODEL;
const baseUrl = env.GLM_BASE_URL.replace(/\/chat\/completions$/, "");
if (!apiKey || !modelId || !baseUrl) {
  console.error("FAIL .env must define GLM_BASE_URL, GLM_API_KEY, GLM_MODEL");
  process.exit(1);
}

const agentDir = mkdtempSync(join(tmpdir(), "pai-cli-e2e-agent-"));
const projectDir = mkdtempSync(join(tmpdir(), "pai-cli-e2e-proj-"));
mkdirSync(agentDir, { recursive: true });
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      glm: {
        baseUrl,
        api: "openai-completions",
        apiKey: "$GLM_API_KEY",
        models: [{ id: modelId }],
      },
    },
  }),
);
writeFileSync(join(projectDir, "note.txt"), "e2e-secret-42\n");
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false }));

// --- hub client (what an Electron main process would be) ----------------------
// Short idle-retire window so the retire -> wake journey runs within the e2e
// budget (production default is 15min; see docs/migration/design.md §2).
const hub = spawn("bun", ["src/cli.ts"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    GLM_API_KEY: apiKey,
    PAI_IDLE_RETIRE_MS: "3000",
  },
});
let stderrText = "";
hub.stderr.setEncoding("utf8");
hub.stderr.on("data", (c) => {
  stderrText += c;
});

const seen = [];
const allFrames = [];
let buf = "";
hub.stdout.setEncoding("utf8");
hub.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    let line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    const frame = JSON.parse(line);
    seen.push(frame.type);
    allFrames.push(frame);
  }
});

const pending = new Map();
const poll = (id) => {
  const f = allFrames.find((f) => f.type === "response" && f.id === id);
  return f;
};
const send = (cmd) =>
  new Promise((resolve, reject) => {
    pending.set(cmd.id, resolve);
    hub.stdin.write(JSON.stringify(cmd) + "\n");
    const t0 = Date.now();
    const t = setInterval(() => {
      const f = poll(cmd.id);
      if (f) {
        clearInterval(t);
        pending.delete(cmd.id);
        resolve(f);
      } else if (Date.now() - t0 > 120_000) {
        clearInterval(t);
        reject(new Error(`response timeout for ${cmd.id} (${cmd.type})`));
      }
    }, 30);
  });
const waitEvent = (pred, label, ms = 120_000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      const f = allFrames.find((f) => f.type === "event" && pred(f.event));
      if (f) {
        clearInterval(t);
        resolve(f.event);
      } else if (Date.now() - t0 > ms) {
        clearInterval(t);
        reject(new Error(`event timeout: ${label}`));
      }
    }, 100);
  });
const nextRequestId = (() => {
  const ids = new Set();
  return () => {
    const f = allFrames.find(
      (f) => f.type === "ui_request" && f.method === "confirm" && !ids.has(f.requestId),
    );
    if (f) ids.add(f.requestId);
    return f;
  };
})();
const waitConfirm = (ms = 120_000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      const f = nextRequestId();
      if (f) {
        clearInterval(t);
        resolve(f);
      } else if (Date.now() - t0 > ms) {
        clearInterval(t);
        reject(new Error("timeout waiting for confirm dialog"));
      }
    }, 100);
  });
const assistantTexts = (msgs) =>
  msgs
    .filter((m) => m.role === "assistant")
    .map((m) =>
      Array.isArray(m.content) ? m.content.map((c) => c.text ?? "").join("") : String(m.content),
    );
const waitIdle = (threadId, ms = 120_000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(async () => {
      const s = await send({
        id: `idle-${t0}-${Math.random()}`,
        type: "get_state",
        threadId,
      }).catch(() => undefined);
      if (s?.success && s.data.isStreaming === false && s.data.isCompacting === false) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(t);
        reject(new Error("timeout waiting for thread idle"));
      }
    }, 300);
  });
const waitAssistantContains = (threadId, needle, ms = 150_000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(async () => {
      const r = await send({
        id: `contains-${t0}-${Math.random()}`,
        type: "get_messages",
        threadId,
      }).catch(() => undefined);
      if (r?.success && assistantTexts(r.data.messages).some((text) => text.includes(needle))) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(t);
        reject(new Error(`timeout waiting for assistant text: ${needle}`));
      }
    }, 400);
  });

// --- 1. catalog + auth state ---------------------------------------------------
{
  const r = await send({ id: "e1", type: "get_models" });
  const glm = r.data.models.filter((m) => m.provider === "glm");
  assert(r.success && glm.some((m) => m.id === modelId), "get_models: glm model present");
}
{
  const r = await send({ id: "e2", type: "auth/list" });
  assert(
    r.success && Array.isArray(r.data.credentials),
    "auth/list: works (custom provider auth comes from env)",
  );
}

// --- 2. thread + metadata ------------------------------------------------------
const start = await send({
  id: "e3",
  type: "thread/start",
  cwd: projectDir,
  provider: "glm",
  modelId,
});
assert(start.success, `thread/start with model (${start.error ?? "ok"})`);
let tid = start.data.threadId;
const sessionFile = start.data.sessionPath;

{
  const r = await send({ id: "e4", type: "set_session_name", threadId: tid, name: "e2e-journey" });
  assert(r.success, "set_session_name");
  const s = await send({ id: "e5", type: "get_state", threadId: tid });
  assert(
    s.data.sessionName === "e2e-journey" && s.data.model?.id === modelId,
    "get_state: name + model",
  );
}

// --- 3. real prompt with read tool + streaming ----------------------------------
{
  const r = await send({
    id: "e6",
    type: "prompt",
    threadId: tid,
    message:
      "Read the file note.txt in the current working directory and reply with exactly its content.",
  });
  assert(r.success, "prompt(read task) accepted");
  await waitEvent((e) => e.type === "tool_execution_start", "read tool start");
  await waitEvent((e) => e.type === "agent_settled", "read task settled");
  const msgs = (await send({ id: "e7", type: "get_messages", threadId: tid })).data.messages;
  const texts = assistantTexts(msgs).join("\n");
  assert(texts.includes("e2e-secret-42"), "agent read the file and reported the secret");
  const delta = allFrames.find(
    (f) =>
      f.type === "event" &&
      f.event?.type === "message_update" &&
      f.event?.assistantMessageEvent?.type === "text_delta",
  );
  assert(!!delta, "streaming text_delta frames present");
  assert(
    !("partial" in (delta.event.assistantMessageEvent ?? {})),
    "partial snapshot stripped from delta frames",
  );
  assert(!("message" in delta.event), "cumulative message stripped from delta frames");
}

// --- 4. follow-up queue during streaming ----------------------------------------
{
  const r = await send({
    id: "e8",
    type: "prompt",
    threadId: tid,
    message: "List the numbers 1 to 30, one per line, nothing else.",
  });
  assert(r.success, "prompt(list task) accepted");
  const fu = await send({
    id: "e9",
    type: "follow_up",
    threadId: tid,
    message: "After the listing completes, reply with exactly: FOLLOWED",
  });
  assert(fu.success, "follow_up queued while streaming");
  await waitEvent((e) => e.type === "queue_update", "queue_update event");
  await waitAssistantContains(tid, "FOLLOWED");
  assert(true, "follow-up delivered and answered");
  await waitIdle(tid);
}

// --- 5. permission dialog round-trip (real agent bash call, ask mode) -----------
{
  const r = await send({
    id: "e11",
    type: "prompt",
    threadId: tid,
    message:
      "Use the bash tool to run exactly this command: cat note.txt — then reply with its content.",
  });
  assert(r.success, "prompt(bash task) accepted");
  const dialog = await waitConfirm();
  assert(
    dialog.threadId === tid &&
      typeof dialog.message === "string" &&
      dialog.message.includes("cat note.txt"),
    "confirm dialog shows the command",
  );
  const ack = await send({
    id: "e12",
    type: "ui_response",
    requestId: dialog.requestId,
    payload: { confirmed: true },
  });
  assert(ack.success, "ui_response(allow) acked");
  await waitEvent((e) => e.type === "agent_settled", "gated bash settled");
  await waitIdle(tid);
  const msgs = (await send({ id: "e13", type: "get_messages", threadId: tid })).data.messages;
  const toolResults = msgs.filter((m) => m.role === "toolResult" && m.toolName === "bash");
  assert(
    toolResults.some((m) => JSON.stringify(m.content).includes("e2e-secret-42")),
    "allowed bash tool executed and returned file content",
  );
}

// --- 6. rule-blocked agent tool call --------------------------------------------
writeFileSync(
  join(agentDir, "permission-rules.json"),
  JSON.stringify({
    bash: { allowPatterns: ["cat *", "echo *"], blockPatterns: ["*blocked-e2e*"] },
  }),
);
// Agent-side block enforcement depends on the model choosing to call the
// tool (non-deterministic across models); the gate's block path is covered
// deterministically below via direct bash — both routes run the SAME
// checkPermission(). The agent-side ASK path was already exercised for real
// in section 5 (dialog round-trip).

// --- 7. direct bash: allowed + blocked + streaming -------------------------------
{
  const before = allFrames.filter(
    (f) => f.type === "event" && f.event?.type === "bash_execution_update",
  ).length;
  const r = await send({
    id: "e16",
    type: "bash",
    threadId: tid,
    command: "echo e2e-direct-marker",
  });
  assert(r.success && /e2e-direct-marker/.test(r.data.output ?? ""), "direct bash: output");
  assert(
    allFrames.filter((f) => f.type === "event" && f.event?.type === "bash_execution_update")
      .length > before,
    "direct bash: streamed via event frames",
  );
  const blocked = await send({
    id: "e17",
    type: "bash",
    threadId: tid,
    command: "echo blocked-e2e",
  });
  assert(
    !blocked.success && /Blocked by permission rules/.test(blocked.error ?? ""),
    "direct bash: rule-blocked",
  );
  const idle = await send({ id: "e18", type: "abort_bash", threadId: tid });
  assert(idle.success, "abort_bash idle: success");
}

// --- 8. stats + entries cursor + tree + fork points ------------------------------
{
  const stats = await send({ id: "e19", type: "get_session_stats", threadId: tid });
  assert(
    stats.success &&
      typeof stats.data.tokens?.total === "number" &&
      stats.data.userMessages >= 2 &&
      stats.data.assistantMessages >= 2,
    "get_session_stats: real session usage recorded",
  );

  const entries1 = await send({ id: "e20", type: "get_entries", threadId: tid });
  const ids1 = entries1.data.entries.map((e) => e.id);
  assert(entries1.success && ids1.length >= 6, "get_entries: full history");

  const cursor = ids1[ids1.length - 3];
  const entries2 = await send({ id: "e21", type: "get_entries", threadId: tid, since: cursor });
  assert(
    entries2.success &&
      entries2.data.entries.length >= 1 &&
      !entries2.data.entries.some((e) => ids1.indexOf(e.id) <= ids1.indexOf(cursor)),
    "get_entries since cursor: only newer entries",
  );

  const tree = await send({ id: "e22", type: "get_tree", threadId: tid });
  assert(
    tree.success && Array.isArray(tree.data.tree) && typeof tree.data.leafId === "string",
    "get_tree",
  );

  const forkMsgs = await send({ id: "e23", type: "get_fork_messages", threadId: tid });
  assert(
    forkMsgs.success && forkMsgs.data.messages.some((m) => /note\.txt/.test(m.text ?? "")),
    "get_fork_messages: user prompts listed",
  );

  const firstUser = entries1.data.entries.find((e) => e.message?.role === "user");

  // Clone re-keys the thread (same as fork). The clone originates from a
  // persisted file, so forking IT afterwards stays on pi's persisted path.
  const clone = await send({ id: "e27", type: "clone", threadId: tid });
  assert(
    clone.success && clone.data.threadId !== tid && clone.data.previousThreadId === tid,
    `clone (${(clone.error ?? "ok").slice(0, 120)})`,
  );
  const clonedId = clone.data.threadId;
  const cloneOldGone = await send({ id: "e27b", type: "get_state", threadId: tid });
  assert(
    !cloneOldGone.success && /Unknown threadId/.test(cloneOldGone.error ?? ""),
    "clone: old id ceased",
  );
  tid = clonedId;

  const fork = await send({
    id: "e24",
    type: "fork",
    threadId: tid,
    entryId: firstUser.id,
    position: "at",
  });
  assert(
    fork.success && fork.data.threadId !== tid && fork.data.previousThreadId === tid,
    `fork at first user message (${(fork.error ?? "ok").slice(0, 60)})`,
  );
  const forkedId = fork.data.threadId;
  const oldGone = await send({ id: "e25", type: "get_state", threadId: tid });
  assert(!oldGone.success && /Unknown threadId/.test(oldGone.error ?? ""), "fork: old id ceased");
  const newState = await send({ id: "e26", type: "get_state", threadId: forkedId });
  assert(newState.success, "fork: new id usable");

  const forkedEntries = await send({ id: "e28", type: "get_entries", threadId: forkedId });
  const target = forkedEntries.data.entries.find((e) => e.message?.role === "user");
  const nav = await send({
    id: "e29",
    type: "navigate_tree",
    threadId: forkedId,
    targetId: target.id,
  });
  assert(nav.success, `navigate_tree on fork (${nav.error ?? "ok"})`);
  tid = forkedId; // continue the journey on the fork
}

// --- 9. resume-after-stop + listing ----------------------------------------------
{
  const state = await send({ id: "e30a", type: "get_state", threadId: tid });
  const openFile = state.data.sessionFile;
  const dup = await send({ id: "e30", type: "thread/resume", sessionPath: openFile });
  assert(!dup.success, "thread/resume while open: rejected");
  const stop = await send({ id: "e31", type: "thread/stop", threadId: tid });
  assert(stop.success, "thread/stop");
  const again = await send({ id: "e32", type: "thread/stop", threadId: tid });
  assert(again.success, "thread/stop idempotent");
  const resumed = await send({ id: "e33", type: "thread/resume", sessionPath: sessionFile });
  assert(resumed.success, "thread/resume after stop: reopened");
  tid = resumed.data.threadId;
}
{
  const list = await send({ id: "e34", type: "thread/list" });
  assert(
    list.success && list.data.threads.some((t) => t.threadId === tid),
    "thread/list contains live thread",
  );
  const saved = await send({ id: "e35", type: "thread/list_saved", cwd: projectDir });
  assert(saved.success && saved.data.sessions.length >= 1, "thread/list_saved: sessions found");
  const cmds = await send({ id: "e36", type: "get_commands", threadId: tid });
  assert(cmds.success && Array.isArray(cmds.data.commands), "get_commands");
  const cleared = await send({ id: "e37", type: "clear_queue", threadId: tid });
  assert(cleared.success && Array.isArray(cleared.data.steering), "clear_queue");
  const levels = await send({ id: "e38", type: "get_thinking_levels", threadId: tid });
  assert(levels.success && Array.isArray(levels.data.levels), "get_thinking_levels");
  const setLevel = await send({
    id: "e39",
    type: "set_thinking_level",
    threadId: tid,
    level: "off",
  });
  assert(setLevel.success, "set_thinking_level");
}

// --- 10. abort mid-generation ------------------------------------------------------
{
  const r = await send({
    id: "e40",
    type: "prompt",
    threadId: tid,
    message: "Count slowly from 1 to 200, one number per line.",
  });
  assert(r.success, "prompt(long task) accepted");
  await waitEvent(
    (e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta",
    "first delta",
  );
  const abort = await send({ id: "e41", type: "abort", threadId: tid });
  assert(abort.success, "abort accepted");
  await waitEvent((e) => e.type === "agent_settled", "aborted run settled");
}

// --- 11. compact -------------------------------------------------------------------
{
  const r = await send({ id: "e42", type: "compact", threadId: tid });
  // Both outcomes are contract-correct: compact succeeds with a summary, or
  // pi declines because the context is below the compaction threshold.
  assert(
    (r.success && typeof r.data.summary === "string") || /too small/.test(r.error ?? ""),
    `compact (${(r.error ?? "ok").slice(0, 60)})`,
  );
}

// --- 12. worker journeys (docs/migration/design.md §4/§5/§6) -----------------------

// 12a. fork failure BEFORE teardown keeps the thread usable (v0.3 semantics;
// api.md corrected — migration.md U6). A bogus entryId fails validation
// inside pi before any session teardown happens.
{
  const r = await send({
    id: "w1",
    type: "fork",
    threadId: tid,
    entryId: "no-such-entry",
    position: "at",
  });
  assert(!r.success, "fork(bogus entry) fails");
  const s = await send({ id: "w2", type: "get_state", threadId: tid });
  assert(s.success, "thread still usable after early fork failure");
  const died = allFrames.filter((f) => f.type === "thread_died");
  assert(died.length === 0, "no thread_died for early fork failure");
}

// 12b. kill -9 the worker mid-command: exactly one synthesized failure,
// thread_died, entry goes dead, and the next command transparently recovers.
{
  const childPids = String(
    spawnSync("pgrep", ["-P", String(hub.pid)], { encoding: "utf8" }).stdout ?? "",
  )
    .split("\n")
    .filter(Boolean);
  assert(childPids.length === 1, `exactly one worker process (got ${childPids.length})`);
  const bashP = send({
    id: "w3",
    type: "bash",
    threadId: tid,
    command: "echo pai-kill-marker && sleep 30",
  });
  await new Promise((r) => setTimeout(r, 800)); // let the bash start running
  process.kill(Number(childPids[0]), "SIGKILL");
  const bashR = await bashP;
  assert(
    !bashR.success && /worker died/.test(bashR.error ?? ""),
    "in-flight bash gets its one failure",
  );
  assert(
    allFrames.filter((f) => f.type === "response" && f.id === "w3").length === 1,
    "exactly one response for the killed command",
  );
  const died = allFrames.find((f) => f.type === "thread_died" && f.threadId === tid);
  assert(!!died, "thread_died emitted for the killed thread");
  const list1 = await send({ id: "w4", type: "thread/list" });
  assert(
    list1.data.threads.find((t) => t.threadId === tid)?.state === "dead",
    "thread/list shows dead after worker kill",
  );
  const s = await send({ id: "w5", type: "get_state", threadId: tid });
  assert(s.success, "next command transparently revives the dead thread (respawn+resume)");
  const list2 = await send({ id: "w6", type: "thread/list" });
  assert(
    list2.data.threads.find((t) => t.threadId === tid)?.state === "live",
    "thread/list shows live again after recovery",
  );
}

// 12c. concurrent resume of the same session path: exactly one wins
// (spawning counts as occupied — design §5).
{
  const openFile = (await send({ id: "w8", type: "get_state", threadId: tid })).data.sessionFile;
  const stop = await send({ id: "w7", type: "thread/stop", threadId: tid });
  assert(stop.success, "stop before concurrent resume test");
  const [a, b] = await Promise.all([
    send({ id: "w9", type: "thread/resume", sessionPath: openFile }),
    send({ id: "w10", type: "thread/resume", sessionPath: openFile }),
  ]);
  const wins = [a, b].filter((r) => r.success);
  const losses = [a, b].filter((r) => !r.success);
  assert(wins.length === 1, `concurrent same-path resume: exactly one winner (${wins.length})`);
  assert(
    losses.length === 1 && /already open/.test(losses[0].error ?? ""),
    "loser rejected with already-open",
  );
  tid = wins[0].data.threadId;
}

// 12d. idle retire -> parked -> transparent wake. Observer commands (the
// waitIdle poller) must not keep the worker alive.
{
  await waitIdle(tid);
  let parked = false;
  for (let i = 0; i < 40 && !parked; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const list = await send({ id: `w11-${i}`, type: "thread/list" }); // host-local: never wakes
    parked = list.data.threads.find((t) => t.threadId === tid)?.state === "parked";
  }
  assert(parked, "idle worker retired to parked (observer polling did not keep it alive)");
  const children = String(
    spawnSync("pgrep", ["-P", String(hub.pid)], { encoding: "utf8" }).stdout ?? "",
  )
    .split("\n")
    .filter(Boolean);
  assert(children.length === 0, `parked thread has no worker process (got ${children.length})`);
  const s = await send({ id: "w12", type: "get_state", threadId: tid });
  assert(s.success, "command to parked thread wakes it transparently");
  const list = await send({ id: "w13", type: "thread/list" });
  assert(
    list.data.threads.find((t) => t.threadId === tid)?.state === "live",
    "woken thread is live again",
  );
}

// 12e. host SIGKILL -> every worker self-exits via stdin EOF (no orphans).
{
  const agentDir2 = mkdtempSync(join(tmpdir(), "pai-cli-e2e-hostkill-"));
  writeFileSync(
    join(agentDir2, "models.json"),
    JSON.stringify({
      providers: {
        glm: {
          baseUrl,
          api: "openai-completions",
          apiKey: "$GLM_API_KEY",
          models: [{ id: modelId }],
        },
      },
    }),
  );
  const proj2 = mkdtempSync(join(tmpdir(), "pai-cli-e2e-proj2-"));
  const host2 = spawn("bun", ["src/cli.ts"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir2,
      GLM_API_KEY: apiKey,
      PAI_IDLE_RETIRE_MS: "3600000",
    },
  });
  host2.stdout.resume();
  host2.stderr.resume();
  // A worker exists only once a conversation starts.
  host2.stdin.write(JSON.stringify({ id: "hk1", type: "thread/start", cwd: proj2 }) + "\n");
  const start2 = await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      // Wait for the worker to exist before killing the host.
      const kids = spawnSync("pgrep", ["-P", String(host2.pid)], { encoding: "utf8" }).stdout ?? "";
      if (kids.trim()) {
        clearInterval(t);
        resolve(kids.trim().split("\n").length);
      } else if (Date.now() - t0 > 30_000) {
        clearInterval(t);
        reject(new Error("host2 worker never spawned"));
      }
    }, 200);
  });
  assert(start2 >= 1, "host2 has a live worker before the kill");
  const kidPids = String(
    spawnSync("pgrep", ["-P", String(host2.pid)], { encoding: "utf8" }).stdout ?? "",
  )
    .split("\n")
    .filter(Boolean)
    .map(Number);
  process.kill(host2.pid, "SIGKILL");
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const alive = kidPids.filter((p) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    });
    gone = alive.length === 0;
  }
  assert(gone, "workers self-exit within 20s after host SIGKILL (stdin EOF)");
  rmSync(agentDir2, { recursive: true, force: true });
  rmSync(proj2, { recursive: true, force: true });
}

// --- 13. leak scan + lifecycle ------------------------------------------------------
assert(
  !allFrames.some((f) => JSON.stringify(f).includes(apiKey)),
  "API key never appears in any frame",
);
assert(!stderrText.includes(apiKey), "API key never appears on stderr");
assert(seen.includes("heartbeat"), "heartbeat flowing");

hub.stdin.end();
const exitCode = await new Promise((r) => hub.on("exit", r));
clearTimeout(watchdog);
assert(exitCode === 0, `stdin EOF: exit 0 (got ${exitCode})`);
rmSync(agentDir, { recursive: true, force: true });
rmSync(projectDir, { recursive: true, force: true });

console.log(failures === 0 ? "\ne2e: ALL PASS" : `\ne2e: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
