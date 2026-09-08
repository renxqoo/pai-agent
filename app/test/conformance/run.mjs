// Conformance runner for the public worker contract v1 (docs/worker-contract.md):
// spawns the REAL host with PAI_BACKEND=reference + a backends.json registry
// entry pointing at the reference worker (external spawn path), then runs the
// contract scenarios including malformed-worker rejection. A backend author
// runs the same suite against their own worker to claim conformance.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const APP_ROOT = new URL("../..", import.meta.url).pathname;
const scenarios = [referenceJourney, rejectsMissingHello, rejectsBadVersion, rejectsBadBackend];

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const s of scenarios) console.log(s.name);
  process.exit(0);
}
const only = args
  .find((a) => a.startsWith("--only="))
  ?.slice("--only=".length)
  .split(",");
const selected = only !== undefined ? scenarios.filter((s) => only.includes(s.name)) : scenarios;

let failed = 0;
for (const scenario of selected) {
  const result = await scenario();
  if (result.passed) {
    console.log(`RESULT ${scenario.name}: PASS`);
  } else {
    failed += 1;
    console.log(`RESULT ${scenario.name}: FAIL — ${result.reason}`);
    if (result.detail !== undefined) console.log(result.detail);
  }
}
console.log(
  failed === 0
    ? `conformance: ${selected.length}/${selected.length} scenarios passed`
    : `conformance: ${failed}/${selected.length} scenarios FAILED`,
);
process.exit(failed === 0 ? 0 : 1);

// --- harness -----------------------------------------------------------------

function makeWorld(name, workerEnv = {}) {
  const dir = join(APP_ROOT, "test", ".runs", `conformance-${name}-${Date.now()}`);
  const agentDir = join(dir, "agent");
  const projectDir = join(dir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const workerScript = join(APP_ROOT, "test", "conformance", "reference-worker.mjs");
  writeFileSync(
    join(agentDir, "backends.json"),
    JSON.stringify({
      reference: { command: process.execPath, args: [workerScript], env: workerEnv },
    }),
  );
  return {
    agentDir,
    projectDir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function startHost({ agentDir, backend = "reference" }) {
  const proc = spawn(process.execPath, [join(APP_ROOT, "src", "cli.ts")], {
    cwd: APP_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PAI_BACKEND: backend },
  });
  const host = {
    proc,
    frames: [],
    exited: false,
    exitCode: undefined,
    stderrTail: "",
    send(cmd) {
      if (!host.exited) proc.stdin.write(`${JSON.stringify(cmd)}\n`);
    },
    async waitResponse(id, { ms = 15_000 } = {}) {
      return waitFor((f) => f.type === "response" && f.id === id, { label: `response ${id}`, ms });
    },
    async waitFrame(predicate, { label, ms = 15_000, since = 0 } = {}) {
      return waitFor(predicate, { label, ms, since });
    },
    async endGracefully() {
      proc.stdin.end();
      await exited();
      return host.exitCode;
    },
    killTree() {
      if (!host.exited) proc.kill("SIGKILL");
    },
  };
  function exited() {
    return new Promise((resolve) => {
      if (host.exited) {
        resolve();
        return;
      }
      proc.on("exit", () => resolve());
    });
  }
  async function waitFor(predicate, { label, ms, since = 0 }) {
    const deadline = Date.now() + ms;
    for (;;) {
      const frame = host.frames.slice(since).find(predicate);
      if (frame !== undefined) return frame;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => {
        setTimeout(r, 20);
      });
    }
  }
  let buffer = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        try {
          host.frames.push(JSON.parse(line));
        } catch {
          host.frames.push({ type: "unparseable", line });
        }
      }
      index = buffer.indexOf("\n");
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    host.stderrTail = `${host.stderrTail}${chunk}`.slice(-4000);
  });
  proc.on("exit", (code) => {
    host.exited = true;
    host.exitCode = code;
  });
  return host;
}

function makeAssert(collector) {
  return (condition, label) => {
    if (!condition) collector.push(label);
  };
}

// --- scenarios ----------------------------------------------------------------

