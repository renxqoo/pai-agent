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
export const timeoutMs = 300_000;

const OUTSIDE = mkdtempSync(join(tmpdir(), "sbx-e2e-out-"));
// Outside allowWrite but NOT denyRead-listed: the write-tool confirm leg must
// be confirmable (a denyRead-listed target hits the hard floor — no dialog).
const OUTSIDE_WRITE = mkdtempSync(join(tmpdir(), "sbx-e2e-wr-"));

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
  // onViolation:"deny" pins this world to the v0.7 posture (default is "ask"
  // since v0.10 — the ask legs live in the dedicated world below).
  writeAgentFiles(world.agentDir, {
    mockUrl: mock.url,
    sandbox: {
      enabled: true,
      onViolation: "deny",
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
    assert(state.data.onViolation === "deny", "deny posture echoed (v0.7 world)");
    assert(
      Array.isArray(state.data.sessionExemptions?.writePaths) &&
        Array.isArray(state.data.sessionExemptions?.bashCommands),
      "sessionExemptions shape present",
    );
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

  // --- ASK world (v0.10 escalation): default onViolation="ask" -------------
  // Separate mock model so the scripted rounds do not disturb the shared
  // script above. Legs: direct-bash rerun (allow once / deny / session
  // exemption), denyRead hard floor (no dialog), agent write-tool confirm,
  // agent bash-tool rerun.
  const worldAsk = makeWorld(`${name}-ask`);
  const mockAsk = startMockModel({
    models: {
      "mock-ask": [
        {
          kind: "tool",
          name: "write",
          args: { path: `${OUTSIDE_WRITE}/confirm.txt`, content: "approved" },
        },
        { kind: "text", text: "write-confirm-done" },
        {
          kind: "tool",
          name: "bash",
          args: { command: `echo agent-rerun | tee ${OUTSIDE}/agent-rerun.txt` },
        },
        { kind: "text", text: "bash-rerun-done" },
      ],
    },
  });
  // denyRead carries a DEDICATED dir (OUTSIDE_READ): the rerun legs write
  // under OUTSIDE, and a denyRead-listed target would hit the never-confirm
  // floor (text-match, same semantics as the write-tool layer's P2 rule).
  const OUTSIDE_READ = mkdtempSync(join(tmpdir(), "sbx-e2e-rd-"));
  writeAgentFiles(worldAsk.agentDir, {
    mockUrl: mockAsk.url,
    models: ["mock-ask"],
    sandbox: {
      enabled: true,
      network: { allowedDomains: ["127.0.0.1", "localhost"], deniedDomains: [] },
      filesystem: {
        denyRead: ["~/.ssh", "~/.aws", OUTSIDE_READ],
        allowWrite: [".", "/tmp"],
        denyWrite: [".env", ".env.*", "*.pem", "*.key"],
      },
      // onViolation omitted → default "ask"
    },
  });
  writeRules(worldAsk.agentDir, {
    bash: { allowPatterns: ["echo *", "tee *", "cat *", "ls *"] },
    write: { allowPatterns: ["*"] },
    edit: { allowPatterns: ["*"] },
  });
  const hostAsk = startHost({ agentDir: worldAsk.agentDir });
  try {
    await hostAsk.waitFrame((f) => f.type === "heartbeat", { label: "ask heartbeat", ms: 15_000 });
    hostAsk.send({
      id: "as1",
      type: "thread/start",
      provider: "mock",
      modelId: "mock-ask",
      cwd: worldAsk.projectDir,
    });
    const askStart = await hostAsk.waitResponse("as1", { ms: 30_000 });
    assert(askStart.success, "ask world: thread/start succeeds");
    const askTid = askStart.data.threadId;
    hostAsk.send({ id: "aq1", type: "get_sandbox_state", threadId: askTid });
    const askState = await hostAsk.waitResponse("aq1", { ms: 20_000 });
    assert(askState.success && askState.data.onViolation === "ask", "ask posture is the default");
    assert(
      askState.data.sessionExemptions.writePaths.length === 0 &&
        askState.data.sessionExemptions.bashCommands.length === 0,
      "ask world: fresh session has no exemptions",
    );

    const directAsk = async (id, command) => {
      hostAsk.send({ id, type: "bash", threadId: askTid, command });
      return hostAsk.waitResponse(id, { ms: 60_000 });
    };
    // waitFrame scans the whole frame buffer by default: every answer MUST
    // carry a `since` cursor so it matches only its OWN dialog (fresh frames
    // past the cursor), and every ui_response needs a unique id.
    let dialogSeq = 0;
    const answerSelect = async (value, label, since) => {
      const dialog = await hostAsk.waitFrame(
        (f) => f.type === "ui_request" && f.method === "select",
        { label, ms: 20_000, since },
      );
      assert(dialog.threadId === askTid, `${label}: tagged with threadId`);
      assert(
        Array.isArray(dialog.options) && dialog.options[0] === "Allow once",
        `${label}: three-way options`,
      );
      dialogSeq += 1;
      hostAsk.send({
        id: `aur-${dialogSeq}`,
        type: "ui_response",
        requestId: dialog.requestId,
        payload: { value },
      });
      return dialog;
    };
    const askOsActive = askState.data.bashSandboxed === true;

    if (askOsActive) {
      // Allow once: rerun succeeds, marker visible, no exemption minted.
      // (Every leg uses a DISTINCT command text: the macOS unified log
      // coalesces repeated denial lines, and an exact-text repeat may see no
      // fresh violation record — no dialog, plain v0.7 failure. Fail-closed,
      // documented; the legs must not depend on it.)
      const onceCmd = `echo pwned | tee ${OUTSIDE}/ask-once.txt`;
      const onceCursor = hostAsk.frames.length;
      const oncePromise = directAsk("ab1", onceCmd);
      const onceDialog = await answerSelect("Allow once", "rerun dialog (allow once)", onceCursor);
      assert(/re-run without sandbox/.test(onceDialog.title), "dialog title explains the rerun");
      const onceResp = await oncePromise;
      assert(onceResp.success && onceResp.data.exitCode === 0, "allow once: rerun exits zero");
      assert(
        /rerunning without sandbox/.test(onceResp.data.output ?? ""),
        "allow once: rerun marker in output",
      );
      const { existsSync } = await import("node:fs");
      assert(
        existsSync(`${OUTSIDE}/ask-once.txt`),
        "allow once: the rerun actually wrote the file",
      );

      // Deny on a fresh command: stays failed with the declined marker
      // (allow-once granted nothing — no exemption was minted).
      const denyCmd = `echo denied | tee ${OUTSIDE}/ask-deny.txt`;
      const denyCursor = hostAsk.frames.length;
      const denyPromise = directAsk("ab2", denyCmd);
      await answerSelect("Deny", "rerun dialog (deny)", denyCursor);
      const denyResp = await denyPromise;
      assert(
        denyResp.success && denyResp.data.exitCode !== 0,
        "deny: rerun declined, command stays failed",
      );
      assert(/rerun declined/.test(denyResp.data.output ?? ""), "deny: declined marker in output");

      // Session grant: exempted command skips the dialog on repeat.
      const sessionCmd = `echo again | tee ${OUTSIDE}/ask-session.txt`;
      const sessionCursor = hostAsk.frames.length;
      const sessionPromise = directAsk("ab3", sessionCmd);
      await answerSelect("Allow for this session", "rerun dialog (session)", sessionCursor);
      const sessionResp = await sessionPromise;
      assert(sessionResp.success && sessionResp.data.exitCode === 0, "session: rerun exits zero");
      hostAsk.send({ id: "aq2", type: "get_sandbox_state", threadId: askTid });
      const exemptState = await hostAsk.waitResponse("aq2", { ms: 20_000 });
      assert(
        exemptState.data.sessionExemptions.bashCommands.includes(sessionCmd),
        "session exemption visible in get_sandbox_state",
      );
      const exemptWindow = hostAsk.frames.length;
      const exemptResp = await directAsk("ab4", sessionCmd);
      assert(
        exemptResp.success && exemptResp.data.exitCode === 0,
        "exempt repeat: reruns without asking",
      );
      assert(
        !hostAsk.frames
          .slice(exemptWindow)
          .some((f) => f.type === "ui_request" && f.method === "select"),
        "exempt repeat: no dialog offered",
      );

      // denyRead floor: a denied read never offers the rerun.
      const floorWindow = hostAsk.frames.length;
      const floorResp = await directAsk("ab5", `cat ${OUTSIDE_READ}/secret.txt`);
      assert(floorResp.success && floorResp.data.exitCode !== 0, "denyRead: command fails");
      assert(
        !hostAsk.frames
          .slice(floorWindow)
          .some((f) => f.type === "ui_request" && f.method === "select"),
        "denyRead: no rerun dialog (hard floor)",
      );
    } else {
      console.log(
        "  NOTE ask world: OS layer degraded — rerun legs skipped (fail-open asserted elsewhere)",
      );
    }

    // Agent write tool: confirmable violation escalates; Allow once passes.
    {
      const window = hostAsk.frames.length;
      hostAsk.send({ id: "ap1", type: "prompt", threadId: askTid, message: "write outside now" });
      assert(
        (await hostAsk.waitResponse("ap1", { ms: 20_000 })).success,
        "ask write round accepted",
      );
      const dialog = await hostAsk.waitFrame(
        (f) => f.type === "ui_request" && f.method === "select",
        { label: "write confirm dialog", ms: 20_000, since: window },
      );
      assert(
        /outside allowed paths/.test(dialog.title),
        "write dialog title carries the violation",
      );
      hostAsk.send({
        id: "aur2",
        type: "ui_response",
        requestId: dialog.requestId,
        payload: { value: "Allow once" },
      });
      await hostAsk.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
        label: "ask write round settled",
        ms: 60_000,
        since: window,
      });
      const ends = JSON.stringify(
        hostAsk.frames
          .slice(window)
          .filter((f) => f.type === "event" && f.event?.type === "tool_execution_end"),
      );
      assert(!/Sandbox policy/.test(ends), "write tool: confirmed write executed (no block)");
      const { existsSync } = await import("node:fs");
      assert(existsSync(`${OUTSIDE_WRITE}/confirm.txt`), "write tool: the confirmed file landed");
    }

    // Agent bash tool: OS denial mid-round offers the rerun; Allow once reruns.
    if (askOsActive) {
      const window = hostAsk.frames.length;
      hostAsk.send({ id: "ap2", type: "prompt", threadId: askTid, message: "bash outside now" });
      assert(
        (await hostAsk.waitResponse("ap2", { ms: 20_000 })).success,
        "ask bash round accepted",
      );
      const dialog = await hostAsk.waitFrame(
        (f) => f.type === "ui_request" && f.method === "select",
        { label: "agent bash rerun dialog", ms: 20_000, since: window },
      );
      assert(
        /re-run without sandbox/.test(dialog.title),
        "agent bash dialog title explains the rerun",
      );
      hostAsk.send({
        id: "aur3",
        type: "ui_response",
        requestId: dialog.requestId,
        payload: { value: "Allow once" },
      });
      await hostAsk.waitFrame((f) => f.type === "event" && f.event?.type === "agent_settled", {
        label: "ask bash round settled",
        ms: 60_000,
        since: window,
      });
      const ends = JSON.stringify(
        hostAsk.frames
          .slice(window)
          .filter((f) => f.type === "event" && f.event?.type === "tool_execution_end"),
      );
      assert(/rerunning without sandbox/.test(ends), "agent bash: rerun marker in tool result");
      const { existsSync } = await import("node:fs");
      assert(existsSync(`${OUTSIDE}/agent-rerun.txt`), "agent bash: the rerun wrote the file");
    }

    const askExit = await hostAsk.endGracefully();
    assert(askExit === 0, `ask host graceful exit 0 (got ${askExit})`);
  } finally {
    hostAsk.killTree();
    mockAsk.stop();
    worldAsk.cleanup();
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
