import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAI_EVENT_NAMES } from "../src/protocol.ts";
import { resumePathError } from "../src/backend/pi-coding-agent/index.ts";

describe("coding-agent resume fence (U7; moved into the bundle resources)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pai-resume-fence-"));
  const sessions = join(dir, "sessions");
  // The fence reads the effective agent dir per call (getAgentDir env).
  process.env.PI_CODING_AGENT_DIR = dir;
  mkdirSync(sessions, { recursive: true });

  test("relative and outside paths are rejected", () => {
    expect(resumePathError("relative/session.jsonl")).toContain("absolute path");
    expect(resumePathError("/etc/passwd")).toContain("inside the agent sessions directory");
  });

  test("a missing file inside the sessions dir is rejected", () => {
    expect(resumePathError(join(sessions, "missing.jsonl"))).toContain("Session file not found");
  });

  test("an existing file inside the sessions dir passes", () => {
    writeFileSync(join(sessions, "ok.jsonl"), "{}", { flag: "w" });
    expect(resumePathError(join(sessions, "ok.jsonl"))).toBeUndefined();
  });

  test("a symlink inside sessions pointing outside is rejected", () => {
    const outside = join(dir, "outside.jsonl");
    writeFileSync(outside, "{}", { flag: "w" });
    symlinkSync(outside, join(sessions, "sneaky.jsonl"));
    expect(resumePathError(join(sessions, "sneaky.jsonl"))).toContain(
      "inside the agent sessions directory",
    );
  });
});

describe("event vocabulary lock (v0.8 R2)", () => {
  test("PAI_EVENT_NAMES is the frozen 23-member pai-owned vocabulary", () => {
    expect([...PAI_EVENT_NAMES]).toEqual([
      "agent_start",
      "agent_end",
      "agent_settled",
      "turn_start",
      "turn_end",
      "message_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "queue_update",
      "compaction_start",
      "compaction_end",
      "entry_appended",
      "session_info_changed",
      "thinking_level_changed",
      "auto_retry_start",
      "auto_retry_end",
      "summarization_retry_scheduled",
      "summarization_retry_attempt_start",
      "summarization_retry_finished",
      "bash_execution_update",
    ]);
  });
});