async function referenceJourney() {
  const problems = [];
  const assert = makeAssert(problems);
  const world = makeWorld("reference-journey");
  const host = startHost({ agentDir: world.agentDir });
  try {
    await host.waitFrame((f) => f.type === "heartbeat", { label: "host heartbeat", ms: 15_000 });
    host.send({ id: "s1", type: "thread/start", cwd: world.projectDir });
    const start = await host.waitResponse("s1");
    assert(start.success === true, "thread/start success via external worker");
    const tid = start.data?.threadId;
    assert(typeof tid === "string" && tid.length > 0, "threadId returned");
    host.send({ id: "h1", type: "get_host_info" });
    const info = await host.waitResponse("h1");
    assert(info.data?.backend?.id === "reference", "get_host_info reports the external backend id");

    const since = host.frames.length;
    host.send({ id: "p1", type: "prompt", threadId: tid, message: "conformance marker" });
    const promptResp = await host.waitResponse("p1");
    assert(promptResp.success === true, "prompt accepted");
    await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
      label: "settled",
      ms: 20_000,
      since,
    });
    const events = host.frames
      .slice(since)
      .filter((f) => f.type === "event")
      .map((f) => f.event);
    assert(
      events.filter((e) => e.type === "agent_settled").length === 1,
      "agent_settled exactly once",
    );
    const updates = events.filter(
      (e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta",
    );
    assert(updates.length > 0, "text_delta updates flowed");
    assert(
      !updates.some(
        (e) => e.assistantMessageEvent.partial !== undefined || e.message !== undefined,
      ),
      "message_update frames carry no cumulative snapshot",
    );
    const stitched = updates.map((e) => e.assistantMessageEvent.delta).join("");
    assert(stitched.endsWith("conformance marker"), "delta stitching reproduces the reply");

    host.send({ id: "g1", type: "get_state", threadId: tid });
    const st = await host.waitResponse("g1");
    assert(st.success === true && st.data.isStreaming === false, "get_state (core command)");

    const gated = { id: "f1", type: "fork", threadId: tid, entryId: "none" };
    host.send(gated);
    const fork = await host.waitResponse("f1");
    assert(
      fork.success === false && String(fork.error).startsWith("Unsupported capability:"),
      `capability-gated command fails with the v0.8 shape (got ${String(fork.error)})`,
    );

    host.send({ id: "t1", type: "thread/stop", threadId: tid });
    const stop = await host.waitResponse("t1");
    assert(stop.success === true, "thread/stop success");
    const code = await host.endGracefully();
    assert(code === 0, `stdin EOF exit 0 (got ${code})`);
  } catch (error) {
    problems.push(`harness error: ${String(error)}`);
  } finally {
    host.killTree();
    world.cleanup();
  }
  return problems.length === 0
    ? { passed: true }
    : { passed: false, reason: problems.join("; "), detail: host.stderrTail };
}

/** Shared shape for the malformed-worker rejection scenarios. */
async function rejectionScenario(name, workerEnv, expectedErrorPart) {
  const problems = [];
  const assert = makeAssert(problems);
  const world = makeWorld(name, workerEnv);
  const host = startHost({ agentDir: world.agentDir });
  try {
    host.send({ id: "s1", type: "thread/start", cwd: world.projectDir });
    const resp = await host.waitResponse("s1", { ms: 20_000 });
    assert(resp.success === false, "thread/start fails when the worker is rejected");
    assert(
      String(resp.error).includes(expectedErrorPart),
      `failure names the violation (got ${String(resp.error)})`,
    );
    const died = host.frames.filter((f) => f.type === "thread_died");
    assert(died.length === 0, "no thread_died for a spawn-time rejection");
    const responses = host.frames.filter((f) => f.type === "response" && f.id === "s1");
    assert(responses.length === 1, "exactly one response for the rejected start");
  } catch (error) {
    problems.push(`harness error: ${String(error)}`);
  } finally {
    host.killTree();
    world.cleanup();
  }
  return problems.length === 0
    ? { passed: true }
    : { passed: false, reason: problems.join("; "), detail: host.stderrTail };
}

async function rejectsMissingHello() {
  return rejectionScenario("rejects-missing-hello", { REF_WORKER_MODE: "no-hello" }, "hello");
}

async function rejectsBadVersion() {
  return rejectionScenario(
    "rejects-bad-version",
    { REF_WORKER_MODE: "bad-version" },
    "protocol version mismatch",
  );
}

async function rejectsBadBackend() {
  return rejectionScenario(
    "rejects-bad-backend",
    { REF_WORKER_MODE: "bad-backend" },
    "backend mismatch",
  );
}
