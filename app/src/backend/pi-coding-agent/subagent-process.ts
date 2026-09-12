/**
 * Grandchild process driver (plan ui-completeness §3): one
 * `pai --internal-worker` process per task run. Speaks the internal worker
 * protocol — thread/start (with the subagent extension fields) → prompt →
 * agent_end → thread/stop + EOF. Relay rules: events wrap upward through
 * hooks, ui_request relays with the caller-owned requestId mapping, the
 * heartbeat is consumed locally. Termination discipline matches the host
 * pool: everything settles from `close`, kills are SIGTERM → grace →
 * unconditional SIGKILL, and two watchdogs bound the lifetime (a start
 * deadline, because a heartbeating-but-never-ready worker blinds a pure
 * "no frame" check; plus a stale no-frame window).
 */

import {
  type AssistantMessage,
  type DriverState,
  type GrandchildDriver,
  type GrandchildHooks,
  type GrandchildResult,
  type GrandchildTaskSpec,
  type LiveProgress,
  readIntEnv,
  RELAY_ALWAYS_MAX_BYTES,
  RELAY_BUFFER_CAP_BYTES,
  relayAlwaysFormOf,
  RESULT_CONTENT_CAP_BYTES,
  STDERR_CAP_BYTES,
  SUBAGENT_KILL_GRACE_MS,
  SUBAGENT_START_TIMEOUT_MS_DEFAULT,
  SUBAGENT_STALE_MS_DEFAULT,
} from "../../subagent-contract.ts";
import { truncateBytes } from "../../truncate.ts";
import { pendingUiFrameList, retainUiFrame } from "./subagent-ui-frames.ts";
import { matchResponseId, sleep } from "../../subagent-wire.ts";
import { spawnWorkerProcess, type WorkerHandle } from "../../worker-process.ts";
import type { PaiEvent } from "../../protocol.ts";

// Re-export the contract surface (single import point for the registry,
// tool, and tests — the contract lives in subagent-contract.ts).
export * from "../../subagent-contract.ts";

class GrandchildRunner {
  private readonly spec: GrandchildTaskSpec;
  private readonly hooks: GrandchildHooks;
  private readonly signal: AbortSignal | undefined;
  private readonly startTimeoutMs: number;
  private readonly staleMs: number;
  private readonly spawnWorker: typeof spawnWorkerProcess;
  private readonly state: DriverState;
  private child: WorkerHandle | undefined;
  private aborted = false;
  /** A terminal event was relayed or synthesized (exactly one per task). */
  private terminalEmitted = false;
  /** At least one event reached the client (the fallback would not be a phantom row). */
  private clientVisible = false;
  private steerSeq = 0;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private staleSweep: ReturnType<typeof setInterval> | undefined;
  private readonly killTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(deps: {
    spec: GrandchildTaskSpec;
    hooks: GrandchildHooks;
    signal: AbortSignal | undefined;
    spawnWorker?: typeof spawnWorkerProcess;
  }) {
    this.spec = deps.spec;
    this.hooks = deps.hooks;
    this.signal = deps.signal;
    this.spawnWorker = deps.spawnWorker ?? spawnWorkerProcess;
    this.startTimeoutMs = readIntEnv("PAI_SUBAGENT_START_MS", SUBAGENT_START_TIMEOUT_MS_DEFAULT);
    this.staleMs = readIntEnv("PAI_SUBAGENT_STALE_MS", SUBAGENT_STALE_MS_DEFAULT);
    this.state = {
      threadId: "",
      waiters: new Map(),
      pendingUiFrames: new Map(),
      usage: {
        turns: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
      },
      lastText: "",
      lastStopReason: undefined,
      lastErrorMessage: undefined,
      relayBytes: 0,
      truncated: false,
      stderrBytes: 0,
      stderr: "",
      eventsRelayed: 0,
      fatal: undefined,
      settled: false,
      closedEarly: false,
      settleResolve: undefined,
    };
  }

  start(): GrandchildDriver {
    const result = this.run().finally(async () => {
      // Teardown first: the grandchild must be closed so its own terminal
      // event (if any) has been relayed before the fallback decides.
      await this.teardown();
      this.emitTerminalIfMissing();
    });
    return {
      result,
      resolveUi: (requestId, payload) => this.resolveUi(requestId, payload),
      steer: (message) => this.steer(message),
      progress: () => this.progress(),
      pendingUiFrames: () => pendingUiFrameList(this.state.pendingUiFrames, Date.now()),
    };
  }

