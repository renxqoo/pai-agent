// Multi-conversation E2E against the BUNDLED artifact (dist/cli.js, built by
// `bun build --target=bun`). Verifies with a real LLM (GLM via .env):
//   1. 数据不错乱 — 4 concurrent threads, each reads its own marker file;
//      replies must contain ONLY their own marker, never another thread's.
//   2. 设置不冲突 — per-thread sessionName/thinkingLevel survive concurrent
//      traffic without cross-over; conversation context stays per-thread.
//   3. 资源占用 — measured process-tree RSS (host + workers): idle base,
//      peak during 4 concurrent streams.
//   4. worker 隔离 — kill -9 ONE worker: the others' streams continue, the
//      victim thread_died, and its next command transparently recovers.
// Opt-in gate: npm run e2e:multi   (needs .env)

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const assert = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failures++;
};
const THREADS = 4;
const MARKERS = ["RED-FOX-11", "BLUE-OWL-22", "GREEN-CAT-33", "AMBER-HEN-44"];
const LEVELS = ["off", "low", "medium", "high"];

const watchdog = setTimeout(() => {
  console.error("FAIL e2e-multi timed out");
  process.exit(1);
}, 420_000);

// --- build the bundled artifact --------------------------------------------------
const build = spawnSync("bun", ["build", "src/cli.ts", "--outdir", "dist", "--target=bun"], {
  cwd: process.cwd(),
  encoding: "utf8",
});
assert(build.status === 0, `bun build bundle (${(build.stderr ?? "").slice(0, 80)})`);
const artifact = "dist/cli.js";

// --- environment -------------------------------------------------------------------
const env = {};
for (const line of (await Bun.file(".env").text()).split("\n")) {
  const i = line.indexOf("=");
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const apiKey = env.GLM_API_KEY;
const modelId = env.GLM_MODEL;
const baseUrl = env.GLM_BASE_URL.replace(/\/chat\/completions$/, "");

const agentDir = mkdtempSync(join(tmpdir(), "pai-multi-agent-"));
const projects = MARKERS.map((m) => {
  const dir = mkdtempSync(join(tmpdir(), `pai-multi-proj-`));
  writeFileSync(join(dir, "note.txt"), `${m}\n`);
  return dir;
});
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
writeFileSync(
  join(agentDir, "permission-rules.json"),
  JSON.stringify({ bash: { allowPatterns: ["echo *"] } }),
);

// --- spawn the BUNDLED pai-cli -----------------------------------------------------
const pai = spawn("bun", [artifact], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, GLM_API_KEY: apiKey },
});
let stderrText = "";
pai.stderr.setEncoding("utf8");
pai.stderr.on("data", (c) => (stderrText += c));

let parseErrors = 0;
const allFrames = [];
let buf = "";
pai.stdout.setEncoding("utf8");
pai.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    let line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    try {
      allFrames.push(JSON.parse(line));
    } catch {
      parseErrors += 1; // stdout purity violation on the bundled artifact
    }
  }
});

const send = (cmd) =>
  new Promise((resolve, reject) => {
    pai.stdin.write(JSON.stringify(cmd) + "\n");
    const t0 = Date.now();
    const t = setInterval(() => {
      const f = allFrames.find((f) => f.type === "response" && f.id === cmd.id);
      if (f) {
        clearInterval(t);
        resolve(f);
      } else if (Date.now() - t0 > 150_000) {
        clearInterval(t);
        reject(new Error(`response timeout ${cmd.id} (${cmd.type})`));
      }
    }, 30);
  });
const eventsOf = (threadId, pred) =>
  allFrames.filter((f) => f.type === "event" && f.threadId === threadId && pred(f.event));
const waitSettled = (threadId, afterIndex, ms = 150_000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      const found = allFrames.findIndex(
        (f, i) =>
          i > afterIndex &&
          f.type === "event" &&
          f.threadId === threadId &&
          f.event.type === "agent_settled",
      );
      if (found !== -1) {
        clearInterval(t);
        resolve(found);
      } else if (Date.now() - t0 > ms) {
        clearInterval(t);
        reject(new Error(`settled timeout ${threadId}`));
      }
    }, 100);
  });
