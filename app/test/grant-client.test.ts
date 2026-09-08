import { describe, expect, test } from "bun:test";
import { createGrantClient } from "../src/worker.ts";

/** v0.6 grant client semantics (worker side; review #4 ghost lease): the 5s
 * acquire timeout denies, and a LATE grant decision must release the lease
 * the host ledger still holds — a busy worker's heartbeats would otherwise
 * renew the ghost lease forever. */
describe("grant client", () => {
  test("acquire resolves granted with the token when the host allows", async () => {
    const client = createGrantClient(1_000);
    const sent: unknown[] = [];
    client.bind((frame) => sent.push(frame));
    const pending = client.request();
    const grant = sent[0] as { type: string; id: string };
    client.resolve(grant.id, true, 3);
    await expect(pending).resolves.toEqual({ token: grant.id, running: 3 });
    client.release(grant.id);
    expect((sent.at(-1) as { release?: boolean }).release).toBeTrue();
  });

  test("denial resolves without a token", async () => {
    const client = createGrantClient(1_000);
    const sent: unknown[] = [];
    client.bind((frame) => sent.push(frame));
    const pending = client.request();
    const grant = sent[0] as { id: string };
    client.resolve(grant.id, false, 16);
    await expect(pending).resolves.toEqual({ token: null, running: 16 });
  });

  test("timeout denies; a late grant releases the ghost lease exactly once", async () => {
    const client = createGrantClient(25);
    const sent: unknown[] = [];
    client.bind((frame) => sent.push(frame));
    const pending = client.request();
    const grant = sent[0] as { id: string };
    await expect(pending).resolves.toEqual({ token: null });
    expect(sent.length).toBe(1);
    // Late grant after the timeout: the lease is released, not renewed.
    client.resolve(grant.id, true);
    expect(sent.length).toBe(2);
    const release = sent[1] as { id: string; release: boolean };
    expect(release.id).toBe(grant.id);
    expect(release.release).toBeTrue();
    // A late denial releases nothing.
    client.resolve(grant.id, false);
    expect(sent.length).toBe(2);
  });
});
