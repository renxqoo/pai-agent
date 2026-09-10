import { describe, expect, test } from "bun:test";

import { registerParkedAdmission } from "../src/thread-register.ts";
import { ThreadTable } from "../src/thread-table.ts";
import type { WorkerHandle } from "../src/worker-process.ts";

/**
 * thread/register admission (v0.12): cold-start hosts have an empty table
 * (clients reconcile from list_saved without resuming), so read-only
 * browsing must admit a session file as a parked entry without a worker.
 * Occupancy first, idempotency on id and path, then the new entry.
 */

function fakeHandle(): WorkerHandle {
  return {
    threadId: "live-id",
    sessionPath: "/sessions/live.jsonl",
    retiring: false,
    retireIntent: "none",
  } as unknown as WorkerHandle;
}

function makeOps(workers: WorkerHandle[] = []) {
  const table = new ThreadTable();
  return { ops: { table, workers: () => workers }, table };
}

describe("registerParkedAdmission (thread/register)", () => {
  const SPEC = {
    sessionPath: "/sessions/20260910_aaa.jsonl",
    threadId: "aaa",
    cwd: "/w",
    trusted: false,
  };

  test("cold start: new parked entry, no worker, read shortcut becomes reachable", () => {
    const { ops, table } = makeOps();
    const outcome = registerParkedAdmission(ops, SPEC);
    expect(outcome).toEqual({
      ok: true,
      data: { threadId: "aaa", cwd: "/w", sessionPath: SPEC.sessionPath },
    });
    expect(table.entry("aaa")).toMatchObject({
      state: "parked",
      sessionPath: SPEC.sessionPath,
      trusted: false,
    });
    expect(table.liveCount()).toBe(0);
  });

  test("idempotent on thread id and on resolved session path (any existing entry wins)", () => {
    const { ops } = makeOps();
    const first = registerParkedAdmission(ops, SPEC);
    expect(first.ok).toBe(true);
    const again = registerParkedAdmission(ops, { ...SPEC, trusted: true });
    expect(again).toEqual(first);
    // same file under a different id: the existing parked entry is the truth
    const byPath = registerParkedAdmission(ops, { ...SPEC, threadId: "other" });
    expect(byPath).toEqual({
      ok: true,
      data: { threadId: "aaa", cwd: "/w", sessionPath: SPEC.sessionPath },
    });
  });

  test("a live writer on the same path is rejected with the resume-path wording", () => {
    const table = new ThreadTable();
    const holder = fakeHandle();
    table.registerLive(holder, {
      threadId: "live-id",
      cwd: "/w",
      sessionPath: SPEC.sessionPath,
    });
    const outcome = registerParkedAdmission({ table, workers: () => [holder] }, SPEC);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("Session already open (threadId: live-id)");
    }
  });

  test("spawning wake window: the rejection names the worker uid when threadId is still empty", () => {
    const table = new ThreadTable();
    const spawning = {
      ...fakeHandle(),
      threadId: "",
      uid: "w7",
      sessionPath: SPEC.sessionPath,
    } as unknown as WorkerHandle;
    const outcome = registerParkedAdmission({ table, workers: () => [spawning] }, SPEC);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("Session already open (worker w7)");
    }
  });

  test("symptom regression: idempotent hit on a null-path entry repairs the table (no hollow echo)", () => {
    const table = new ThreadTable();
    table.registerParked({
      threadId: "aaa",
      cwd: "/w",
      sessionPath: SPEC.sessionPath,
      trusted: false,
    });
    const entry = table.entry("aaa");
    if (entry === undefined) throw new Error("fixture");
    entry.sessionPath = null;
    const outcome = registerParkedAdmission({ table, workers: () => [] }, SPEC);
    expect(outcome).toEqual({
      ok: true,
      data: { threadId: "aaa", cwd: "/w", sessionPath: SPEC.sessionPath },
    });
    expect(table.entry("aaa")?.sessionPath).toBe(SPEC.sessionPath);
  });

  test("register then resume-path occupancy: the parked entry does not block a later wake", () => {
    const { ops, table } = makeOps();
    registerParkedAdmission(ops, SPEC);
    // resume admission deletes non-live entries by path before spawning
    table.deleteNonLiveByPath(SPEC.sessionPath);
    expect(table.entry("aaa")).toBeUndefined();
  });
});
