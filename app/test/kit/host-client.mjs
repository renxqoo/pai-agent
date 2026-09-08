// Host driver for hermetic e2e-mock scenarios: spawn the real pai-cli host
// over stdio, frame JSONL in and out, bounded waits, worker-pid discovery for
// kill journeys, and per-scenario failure forensics. All process plumbing
// lives here so scenario files stay declarative.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const APP_ROOT = resolve(import.meta.dir, "..", "..");

export const sleep = (ms) =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

/** Isolated world per scenario: agent dir (with sessions/) + project dir. */
export function makeWorld(prefix = "e2e-mock") {
  const agentDir = mkdtempSync(join(tmpdir(), `${prefix}-agent-`));
  const projectDir = mkdtempSync(join(tmpdir(), `${prefix}-proj-`));
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  return {
    agentDir,
    projectDir,
    cleanup() {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

/**
 * Standard agentDir wiring for the mock provider (key via env reference).
 * `sandbox`: undefined = explicit OFF (isolates scenarios whose subject is
 * not the sandbox); "on" = no file (documented defaults apply); an object =
 * that exact sandbox.json.
 */
export function writeAgentFiles(
  agentDir,
  { mockUrl, models = ["mock-main"], rules, settings = { enableInstallTelemetry: false }, sandbox },
) {
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          baseUrl: mockUrl,
          api: "openai-completions",
          apiKey: "$MOCK_KEY",
          models: models.map((id) => ({ id })),
        },
      },
    }),
  );
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
  if (rules !== undefined) {
    writeRules(agentDir, rules);
  }
  if (sandbox !== "on") {
    writeFileSync(join(agentDir, "sandbox.json"), JSON.stringify(sandbox ?? { enabled: false }));
  }
}

/** Hot-write the global permission rules file (the gate re-reads per call). */
export function writeRules(agentDir, rules) {
  writeFileSync(join(agentDir, "permission-rules.json"), JSON.stringify(rules));
}

// Per-scenario bucket for forensics: the runner opens one before each
// scenario and dumps it (frames tail + stderr) only when that scenario fails.
let bucket = { name: "orphan", hosts: [] };
const liveHosts = new Set();

export function beginScenarioBucket(name) {
  bucket = { name, hosts: [] };
}

export function dumpScenarioBucket(dir) {
  for (const [i, host] of bucket.hosts.entries()) {
    const payload = JSON.stringify(
      {
        scenario: bucket.name,
        hostIndex: i,
        exited: host.exited,
        exitCode: host.exitCode,
        stderrTail: host.stderrTail,
        framesTail: host.frames.slice(-200),
      },
      null,
      2,
    );
    writeFileSync(join(dir, `${bucket.name}-host${i}.json`), payload);
  }
}

/** Kill every host this process ever spawned (watchdog cleanup path). */
export function killAllHosts() {
  for (const host of Array.from(liveHosts)) {
    host.killTree();
  }
}

export function startHost({ agentDir, env = {}, entry = join(APP_ROOT, "src", "cli.ts") } = {}) {
  const proc = spawn("bun", [entry], {
    cwd: APP_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SKIP_VERSION_CHECK: "1",
      MOCK_KEY: "mock-key",
      ...env,
    },
  });

  const host = {
    proc,
    frames: [],
    exited: false,
    exitCode: undefined,
    stderrTail: "",
    send(cmd) {
      // The stdin error handler below swallows EPIPE after a host death, so
      // sending to a dead host is a silent no-op-by-OS, not a runner crash.
      if (!host.exited) {
        proc.stdin.write(`${JSON.stringify(cmd)}\n`);
      }
    },
    /** Bounded poll for the response of a command id (exactly-one contract). */
    async waitResponse(id, { label = `response ${id}`, ms = 30_000 } = {}) {
      return host.waitFrame((f) => f.type === "response" && f.id === id, { label, ms });
    },
    /** Bounded poll for a frame matching pred (scanned from `since` on). */
    async waitFrame(pred, { label = "frame", ms = 30_000, since = 0 } = {}) {
      const t0 = Date.now();
      for (;;) {
        const found = host.frames.slice(since).find(pred);
        if (found !== undefined) return found;
        if (Date.now() - t0 > ms) {
          throw new Error(`waitFrame timeout (${ms}ms): ${label}`);
        }
        await sleep(25);
      }
    },
    /** True when pred matches within ms (absence assertions use the inverse). */
    async sawFrame(pred, { label = "frame", ms = 3_000, since = 0 } = {}) {
      try {
        await host.waitFrame(pred, { label, ms, since });
        return true;
      } catch {
        return false;
      }
    },
    async waitExit(ms = 15_000) {
      const t0 = Date.now();
      while (!host.exited) {
        if (Date.now() - t0 > ms) throw new Error(`waitExit timeout (${ms}ms)`);
        await sleep(50);
      }
      return host.exitCode;
    },
    /** Client-initiated EOF: host runs its graceful shutdown, expect exit 0. */
    async endGracefully(ms = 15_000) {
      proc.stdin.end();
      return host.waitExit(ms);
    },
    /** Direct children of the host (workers). Grandchildren are not listed. */
    workerPids() {
      const res = spawnSync("pgrep", ["-P", String(proc.pid)], { encoding: "utf8" });
      if (res.error !== undefined) {
        throw new Error(`pgrep failed: ${res.error.message}`);
      }
      const out = res.stdout ?? "";
      return out
        .split("\n")
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
    },
    /**
     * Kill the host AND its workers without relying on the SUT's own
     * orphan self-exit: after SIGKILL the children reparent, so their pids
     * must be captured before the host dies.
     */
    killTree() {
      const workers = host.exited ? [] : host.workerPids();
      if (!host.exited) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      for (const pid of workers) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    },
    alive() {
      try {
        process.kill(proc.pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  };

  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      try {
        host.frames.push(JSON.parse(line));
      } catch {
        host.frames.push({ type: "unparseable", line });
      }
    }
  });
  let errBuf = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c) => {
    errBuf += c;
    if (errBuf.length > 8000) errBuf = errBuf.slice(-8000);
    // Live update: forensics dumps must carry stderr even when the dump
    // happens before the process 'exit' event is dispatched.
    host.stderrTail = errBuf;
  });
  // A dead host closes the pipe; an unhandled EPIPE here would take the whole
  // runner down (kill/crash scenarios send commands after host death).
  proc.stdin.on("error", () => {
    host.stderrTail = `${errBuf}\n[kit] host stdin closed (EPIPE swallowed)`;
  });
  proc.on("exit", (code) => {
    host.exited = true;
    host.exitCode = code;
    host.stderrTail = errBuf;
    liveHosts.delete(host);
  });

  liveHosts.add(host);
  bucket.hosts.push(host);
  return host;
}

/** e2e-style counting assert: a failure never aborts the rest of a scenario. */
export function makeAssert() {
  let failures = 0;
  const assert = (cond, label) => {
    console.log(`  ${cond ? "PASS" : "FAIL"} ${label}`);
    if (!cond) failures += 1;
    return cond;
  };
  return { assert, count: () => failures };
}