  /** Fallback terminal event: a task whose events reached the client but that
   * died without relaying `agent_settled` (kill, crash, stale watchdog) would
   * otherwise leave the client's subagent status stuck at working. The parent
   * owns this fallback; tasks the client never saw stay silent (no phantom
   * row). The hook is best-effort: a throwing sink must not reject the result
   * or skip teardown (teardown already ran). */
  private emitTerminalIfMissing(): void {
    if (this.terminalEmitted || !this.clientVisible) return;
    this.terminalEmitted = true;
    try {
      this.hooks.onEvent({ type: "agent_settled" });
    } catch (error) {
      this.reportTerminalFailure(error);
    }
  }

  /** Best-effort diagnostic for a throwing terminal sink; stderr itself may
   * be gone (destroyed pipe), and a rejection here would strand the task's
   * settle accounting. */
  private reportTerminalFailure(error: unknown): void {
    try {
      this.hooks.writeStderr(`pai-cli subagent terminal event relay failed: ${String(error)}\n`);
    } catch {
      // stderr is gone too: nothing left to report to.
    }
  }

  /** Stage 7: fire one steer line into the grandchild and await its ack.
   * Exchange ids are unique per call — concurrent steers must not collide. */
  private async steer(message: string): Promise<boolean | string> {
    const { child } = this;
    if (child === undefined || this.state.settled || this.state.closedEarly) return false;
    if (this.state.fatal !== undefined) return false;
    if (this.state.threadId === "") return "grandchild not ready";
    const id = `g-steer-${this.steerSeq++}`;
    const frame = await this.exchange(
      JSON.stringify({ id, type: "steer", threadId: this.state.threadId, message }),
      id,
    );
    if (frame["__closed"] === true) return false;
    if (frame["success"] !== true) return String(frame["error"] ?? "grandchild rejected the steer");
    return true;
  }

  private async run(): Promise<GrandchildResult> {
    this.child = this.spawnGrandchild();
    this.armWatchdogs();
    this.attachAbort();
    const started = await this.exchange(this.startLine(), "g-start");
    if (started["__closed"] === true) {
      return this.outcome(this.state.fatal ?? "grandchild died while starting");
    }
    if (started["success"] !== true) {
      return this.outcome(String(started["error"] ?? "grandchild failed to start"));
    }
    const startData = started["data"] as Record<string, unknown> | undefined;
    this.state.threadId = String(startData?.["threadId"] ?? "");
    if (this.startTimer !== undefined) {
      clearTimeout(this.startTimer);
      this.startTimer = undefined;
    }
    return this.driveTask();
  }

  private async driveTask(): Promise<GrandchildResult> {
    const prompted = await this.exchange(
      JSON.stringify({
        id: "g-prompt",
        type: "prompt",
        threadId: this.state.threadId,
        message: this.spec.task,
      }),
      "g-prompt",
    );
    if (prompted["__closed"] === true) {
      return this.outcome(this.state.fatal ?? "grandchild died before accepting the task");
    }
    if (prompted["success"] !== true) {
      await this.finish();
      return this.outcome(String(prompted["error"] ?? "grandchild rejected the task"));
    }
    await new Promise<void>((resolve) => {
      this.state.settleResolve = resolve;
      // closedEarly: the grandchild died before this wait was armed.
      if (
        this.state.settled ||
        this.state.closedEarly ||
        this.state.fatal !== undefined ||
        this.signal?.aborted === true
      ) {
        resolve();
      }
    });
    // First-terminal-wins: snapshot at settle time — an abort landing while
    // finish() flushes stdin must not flip a settled run into "aborted"
    // (review P3-9: outcome must read the snapshot, not the live flag).
    const completed = this.state.settled && this.state.fatal === undefined;
    const abortedAtSettle = this.aborted;
    await this.finish();
    if (abortedAtSettle && !completed) return this.outcome("subagent aborted");
    if (this.state.fatal !== undefined) return this.outcome(this.state.fatal);
    if (!this.state.settled) return this.outcome("grandchild exited before finishing the task");
    if (this.state.lastStopReason === "error" || this.state.lastErrorMessage !== undefined) {
      return this.outcome(this.state.lastErrorMessage ?? "subagent turn failed");
    }
    // A genuinely completed run stays completed: an abort that landed in the
    // finish() window (or before the settle wake) must not discard its output.
    return this.outcome(undefined, completed ? false : abortedAtSettle);
  }