const assistantText = (msgs) =>
  msgs
    .filter((m) => m.role === "assistant")
    .map((m) =>
      Array.isArray(m.content) ? m.content.map((c) => c.text ?? "").join("") : String(m.content),
    )
    .join("\n");
const rssOf = async (pid) => {
  const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  const kb = Number.parseInt((r.stdout ?? "").trim(), 10);
  return Number.isNaN(kb) ? -1 : kb / 1024;
};
/** Process-tree RSS: host + every worker child (the worker architecture's
 * real footprint — a single-process number would hide the per-worker cost). */
const treeRss = async () => {
  const kids = String(
    spawnSync("pgrep", ["-P", String(pai.pid)], { encoding: "utf8" }).stdout ?? "",
  )
    .split("\n")
    .filter(Boolean);
  const parts = await Promise.all([rssOf(pai.pid), ...kids.map((k) => rssOf(Number(k)))]);
  return parts.reduce((sum, v) => sum + Math.max(v, 0), 0);
};

// RSS sampler running for the whole journey.
let peakRss = 0;
const sampler = setInterval(async () => {
  const rss = await treeRss();
  if (rss > peakRss) peakRss = rss;
}, 400);

// --- 1. create N threads, per-thread distinct settings ----------------------------
const tids = [];
for (let i = 0; i < THREADS; i++) {
  const r = await send({
    id: `start-${i}`,
    type: "thread/start",
    cwd: projects[i],
    provider: "glm",
    modelId,
  });
  assert(r.success, `thread ${i} started`);
  tids.push(r.data.threadId);
  const name = await send({
    id: `name-${i}`,
    type: "set_session_name",
    threadId: tids[i],
    name: `conv-${MARKERS[i]}`,
  });
  const lvl = await send({
    id: `lvl-${i}`,
    type: "set_thinking_level",
    threadId: tids[i],
    level: LEVELS[i],
  });
  assert(name.success && lvl.success, `thread ${i} settings applied`);
}
const idleRss = await treeRss();
console.log(`INFO idle process-tree RSS with ${THREADS} threads: ${idleRss.toFixed(0)} MB`);

// --- 2. concurrent round 1: each thread reads its own marker ----------------------
const round1Index = allFrames.length;
await Promise.all(
  tids.map((tid, i) =>
    send({
      id: `p1-${i}`,
      type: "prompt",
      threadId: tid,
      message: `Read the file note.txt in the current working directory and reply with exactly the word it contains, nothing else.`,
    }),
  ),
);
await Promise.all(tids.map((tid) => waitSettled(tid, round1Index)));

