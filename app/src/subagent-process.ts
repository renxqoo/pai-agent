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

import { randomBytes } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionModel } from "./protocol.ts";
import type { PermissionRules } from "./rules.ts";
import { spawnWorkerProcess, type WorkerHandle } from "./worker-process.ts";

export const SUBAGENT_START_TIMEOUT_MS_DEFAULT = 30_000;
export const SUBAGENT_STALE_MS_DEFAULT = 30_000;
export const SUBAGENT_KILL_GRACE_MS = 5_000;
export const RESULT_CONTENT_CAP_BYTES = 50 * 1024;
export const RELAY_BUFFER_CAP_BYTES = 256 * 1024;
export const STDERR_CAP_BYTES = 32 * 1024;

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface GrandchildTaskSpec {
  subagentId: string;
  agent: string;
  task: string;
  cwd: string;
  systemPrompt: string;
  tools?: string[];
  model?: SessionModel;
  thinkingLevel?: string;
  permissionRules: PermissionRules;
}

export interface GrandchildHooks {
  /** One grandchild event (already relay-stripped by the caller). */
  onEvent: (event: AgentSessionEvent) => void;
  /** Grandchild ui_request relayed upward; answers arrive via resolveUi. */
  onUiRequest: (frame: Record<string, unknown>) => void;
  writeStderr: (text: string) => void;
}

export interface GrandchildUsage {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
}

export interface GrandchildResult {
  agent: string;
  task: string;
  output: string;
  isError: boolean;
  errorMessage?: string;
  aborted: boolean;
  usage: GrandchildUsage;
  stderr: string;
  /** Relay/detail buffer hit a cap; dropped data is counted, not stored. */
  truncated: boolean;
  eventsRelayed: number;
}

export interface GrandchildDriver {
  result: Promise<GrandchildResult>;
  /** Route a ui_response back into the grandchild (reconstructed line: the
   * host's internal id never crosses this boundary). False = unknown/late. */
  resolveUi: (requestId: string, payload: Record<string, unknown>) => boolean;
}

interface AssistantMessage {
  role?: string;
  content?: Array<{ type: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost?: { total: number };
    totalTokens: number;
  };
}

interface DriverState {
  threadId: string;
  waiters: Map<string, (frame: Record<string, unknown>) => void>;
  pendingUiRequests: Set<string>;
  /** Aggregated over every assistant turn; text/stopReason from the last. */
  usage: GrandchildUsage;
  lastText: string;
  lastStopReason: string | undefined;
  lastErrorMessage: string | undefined;
  relayBytes: number;
  truncated: boolean;
  stderrBytes: number;
  stderr: string;
  eventsRelayed: number;
  fatal: string | undefined;
  settled: boolean;
  /** close arrived (possibly before the settle wait was armed). */
  closedEarly: boolean;
  settleResolve: (() => void) | undefined;
}

export function newSubagentId(): string {
  return `sub_${randomBytes(4).toString("hex")}`;
}

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
      pendingUiRequests: new Set(),
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
    const result = this.run().finally(() => this.teardown());
    return { result, resolveUi: (requestId, payload) => this.resolveUi(requestId, payload) };
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
    // finish() flushes stdin must not flip a settled run into "aborted".
    const completed = this.state.settled && this.state.fatal === undefined;
    const abortedAtSettle = this.aborted;
    await this.finish();
    if (abortedAtSettle && !completed) return this.outcome("subagent aborted");
    if (this.state.fatal !== undefined) return this.outcome(this.state.fatal);
    if (!this.state.settled) return this.outcome("grandchild exited before finishing the task");
    if (this.state.lastStopReason === "error" || this.state.lastErrorMessage !== undefined) {
      return this.outcome(this.state.lastErrorMessage ?? "subagent turn failed");
    }
    return this.outcome();
  }

  private startLine(): string {
    const { spec } = this;
    return JSON.stringify({
      id: "g-start",
      type: "thread/start",
      cwd: spec.cwd,
      trusted: false,
      ephemeral: true,
      subagent: true,
      systemPrompt: spec.systemPrompt,
      ...(spec.tools !== undefined ? { tools: spec.tools } : {}),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      ...(spec.thinkingLevel !== undefined ? { thinkingLevel: spec.thinkingLevel } : {}),
      permissionRules: spec.permissionRules,
    });
  }

  private spawnGrandchild(): WorkerHandle {
    return this.spawnWorker({
      trusted: false,
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

  private resolveUi(requestId: string, payload: Record<string, unknown>): boolean {
    const { child } = this;
    if (child === undefined || !this.state.pendingUiRequests.has(requestId)) return false;
    this.state.pendingUiRequests.delete(requestId);
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
      const { requestId } = frame;
      if (typeof requestId === "string") this.state.pendingUiRequests.add(requestId);
      this.hooks.onUiRequest(frame);
    } catch {
      this.noteFatal("grandchild sent a malformed ui_request");
    }
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
    this.relay(line, event as AgentSessionEvent);
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

  private relay(line: string, event: AgentSessionEvent): void {
    const size = Buffer.byteLength(line, "utf8");
    if (this.state.relayBytes + size <= RELAY_BUFFER_CAP_BYTES) {
      this.state.relayBytes += size;
      this.hooks.onEvent(event);
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

  private outcome(errorMessage?: string): GrandchildResult {
    const isError = this.aborted || errorMessage !== undefined;
    const raw =
      errorMessage !== undefined || this.aborted
        ? (errorMessage ?? "subagent aborted")
        : this.state.lastText;
    return {
      agent: this.spec.agent,
      task: this.spec.task,
      output: truncateOutput(raw),
      isError,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      aborted: this.aborted,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function matchResponseId(line: string): string | undefined {
  if (!line.startsWith('{"id":"')) return undefined;
  const end = line.indexOf('"', 7);
  return end === -1 ? undefined : line.slice(7, end);
}

function truncateOutput(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= RESULT_CONTENT_CAP_BYTES) return text;
  let truncated = text.slice(0, RESULT_CONTENT_CAP_BYTES);
  while (Buffer.byteLength(truncated, "utf8") > RESULT_CONTENT_CAP_BYTES) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[output truncated: ${bytes - Buffer.byteLength(truncated, "utf8")} bytes omitted]`;
}