  private startLine(): string {
    const { spec } = this;
    // Communication tools (report/send, stage 8/9) are appended to a tools
    // allowlist: pi filters extension tools through the same list, so an
    // agent definition with `tools:` must not silence them (depth-1 contract).
    const tools =
      spec.tools === undefined ? undefined : [...new Set([...spec.tools, "report", "send"])];
    return JSON.stringify({
      id: "g-start",
      type: "thread/start",
      cwd: spec.cwd,
      trusted: false,
      ephemeral: true,
      subagent: true,
      subagentId: spec.subagentId,
      agentName: spec.agent,
      systemPrompt: spec.systemPrompt,
      ...(tools !== undefined ? { tools } : {}),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      ...(spec.thinkingLevel !== undefined ? { thinkingLevel: spec.thinkingLevel } : {}),
      permissionThreadId: spec.permissionThreadId,
      ...(spec.parentProtectedPaths !== undefined
        ? { parentProtectedPaths: spec.parentProtectedPaths }
        : {}),
      ...(spec.lineage !== undefined
        ? {
            sandboxPosture: spec.lineage.posture,
            sandboxGrants: {
              writeDirs: spec.lineage.writeDirs,
              writePatterns: spec.lineage.writePatterns,
              domains: spec.lineage.domains,
            },
          }
        : {}),
    });
  }

  private spawnGrandchild(): WorkerHandle {
    return this.spawnWorker({
      uid: `sub-${this.spec.subagentId}`,
      trusted: false,
      posture: undefined,
      spawnTimeoutMs: this.startTimeoutMs,
      onLine: (line) => this.onLine(line),
      onViolation: (reason) => this.noteFatal(`grandchild protocol violation (${reason})`),
      onClosed: () => this.onClosed(),
      writeStderr: (text) => this.appendStderr(`[pai:subagent:${this.spec.subagentId}] ${text}\n`),
    });
  }

  private armWatchdogs(): void {
    this.startTimer = setTimeout(
      () => this.noteFatal(`grandchild did not start within ${this.startTimeoutMs}ms`),
      this.startTimeoutMs,
    );
    this.staleSweep = setInterval(() => {
      const { child } = this;
      if (child !== undefined && Date.now() - child.lastHeartbeatAt > this.staleMs) {
        this.noteFatal(`grandchild stale (no frame for ${this.staleMs}ms)`);
      }
    }, 1000);
  }

  private attachAbort(): void {
    if (this.signal === undefined) return;
    if (this.signal.aborted) {
      this.aborted = true;
      return;
    }
    this.signal.addEventListener(
      "abort",
      () => {
        this.aborted = true;
        this.killNow();
      },
      { once: true },
    );
  }

  private noteFatal(reason: string): void {
    this.state.fatal ??= reason;
    this.state.settleResolve?.();
    this.killNow();
  }

  /** SIGTERM now, unconditional SIGKILL after the grace (killWorker semantics). */
  private killNow(): void {
    const { child } = this;
    if (child === undefined || child.child.exitCode !== null || child.child.signalCode !== null) {
      return;
    }
    child.child.kill("SIGTERM");
    this.killTimers.push(setTimeout(() => child.child.kill("SIGKILL"), SUBAGENT_KILL_GRACE_MS));
  }

  private onClosed(): void {
    for (const timer of [
      ...this.killTimers,
      ...(this.startTimer !== undefined ? [this.startTimer] : []),
    ]) {
      clearTimeout(timer);
    }
    if (this.staleSweep !== undefined) clearInterval(this.staleSweep);
    for (const resolve of this.state.waiters.values()) resolve({ __closed: true });
    this.state.waiters.clear();
    this.state.closedEarly = true;
    this.state.settleResolve?.();
  }

