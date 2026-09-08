// Compiled-binary smoke (dual-form process smoke, docs/migration/
// implementation.md §4): `bun build --compile` produces a self-contained
// binary; the host inside it must still bootstrap workers by re-executing
// itself (workerSpawnArgs compiled form). Journey: --version -> real thread
// (start/prompt/get_state/list) -> graceful EOF exit 0. Real LLM (GLM via
// .env; the key never appears in output).
// Opt-in gate (needs .env): npm run e2e:compile

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
  console.error("FAIL compile-smoke timed out");
  process.exit(1);
}, 300_000);

// --- build the compiled binary ------------------------------------------------------
const build = spawnSync(
  "bun",
  ["build", "src/cli.ts", "--compile", "--outfile", "dist/pai-smoke-bin"],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert(build.status === 0, `bun build --compile (${(build.stderr ?? "").slice(0, 80)})`);
const bin = join(process.cwd(), "dist", "pai-smoke-bin");

// --- --version on the bare binary ---------------------------------------------------
{
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  assert(r.status === 0 && /^\d+\.\d+\.\d+/.test((r.stdout ?? "").trim()), "compiled --version");
}

// --- environment --------------------------------------------------------------------
const env = {};
for (const line of (await Bun.file(".env").text()).split("\n")) {
  const i = line.indexOf("=");
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const apiKey = env.GLM_API_KEY;
const modelId = env.GLM_MODEL;
const baseUrl = env.GLM_BASE_URL.replace(/\/chat\/completions$/, "");

const agentDir = mkdtempSync(join(tmpdir(), "pai-compile-agent-"));
const projectDir = mkdtempSync(join(tmpdir(), "pai-compile-proj-"));
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

// --- host journey inside the compiled binary ----------------------------------------
const pai = spawn(bin, [], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    GLM_API_KEY: apiKey,
    PAI_IDLE_RETIRE_MS: "3600000",
  },
});
let stderrText = "";
pai.stderr.setEncoding("utf8");
pai.stderr.on("data", (c) => (stderrText += c));

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
    if (line) allFrames.push(JSON.parse(line));
  }
});
const send = (cmd) =>
  new Promise((resolve, reject) => {
    pai.stdin.write(`${JSON.stringify(cmd)}\n`);
    const t0 = Date.now();
    const t = setInterval(() => {
      const fr = allFrames.find((x) => x.type === "response" && x.id === cmd.id);
      if (fr) {
        clearInterval(t);
        resolve(fr);
      } else if (Date.now() - t0 > 120_000) {
        clearInterval(t);
        reject(new Error(`response timeout ${cmd.id}`));
      }
    }, 30);
  });

// The compiled binary spawns workers as `<bin> --internal-worker`; the child
// must come up and answer inside the compiled form.
const boot = await send({
  id: "c1",
  type: "thread/start",
  cwd: projectDir,
  provider: "glm",
  modelId,
});
assert(boot.success, `compiled host starts a worker (${(boot.error ?? "ok").slice(0, 80)})`);
const tid = boot.data.threadId;
{
  const kids = String(
    spawnSync("pgrep", ["-P", String(pai.pid)], { encoding: "utf8" }).stdout ?? "",
  )
    .split("\n")
    .filter(Boolean);
  assert(kids.length === 1, `exactly one worker child in compiled form (got ${kids.length})`);
}
{
  const r = await send({
    id: "c2",
    type: "prompt",
    threadId: tid,
    message: "Reply with exactly: ok",
  });
  assert(r.success, "compiled worker accepts a prompt");
  const ok = await new Promise((resolve, reject) => {
    const t0 = Date.now();
    let last = "";
    const t = setInterval(async () => {
      // Unique id per poll: a repeated id would keep matching the FIRST
      // (stale) response frame forever.
      const m = await send({
        id: `c3-${t0}-${Math.random()}`,
        type: "get_messages",
        threadId: tid,
      }).catch(() => {});
      const text = (m?.data?.messages ?? [])
        .filter((msg) => msg.role === "assistant")
        .map((msg) =>
          Array.isArray(msg.content) ? msg.content.map((c) => c.text ?? "").join("") : "",
        )
        .join("");
      last = text;
      if (text.includes("ok")) {
        clearInterval(t);
        resolve(true);
      } else if (Date.now() - t0 > 120_000) {
        clearInterval(t);
        const err = (m?.data?.messages ?? [])
          .filter((msg) => msg.role === "assistant")
          .map((msg) => String(msg.errorMessage ?? ""))
          .join("; ");
        reject(
          new Error(
            `assistant reply never arrived (last text: ${JSON.stringify(last)}, error: ${err})`,
          ),
        );
      }
    }, 400);
  });
  assert(ok, "compiled worker streams the real reply");
}
{
  const list = await send({ id: "c4", type: "thread/list" });
  assert(
    list.success && list.data.threads.some((t) => t.threadId === tid && t.state === "live"),
    "compiled host thread/list sees the live thread",
  );
}
assert(!allFrames.some((f) => JSON.stringify(f).includes(apiKey)), "API key never in frames");
assert(!stderrText.includes(apiKey), "API key never on stderr");

// --- registry section: compiled binary + backends.json + reference worker -----------
// A-13 disposition (capability-packs plan §5): the compile form's dynamic
// self-resolution must keep working alongside an explicit registry spawn.
{
  const refAgentDir = mkdtempSync(join(tmpdir(), "pai-compile-ref-"));
  writeFileSync(
    join(refAgentDir, "backends.json"),
    JSON.stringify({
      reference: {
        command: process.execPath,
        args: [join(process.cwd(), "test", "conformance", "reference-worker.mjs")],
      },
    }),
  );
  const ref = spawn(bin, [], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_CODING_AGENT_DIR: refAgentDir, PAI_BACKEND: "reference" },
  });
  const refFrames = [];
  let refBuf = "";
  ref.stdout.setEncoding("utf8");
  ref.stdout.on("data", (c) => {
    refBuf += c;
    let i = refBuf.indexOf("\n");
    while (i !== -1) {
      const line = refBuf.slice(0, i).trim();
      refBuf = refBuf.slice(i + 1);
      if (line.length > 0) {
        try {
          refFrames.push(JSON.parse(line));
        } catch {}
      }
      i = refBuf.indexOf("\n");
    }
  });
  const waitResp = async (id) => {
    for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
      const f = refFrames.find((x) => x.type === "response" && x.id === id);
      if (f !== undefined) return f;
      await new Promise((r) => {
        setTimeout(r, 25);
      });
    }
    throw new Error(`registry section: response ${id} timed out`);
  };
  try {
    ref.stdin.write(`${JSON.stringify({ id: "r1", type: "thread/start" })}\n`);
    const bootResp = await waitResp("r1");
    assert(bootResp.success === true, "compiled binary spawns the registered reference worker");
  } finally {
    ref.stdin.end();
    ref.kill("SIGKILL");
    rmSync(refAgentDir, { recursive: true, force: true });
  }
}

pai.stdin.end();
const exitCode = await new Promise((r) => {
  pai.on("exit", r);
});
clearTimeout(watchdog);
assert(exitCode === 0, `stdin EOF: exit 0 (got ${exitCode})`);
rmSync(agentDir, { recursive: true, force: true });
rmSync(projectDir, { recursive: true, force: true });

console.log(failures === 0 ? "\ncompile-smoke: ALL PASS" : `\ncompile-smoke: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
