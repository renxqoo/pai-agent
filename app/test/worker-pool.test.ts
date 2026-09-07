import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSplitter, MAX_LINE_BYTES, WORKER_LINE_BYTES } from "../src/jsonl.ts";
import { matchResponseHead, workerSpawnArgs } from "../src/worker-pool.ts";

/**
 * Locks the wire key order assumption (design.md migration §3): the worker
 * serializes response frames with `type`/`id` first, which is what the
 * host's strict head match relies on. If a frame produced the way worker.ts
 * builds them stops classifying, this test fails before e2e can misroute.
 */
describe("response head classification", () => {
  test("classifies a success response with an id", () => {
    const frame = JSON.stringify({
      id: "cmd-1",
      type: "response",
      command: "get_messages",
      success: true,
      data: { messages: [] },
    });
    expect(matchResponseHead(frame)).toEqual({ id: "cmd-1", command: "get_messages" });
  });

  test("classifies a failure response with an id", () => {
    const frame = JSON.stringify({
      id: "cmd-2",
      type: "response",
      command: "prompt",
      success: false,
      error: "nope",
    });
    expect(matchResponseHead(frame)).toEqual({ id: "cmd-2", command: "prompt" });
  });

  test("classifies a response without an id (undefined omitted by stringify)", () => {
    const frame = JSON.stringify({
      id: undefined,
      type: "response",
      command: "ui_response",
      success: true,
    });
    expect(matchResponseHead(frame)).toEqual({ id: undefined, command: "ui_response" });
  });

  test("returns null for a response whose id contains escapes (caller falls back to parse)", () => {
    const frame = JSON.stringify({
      id: 'we"ird\\id',
      type: "response",
      command: "prompt",
      success: true,
    });
    expect(matchResponseHead(frame)).toBeNull();
  });

  test("returns undefined for non-response frames", () => {
    expect(matchResponseHead('{"type":"event","threadId":"t"}')).toBeUndefined();
    expect(matchResponseHead('{"type":"heartbeat","idleMs":0}')).toBeUndefined();
    expect(matchResponseHead('{"type":"ui_request","requestId":"r"}')).toBeUndefined();
  });
});

describe("worker spawn args (three launch forms)", () => {
  test("script form: argv[1] exists on disk and differs from execPath", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-spawn-args-"));
    try {
      const script = join(dir, "cli.ts");
      writeFileSync(script, "");
      expect(workerSpawnArgs(script, "/usr/local/bin/bun")).toEqual({
        command: "/usr/local/bin/bun",
        args: [script, "--internal-worker"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("compiled form: argv[1] is a virtual path that does not exist", () => {
    expect(existsSync("/$bunfs/root/cli")).toBe(false);
    expect(workerSpawnArgs("/$bunfs/root/cli", "/tmp/pai-bin")).toEqual({
      command: "/tmp/pai-bin",
      args: ["--internal-worker"],
    });
  });

  test("compiled form without argv[1]", () => {
    expect(workerSpawnArgs(undefined, "/tmp/pai-bin")).toEqual({
      command: "/tmp/pai-bin",
      args: ["--internal-worker"],
    });
  });
});

describe("jsonl splitter maxLineBytes parameterization", () => {
  test("default limit stays 16MiB, worker channel uses 128MiB", () => {
    expect(MAX_LINE_BYTES).toBe(16 * 1024 * 1024);
    expect(WORKER_LINE_BYTES).toBe(128 * 1024 * 1024);
  });

  test("custom smaller limit drops oversized lines and reports the actual limit", () => {
    const lines: string[] = [];
    const overflows: number[] = [];
    const splitter = createJsonlSplitter(
      (line) => lines.push(line),
      (limit) => overflows.push(limit),
      8,
    );
    splitter.push("short\n");
    splitter.push("this-line-is-too-long\n");
    splitter.push("after\n");
    expect(lines).toEqual(["short", "after"]);
    expect(overflows).toEqual([8]);
  });
});