  private async teardown(): Promise<void> {
    if (this.startTimer !== undefined) clearTimeout(this.startTimer);
    if (this.staleSweep !== undefined) clearInterval(this.staleSweep);
    // Bounded teardown: give the graceful close a window, then force it —
    // close is the single settlement point and SIGKILL guarantees it lands.
    await Promise.race([this.child?.closed ?? Promise.resolve(), sleep(SUBAGENT_KILL_GRACE_MS)]);
    this.killNow();
    await this.child?.closed;
  }

  private exchange(line: string, id: string): Promise<Record<string, unknown>> {
    const { child } = this;
    if (child === undefined) return Promise.resolve({ __closed: true });
    return new Promise((resolve) => {
      this.state.waiters.set(id, (frame) => {
        this.state.waiters.delete(id);
        resolve(frame);
      });
      void child.writeLine(line).catch(() => {
        this.state.waiters.delete(id);
        resolve({ __closed: true });
      });
    });
  }

  private async finish(): Promise<void> {
    const { child } = this;
    if (child === undefined) return;
    if (this.state.threadId !== "") {
      await child
        .writeLine(
          JSON.stringify({ id: "g-stop", type: "thread/stop", threadId: this.state.threadId }),
        )
        .catch(() => {});
    }
    child.stdin.end();
  }

  private progress(): LiveProgress | undefined {
    if (this.state.settled || this.state.fatal !== undefined) return undefined;
    return {
      text: this.state.lastText,
      usage: { ...this.state.usage },
      eventsRelayed: this.state.eventsRelayed,
      truncated: this.state.truncated,
    };
  }

  private resolveUi(requestId: string, payload: Record<string, unknown>): boolean {
    const { child } = this;
    if (child === undefined || !this.state.pendingUiFrames.has(requestId)) return false;
    this.state.pendingUiFrames.delete(requestId);
    void child
      .writeLine(JSON.stringify({ type: "ui_response", requestId, payload }))
      .catch(() => {});
    return true;
  }

  private onLine(line: string): void {
    if (line.startsWith('{"type":"heartbeat"')) {
      // Consumed locally, but it is the liveness proof the stale sweep reads:
      // without this refresh a healthy grandchild is killed after staleMs.
      if (this.child !== undefined) this.child.lastHeartbeatAt = Date.now();
      return;
    }
    if (line.startsWith('{"type":"event"')) {
      this.onEventLine(line);
      return;
    }
    if (line.startsWith('{"type":"ui_request"')) {
      this.onUiRequestLine(line);
      return;
    }
    if (line.startsWith('{"type":"subagent_message"')) {
      this.onMessageLine(line);
      return;
    }
    if (line.startsWith('{"type":"hub_error"')) {
      this.noteFatal(`grandchild hub error: ${line.slice(0, 400)}`);
      return;
    }
    const id = matchResponseId(line);
    const waiter = id === undefined ? undefined : this.state.waiters.get(id);
    if (waiter !== undefined) waiter(JSON.parse(line) as Record<string, unknown>);
  }

  private onUiRequestLine(line: string): void {
    try {
      const frame = JSON.parse(line) as Record<string, unknown>;
      // Admission policy (requestId shape / live count / frame bytes) lives
      // in subagent-ui-frames beside its constants; every rejection is fatal.
      const admission = retainUiFrame(
        this.state.pendingUiFrames,
        { line, requestId: frame["requestId"] },
        Date.now(),
      );
      if (!admission.ok) {
        this.noteFatal(admission.reason);
        return;
      }
      this.state.pendingUiFrames.set(admission.requestId, { frame, at: Date.now() });
      this.hooks.onUiRequest(frame);
    } catch {
      this.noteFatal("grandchild sent a malformed ui_request");
    }
  }

  /** Identity fields are advisory: the parent re-stamps from its registry
   * (stage 8 trust boundary); only text/to cross this boundary. Malformed
   * frames are fatal regardless of whether the caller wired onMessage —
   * protocol violations are not the hook's business. */
  private onMessageLine(line: string): void {
    let parsed: { text?: unknown; to?: unknown };
    try {
      parsed = JSON.parse(line) as { text?: unknown; to?: unknown };
    } catch {
      this.noteFatal("grandchild sent a malformed subagent_message");
      return;
    }
    if (typeof parsed.text !== "string" || parsed.text.length === 0) {
      this.noteFatal("grandchild sent a subagent_message without text");
      return;
    }
    this.hooks.onMessage?.({
      text: parsed.text,
      ...(typeof parsed.to === "string" && parsed.to.length > 0 ? { to: parsed.to } : {}),
    });
  }