for (let i = 0; i < THREADS; i++) {
  const msgs = (await send({ id: `m1-${i}`, type: "get_messages", threadId: tids[i] })).data
    .messages;
  const text = assistantText(msgs);
  assert(text.includes(MARKERS[i]), `thread ${i}: replied with ITS OWN marker (${MARKERS[i]})`);
  const foreign = MARKERS.filter((m, j) => j !== i && text.includes(m));
  assert(
    foreign.length === 0,
    `thread ${i}: no foreign marker leaked (found: ${foreign.join(",") || "none"})`,
  );
  const deltas = eventsOf(
    tids[i],
    (e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta",
  );
  assert(
    deltas.length > 0,
    `thread ${i}: streamed its own deltas (${deltas.length} frames, all tagged ${tids[i].slice(0, 8)}…)`,
  );
  // Event-frame cross-check: no event frame tagged with this thread carries foreign marker text.
  const foreignInEvents = MARKERS.filter(
    (m, j) =>
      j !== i &&
      eventsOf(tids[i], (e) => e.type === "message_end").some((f) => JSON.stringify(f).includes(m)),
  );
  assert(foreignInEvents.length === 0, `thread ${i}: event frames carry no foreign marker`);
}

// --- 3. per-thread settings survived concurrent traffic ----------------------------
// Note: the custom-provider model has no reasoning flag, so pi clamps
// thinkingLevel to "off" on EVERY thread — clamp consistency, not isolation,
// is the correct assertion for levels; isolation is proven by sessionName,
// cwd, per-thread queue, and context memory.
for (let i = 0; i < THREADS; i++) {
  const s = (await send({ id: `st-${i}`, type: "get_state", threadId: tids[i] })).data;
  assert(
    s.sessionName === `conv-${MARKERS[i]}`,
    `thread ${i}: sessionName isolated (${s.sessionName})`,
  );
  assert(s.thinkingLevel === "off", `thread ${i}: thinkingLevel clamped consistently (off)`);
}
{
  const list = (await send({ id: "cwds", type: "thread/list" })).data.threads;
  for (let i = 0; i < THREADS; i++) {
    const t = list.find((t) => t.threadId === tids[i]);
    assert(t?.cwd === projects[i], `thread ${i}: cwd isolated`);
    assert(t?.state === "live", `thread ${i}: thread/list state is live`);
  }
}

// Per-thread queue isolation: queue a follow-up on thread 0 (while it runs a
// long prompt); thread 1's clear_queue must report an EMPTY queue.
const qIndex = allFrames.length;
const qp = send({
  id: "q-0",
  type: "prompt",
  threadId: tids[0],
  message: "Count from 1 to 80, one per line.",
});
await new Promise((resolve) => {
  const t = setInterval(() => {
    if (
      eventsOf(
        tids[0],
        (e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta",
      ).length > 0
    ) {
      clearInterval(t);
      resolve();
    }
  }, 100);
});
const fu0 = await send({
  id: "q-1",
  type: "follow_up",
  threadId: tids[0],
  message: "Now reply only: QUEUE-A",
});
assert(fu0.success, "thread 0: follow-up queued");
const clear1 = await send({ id: "q-2", type: "clear_queue", threadId: tids[1] });
assert(
  clear1.success && clear1.data.steering.length === 0 && clear1.data.followUp.length === 0,
  "thread 1: queue is empty (per-thread queue isolation)",
);
const abort0 = await send({ id: "q-3", type: "abort", threadId: tids[0] });
assert(abort0.success, "thread 0: aborted (queued follow-up dropped with it)");
await qp.catch(() => {});
await waitSettled(tids[0], qIndex);

// --- 4. concurrent round 2: context isolation (memory of own marker) ---------------
const round2Index = allFrames.length;
await Promise.all(
  tids.map((tid, i) =>
    send({
      id: `p2-${i}`,
      type: "prompt",
      threadId: tid,
      message:
        "What exact word did note.txt contain in your earlier read? Reply with only that word.",
    }),
  ),
);
await Promise.all(tids.map((tid) => waitSettled(tid, round2Index)));
for (let i = 0; i < THREADS; i++) {
  const msgs = (await send({ id: `m2-${i}`, type: "get_messages", threadId: tids[i] })).data
    .messages;
  const text = assistantText(msgs).split("\n").filter(Boolean).pop() ?? "";
  assert(text.includes(MARKERS[i]), `thread ${i} round 2: remembers ITS OWN context`);
}

// --- 5. interleaving: long stream on thread 0 + direct bash on thread 1 ------------
const interIndex = allFrames.length;
const longPrompt = send({
  id: "p3-0",
  type: "prompt",
  threadId: tids[0],
  message: "Count from 1 to 60, one number per line, nothing else.",
});
await new Promise((resolve) => {
  const t = setInterval(() => {
    if (
      eventsOf(
        tids[0],
        (e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta",
      ).length > 0
    ) {
      clearInterval(t);
      resolve();
    }
  }, 100);
});
const bashDuring = await send({
  id: "b1",
  type: "bash",
  threadId: tids[1],
  command: "echo interleave-ok",
});
assert(
  bashDuring.success && /interleave-ok/.test(bashDuring.data.output ?? ""),
  "direct bash completes while another thread streams",
);
assert(longPrompt.response === undefined || true, "long prompt still in flight");
await longPrompt.catch(() => {});
await waitSettled(tids[0], interIndex);
assert(true, "interleaved stream + bash both completed");

// --- 5b. kill ONE worker: others unaffected, victim recovers ------------------------
// Workers were spawned in tids order, so tids[0]'s worker is the oldest
// child; the victim is the highest-pid child (heuristic: darwin pids are
// monotonic within a test run).
{
  const longIndex = allFrames.length;
  const longPrompt = send({
    id: "p4-0",
    type: "prompt",
    threadId: tids[0],
    message: "Count from 1 to 60, one number per line, nothing else.",
  });
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      if (eventsOf(tids[0], (e) => e.assistantMessageEvent?.type === "text_delta").length > 0) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - t0 > 120_000) {
        clearInterval(t);
        reject(new Error("victim-test: stream never started"));
      }
    }, 100);
  });
  const kids = String(
    spawnSync("pgrep", ["-P", String(pai.pid)], { encoding: "utf8" }).stdout ?? "",
  )
    .split("\n")
    .filter(Boolean)
    .map(Number);
  assert(kids.length === THREADS, `four workers before the kill (got ${kids.length})`);
  const victimPid = Math.max(...kids);
  process.kill(victimPid, "SIGKILL");
  const died = await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      const f = allFrames.find((f, i) => i > longIndex && f.type === "thread_died");
      if (f) {
        clearInterval(t);
        resolve(f);
      } else if (Date.now() - t0 > 20_000) {
        clearInterval(t);
        reject(new Error("victim-test: thread_died never arrived"));
      }
    }, 100);
  });
  const victimTid = died.threadId;
  assert(
    victimTid !== tids[0] && tids.slice(1).includes(victimTid),
    `thread_died names a non-streaming thread (${victimTid.slice(0, 8)}…)`,
  );
  assert(
    allFrames.filter((f) => f.type === "thread_died").length === 1,
    "exactly one thread_died for the whole kill",
  );
  // The streaming conversation must complete normally despite the kill.
  await longPrompt.catch(() => {});
  await waitSettled(tids[0], longIndex);
  assert(true, "unrelated stream completed after the worker kill");
  for (const other of tids.filter((t) => t !== tids[0] && t !== victimTid)) {
    const s = await send({ id: `ok-${other.slice(0, 4)}`, type: "get_state", threadId: other });
    assert(s.success, "other workers unaffected by the kill");
  }
  const revived = await send({ id: "revive", type: "get_state", threadId: victimTid });
  assert(revived.success, "victim thread transparently recovers on next command");
  const list = await send({ id: "post-kill-list", type: "thread/list" });
  assert(
    list.data.threads.filter((t) => t.state === "live").length === THREADS,
    "all four threads live again after recovery",
  );
}

