// Scenario: the v0.7 execution sandbox, enforced for real on macOS
// (sandbox-exec). Covers both enforcement layers — OS bash wrapping (agent
// tool + direct execution) and the write/edit/read in-process hard checks —
// plus the observable state. Network semantics measured on
// sandbox-runtime 0.0.75: allowlisted real domains transit the proxy,
// everything else is cut, and LOOPBACK is cut even when allowlisted (a
// runtime limitation, not a config option) — so the loopback legs are
// asserted as an ON/OFF host contrast against the mock server, and the
// real-domain legs run only when an offline control probe passes (hermetic
// CI stays green offline). Plan 2026-09-09-sandbox.md §7.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWorld, startHost, writeAgentFiles, writeRules } from "../kit/host-client.mjs";
import { startMockModel } from "../kit/mock-model.mjs";

export const name = "sandbox-enforcement";
export const timeoutMs = 180_000;

const OUTSIDE = mkdtempSync(join(tmpdir(), "sbx-e2e-out-"));

export async function run({ assert }) {
  const world = makeWorld(name);
  const mock = startMockModel({
    models: {
      "mock-main": [
        // (a) agent bash tool: write OUTSIDE the allowed roots must fail.
        { kind: "tool", name: "bash", args: { command: `echo pwned | tee ${OUTSIDE}/escape.txt` } },
        { kind: "text", text: "bash-outside-done" },
        // (b) write tool: outside the roots -> hard block with the reason.
        { kind: "tool", name: "write", args: { path: `${OUTSIDE}/escape2.txt`, content: "x" } },
        { kind: "text", text: "write-outside-done" },
        // (c) write tool: .env inside cwd -> denyWrite block.
        { kind: "tool", name: "write", args: { path: ".env", content: "SECRET=1" } },
        { kind: "text", text: "write-env-done" },
      ],
    },
  });
  // Explicit sandbox.json: documented defaults PLUS a denyRead fixture that
  // exists on every machine (hermetic — ~/.ssh does not, review P9). The
  // permission gate stays permissive for write/edit (sandbox is the subject:
  // its hard checks must be the ONLY thing blocking these calls — no dialogs).
  writeAgentFiles(world.agentDir, {
    mockUrl: mock.url,
    sandbox: {
      enabled: true,
      network: {
        allowedDomains: ["127.0.0.1", "localhost", "github.com", "*.github.com"],
        deniedDomains: [],
      },
      filesystem: {
        denyRead: ["~/.ssh", "~/.aws", OUTSIDE],
        allowWrite: [".", "/tmp"],
        denyWrite: [".env", ".env.*", "*.pem", "*.key"],
      },
    },
  });
  writeRules(world.agentDir, {
    bash: { allowPatterns: ["echo *", "ls *", "curl *", "cat *", "tee *"] },
    write: { allowPatterns: ["*"] },
    edit: { allowPatterns: ["*"] },
  });
  const host = startHost({ agentDir: world.agentDir });
  try {
    await host.waitFrame((f) => f.type === "heartbeat", { label: "first heartbeat", ms: 15_000 });
    host.send({
      id: "s1",
      type: "thread/start",
      provider: "mock",
      modelId: "mock-main",
      cwd: world.projectDir,
    });
    const start = await host.waitResponse("s1", { ms: 30_000 });
    assert(start.success, "thread/start succeeds (sandbox on)");
    const tid = start.data.threadId;

    host.send({ id: "q1", type: "get_sandbox_state", threadId: tid });
    const state = await host.waitResponse("q1", { ms: 20_000 });
    assert(state.success, "get_sandbox_state succeeds");
    if (process.platform === "darwin") {
      assert(state.data.enabled === true, "sandbox enabled by default");
      assert(state.data.bashSandboxed === true, "OS bash layer active on darwin");
      assert(state.data.platform === "darwin", "platform reported");
      assert(Array.isArray(state.data.network.allowedDomains), "network policy reported");
    } else {
      assert(typeof state.data.enabled === "boolean", "state shape on non-darwin");
    }

    // --- direct bash (user_bash operations path) --------------------------------
    const direct = async (id, command) => {
      host.send({ id, type: "bash", threadId: tid, command });
      return host.waitResponse(id, { ms: 60_000 });
    };
    // Legs branch on the OBSERVED runtime state, not the platform: an active
    // OS layer runs the denial legs; a degraded one (e.g. Linux without
    // bubblewrap) runs the documented fail-open legs — the degradation path
    // itself gets asserted either way (plan §9).
    const osActive = state.data.bashSandboxed === true;
    const writeOutside = await direct("b1", `echo pwned | tee ${OUTSIDE}/direct.txt`);
    if (osActive) {
      assert(
        writeOutside.success &&
          writeOutside.data.exitCode !== 0 &&
          /not permitted|denied|Operation/i.test(writeOutside.data.output ?? ""),
        "direct bash: write outside allowed roots is OS-denied",
      );
    } else {
      assert(
        writeOutside.success && writeOutside.data.exitCode === 0,
        "degraded: bash fail-open (outside write succeeds)",
      );
      assert(
        typeof state.data.degraded === "string" && state.data.degraded.length > 0,
        "degraded: reason reported via get_sandbox_state",
      );
    }
    const readDenied = await direct("b2", `ls ${OUTSIDE}`);
    if (osActive) {
      assert(
        readDenied.success && /not permitted|denied/i.test(readDenied.data.output ?? ""),
        "direct bash: denyRead directory is OS-denied",
      );
    }
    if (osActive) {
      // Loopback is cut by the runtime's proxy even when allowlisted: the
      // enforcement signal is the ON/OFF contrast — ON cannot reach the local
      // mock server, the OFF control host below can.
      const netLoopback = await direct(
        "b3",
        `curl -s --max-time 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:${mock.port}/nope`,
      );
      assert(
        netLoopback.success && !/404/.test(netLoopback.data.output ?? ""),
        "direct bash (sandbox ON): loopback transit cut despite allowlist entries",
      );
      // Real-domain legs: only when the machine is online (control probe first).
      const offlineProbe = await direct(
        "b3c",
        "curl -s -o /dev/null -w '%{http_code}' --max-time 6 https://example.com",
      );
      if (/200/.test(offlineProbe.data.output ?? "")) {
        const allowlisted = await direct(
          "b3a",
          `curl -s -o /dev/null -w "%{http_code}" --max-time 8 https://github.com`,
        );
        assert(
          /200|301|302/.test(allowlisted.data.output ?? ""),
          "direct bash: allowlisted github.com transits",
        );
        const deniedDomain = await direct(
          "b3b",
          `curl -s -o /dev/null -w "%{http_code}" --max-time 8 https://example.org`,
        );
        assert(
          !/200/.test(deniedDomain.data.output ?? ""),
          "direct bash: non-allowlisted domain is cut",
        );
      } else {
        console.log(
          "  NOTE offline: skipping the two real-domain network legs (control probe got no 200)",
        );
      }
    }

    // --- agent tool paths (mock-scripted rounds) -------------------------------
    const round = async (id, label) => {
      const window = host.frames.length;
      host.send({ id, type: "prompt", threadId: tid, message: label });
      const resp = await host.waitResponse(id, { ms: 20_000 });
      await host.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
        label: `${label} settled`,
        ms: 90_000,
        since: window,
      });
      return { window, resp };
    };
    const toolResultText = (window) => {
      const ends = host.frames
        .slice(window)
        .filter((f) => f.type === "event" && f.event?.type === "tool_execution_end");
      return JSON.stringify(ends.map((f) => f.event));
    };

    const r1 = await round("p1", "try writing outside via bash");
    assert(r1.resp.success, "bash-outside round accepted");
    const bashText = toolResultText(r1.window);
    assert(
      /not permitted|denied|Operation/i.test(bashText),
      "agent bash: outside write denied in tool result",
    );

    const r2 = await round("p2", "try the write tool outside");
    const writeText = toolResultText(r2.window);
    assert(
      /Sandbox policy: write outside allowed paths/.test(writeText),
      "write tool: outside path hard-blocked",
    );

    const r3 = await round("p3", "try writing .env");
    const envText = toolResultText(r3.window);
    assert(/Sandbox policy: denyWrite/.test(envText), "write tool: .env denyWrite-blocked");

    // The conversation itself stayed healthy throughout.
    host.send({ id: "ls1", type: "thread/list" });
    const list = await host.waitResponse("ls1", { ms: 20_000 });
    assert(
      list.data.threads.some((t) => t.threadId === tid && t.state === "live"),
      "thread still live after every enforcement leg",
    );

    const exitCode = await host.endGracefully();
    assert(exitCode === 0, `stdin EOF graceful exit 0 (got ${exitCode})`);
  } finally {
    host.killTree();
  }

  // --- OFF control host: separate world, sandbox explicitly disabled ---------
  const worldOff = makeWorld(`${name}-off`);
  writeAgentFiles(worldOff.agentDir, { mockUrl: mock.url, sandbox: { enabled: false } });
  writeRules(worldOff.agentDir, {
    bash: { allowPatterns: ["echo *", "curl *", "tee *"] },
  });
  const hostOff = startHost({ agentDir: worldOff.agentDir });
  try {
    await hostOff.waitFrame((f) => f.type === "heartbeat", {
      label: "control heartbeat",
      ms: 15_000,
    });
    hostOff.send({
      id: "s1",
      type: "thread/start",
      provider: "mock",
      modelId: "mock-main",
      cwd: world.projectDir,
    });
    const start = await hostOff.waitResponse("s1", { ms: 30_000 });
    assert(start.success, "control thread/start succeeds (sandbox off)");
    const offTid = start.success ? start.data.threadId : "";
    hostOff.send({
      id: "q1",
      type: "get_sandbox_state",
      threadId: offTid,
    });
    const state = await hostOff.waitResponse("q1", { ms: 20_000 });
    assert(
      state.success && state.data.enabled === false && state.data.bashSandboxed === false,
      "control host reports the sandbox disabled",
    );
    hostOff.send({
      id: "b1",
      type: "bash",
      threadId: offTid,
      command: `curl -s --max-time 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:${mock.port}/nope`,
    });
    const loopback = await hostOff.waitResponse("b1", { ms: 60_000 });
    assert(
      loopback.success && /404/.test(loopback.data.output ?? ""),
      "control host (sandbox off): loopback mock server reachable — the ON-host failure was enforcement",
    );
    hostOff.send({
      id: "b2",
      type: "bash",
      threadId: offTid,
      command: `echo control | tee ${OUTSIDE}/control.txt`,
    });
    const writeOutside = await hostOff.waitResponse("b2", { ms: 60_000 });
    assert(
      writeOutside.success && writeOutside.data.exitCode === 0,
      "control host (sandbox off): outside write succeeds — the ON-host failure was enforcement",
    );
    // write tool on the OFF host: mock-scripted round must SUCCEED (the
    // ON-host block was enforcement, not environment).
    {
      const window = hostOff.frames.length;
      hostOff.send({ id: "wp", type: "prompt", threadId: offTid, message: "write outside now" });
      const resp = await hostOff.waitResponse("wp", { ms: 20_000 });
      assert(resp.success, "control write round accepted");
      await hostOff.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
        label: "control write round settled",
        ms: 60_000,
        since: window,
      });
      const ends = hostOff.frames
        .slice(window)
        .filter((f) => f.type === "event" && f.event?.type === "tool_execution_end");
      assert(
        !JSON.stringify(ends).includes("Sandbox policy"),
        "control host (sandbox off): write tool outside succeeds — no sandbox block",
      );
    }
    const exitCode = await hostOff.endGracefully();
    assert(exitCode === 0, `control host graceful exit 0 (got ${exitCode})`);
  } finally {
    hostOff.killTree();
  }

  // --- trust gate (plan §7): project .pi/sandbox.json only reaches trusted threads
  const worldGate = makeWorld(`${name}-trust`);
  mkdirSync(join(worldGate.projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(worldGate.projectDir, ".pi", "sandbox.json"),
    JSON.stringify({ enabled: false }),
  );
  writeAgentFiles(worldGate.agentDir, { mockUrl: mock.url, sandbox: "on" });
  const hostGate = startHost({ agentDir: worldGate.agentDir });
  try {
    await hostGate.waitFrame((f) => f.type === "heartbeat", {
      label: "trust heartbeat",
      ms: 15_000,
    });
    for (const [id, trusted, expected] of [
      ["tg-u", false, true], // untrusted ignores the project override
      ["tg-t", true, false], // trusted merges it -> disabled
    ]) {
      hostGate.send({
        id,
        type: "thread/start",
        provider: "mock",
        modelId: "mock-main",
        cwd: worldGate.projectDir,
        ...(trusted ? { trusted: true } : {}),
      });
      const start = await hostGate.waitResponse(id, { ms: 30_000 });
      assert(start.success, `trust gate: thread ${id} starts`);
      hostGate.send({ id: `${id}q`, type: "get_sandbox_state", threadId: start.data.threadId });
      const state = await hostGate.waitResponse(`${id}q`, { ms: 20_000 });
      assert(
        state.success && state.data.enabled === expected,
        `trust gate: project {"enabled":false} applies only to trusted (${trusted})`,
      );
      if (trusted) {
        assert(state.data.source === "global+project", "trust gate: source reports the merge");
      }
    }
    const gateExit = await hostGate.endGracefully();
    assert(gateExit === 0, `trust gate host graceful exit 0 (got ${gateExit})`);
  } finally {
    hostGate.killTree();
    mock.stop();
    world.cleanup();
    worldOff.cleanup();
    worldGate.cleanup();
  }
}