  private onEventLine(line: string): void {
    let event: unknown;
    try {
      ({ event } = JSON.parse(line) as { event?: unknown });
    } catch {
      this.noteFatal("grandchild sent a malformed event frame");
      return;
    }
    if (typeof event !== "object" || event === null) {
      this.noteFatal("grandchild sent an event frame without an event payload");
      return;
    }
    const typed = event as { type?: string; message?: AssistantMessage };
    this.state.eventsRelayed += 1;
    this.relay(line, event as PaiEvent);
    if (typed.type === "message_end" && typed.message?.role === "assistant") {
      this.summarize(typed.message);
    }
    if (typed.type === "agent_settled") {
      // agent_settled, not agent_end: agent_end fires per attempt (with
      // willRetry) before auto-retry — settling there would kill the retry.
      this.state.settled = true;
      this.state.settleResolve?.();
    }
  }

  private relay(line: string, event: PaiEvent): void {
    const size = Buffer.byteLength(line, "utf8");
    const always = relayAlwaysFormOf(event);
    if (always !== undefined) {
      // Exactly one terminal event per task: repeats are dropped.
      if (this.terminalEmitted) return;
      const normalized = size > RELAY_ALWAYS_MAX_BYTES;
      const wire = normalized ? always : event;
      this.state.relayBytes += normalized
        ? Buffer.byteLength(JSON.stringify(always), "utf8")
        : size;
      this.hooks.onEvent(wire);
      this.terminalEmitted = true;
      this.clientVisible = true;
      return;
    }
    if (this.state.relayBytes + size <= RELAY_BUFFER_CAP_BYTES) {
      this.state.relayBytes += size;
      this.hooks.onEvent(event);
      this.clientVisible = true;
    } else {
      this.state.truncated = true;
    }
  }

  private summarize(message: AssistantMessage): void {
    this.state.lastText = (message.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    this.state.lastStopReason = message.stopReason;
    this.state.lastErrorMessage = message.errorMessage;
    const { usage } = message;
    if (usage === undefined) return;
    this.state.usage.turns += 1;
    this.state.usage.input += usage.input;
    this.state.usage.output += usage.output;
    this.state.usage.cacheRead += usage.cacheRead;
    this.state.usage.cacheWrite += usage.cacheWrite;
    this.state.usage.cost += usage.cost?.total ?? 0;
    this.state.usage.contextTokens = usage.totalTokens;
  }

  private appendStderr(text: string): void {
    this.state.stderrBytes += Buffer.byteLength(text, "utf8");
    if (this.state.stderrBytes > STDERR_CAP_BYTES) {
      this.state.truncated = true;
      return;
    }
    this.state.stderr += text;
  }

  private outcome(errorMessage?: string, aborted = this.aborted): GrandchildResult {
    const isError = aborted || errorMessage !== undefined;
    const raw =
      errorMessage !== undefined || aborted
        ? (errorMessage ?? "subagent aborted")
        : this.state.lastText;
    return {
      agent: this.spec.agent,
      task: this.spec.task,
      output: truncateOutput(raw),
      isError,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      aborted,
      usage: { ...this.state.usage },
      stderr: this.state.stderr,
      truncated: this.state.truncated,
      eventsRelayed: this.state.eventsRelayed,
    };
  }
}

/**
 * Start one task in a fresh grandchild worker. The result promise always
 * resolves (never throws) — every failure mode lands in the result.
 */
export function startGrandchildTask(deps: {
  spec: GrandchildTaskSpec;
  hooks: GrandchildHooks;
  signal?: AbortSignal;
  spawnWorker?: typeof spawnWorkerProcess;
}): GrandchildDriver {
  return new GrandchildRunner({
    spec: deps.spec,
    hooks: deps.hooks,
    signal: deps.signal,
    ...(deps.spawnWorker !== undefined ? { spawnWorker: deps.spawnWorker } : {}),
  }).start();
}

function truncateOutput(text: string): string {
  return truncateBytes(text, RESULT_CONTENT_CAP_BYTES, "\n\n[output truncated]");
}