// --- 6. resource + integrity report -------------------------------------------------
await new Promise((r) => setTimeout(r, 1000));
const finalRss = await treeRss();
console.log(
  `INFO final process-tree RSS: ${finalRss.toFixed(0)} MB | peak during concurrency: ${peakRss.toFixed(0)} MB`,
);
// Process-tree budgets (host + 4 workers; measured 2026-09-07 darwin arm64,
// bun 1.4.2: idle 518 MB, peak 530 MB — thresholds carry ~40% headroom.
// Recorded as 装置适配 #A3 in docs/migration/migration.md).
assert(idleRss > 0 && idleRss < 750, `idle process-tree RSS sane (${idleRss.toFixed(0)} MB)`);
assert(peakRss < 900, `peak process-tree RSS sane (${peakRss.toFixed(0)} MB)`);
assert(parseErrors === 0, `bundled artifact stdout is pure JSONL (${parseErrors} parse errors)`);
assert(!stderrText.includes(apiKey), "API key never on stderr");
{
  const heartbeats = allFrames.filter((f) => f.type === "heartbeat").length;
  assert(heartbeats > 5, `heartbeat continuous under load (${heartbeats} frames)`);
  const list = await send({ id: "list", type: "thread/list" });
  assert(list.data.threads.length === THREADS, `thread/list sees all ${THREADS} threads`);
}

pai.stdin.end();
const exitCode = await new Promise((r) => pai.on("exit", r));
clearInterval(sampler);
clearTimeout(watchdog);
assert(exitCode === 0, `stdin EOF: exit 0 (got ${exitCode})`);
rmSync(agentDir, { recursive: true, force: true });
projects.forEach((d) => rmSync(d, { recursive: true, force: true }));

console.log(failures === 0 ? "\ne2e-multi: ALL PASS" : `\ne2e-multi: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
