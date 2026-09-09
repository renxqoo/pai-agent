import { describe, expect, test } from "bun:test";
import {
  digestFailure,
  digestViolationLines,
  shouldOfferRerun,
} from "../src/backend/pi-coding-agent/sandbox-bash.ts";

/**
 * Pure decision tables for the v0.10 bash confirm-rerun (plan
 * 2026-09-10-sandbox-escalation.md §2/§probe-record): violation-line
 * classification (probe-validated grammar: file-write and network-outbound
 * denies = rerun candidates, file-read denies touching a denyRead root =
 * hard floor, sysctl and mach = noise) and the offer gate (non-zero exit +
 * candidate + no floor + someone to ask).
 * The OS-level exec flow itself is covered by the e2e-mock real-process
 * scenario (repo precedent: process-level paths stay out of bun unit tests).
 */

const WRITE_LINE = "bash(17186) deny(1) file-write-create /private/var/folders/x.txt";
const NET_LINE = "deny network-outbound example.org:443 (host is not on the allow list)";
const READ_LINE = "cat(17316) deny(1) file-read-data /Users/wrr/.ssh/config";
const NOISE_LINES = [
  "bash(17312) deny(1) sysctl-read kern.iossupportversion",
  "curl(17421) deny(1) mach-lookup com.apple.SystemConfiguration.configd",
];

describe("digestViolationLines", () => {
  test("file-write and network-outbound denies are rerun candidates", () => {
    const digest = digestViolationLines([WRITE_LINE, NET_LINE], []);
    expect(digest.rerunCandidate).toBe(true);
    expect(digest.denyReadHit).toBe(false);
  });

  test("noise lines (sysctl/mach) classify to nothing", () => {
    const digest = digestViolationLines(NOISE_LINES, []);
    expect(digest.rerunCandidate).toBe(false);
    expect(digest.denyReadHit).toBe(false);
  });

  test("file-read deny under a denyRead root hits the hard floor (folded substring)", () => {
    const digest = digestViolationLines(
      [READ_LINE, ...NOISE_LINES],
      ["/Users/WRR/.SSH".toLowerCase()], // folded matching must unify case
    );
    expect(digest.denyReadHit).toBe(true);
  });

  test("file-read deny outside denyRead roots is neither candidate nor floor", () => {
    const digest = digestViolationLines(
      ["cat(1) deny(1) file-read-data /etc/hosts"],
      ["/Users/x/.ssh"],
    );
    expect(digest.rerunCandidate).toBe(false);
    expect(digest.denyReadHit).toBe(false);
  });

  test("empty lines digest to nothing", () => {
    expect(digestViolationLines([], [])).toEqual({ rerunCandidate: false, denyReadHit: false });
  });
});

describe("shouldOfferRerun (table)", () => {
  const cases: Array<{
    name: string;
    exitCode: number | null;
    candidate: boolean;
    floor: boolean;
    canAsk: boolean;
    expected: boolean;
  }> = [
    {
      name: "non-zero exit + write deny + askable",
      exitCode: 1,
      candidate: true,
      floor: false,
      canAsk: true,
      expected: true,
    },
    {
      name: "zero exit (`|| true` swallowed it) — never offered",
      exitCode: 0,
      candidate: true,
      floor: false,
      canAsk: true,
      expected: false,
    },
    {
      name: "killed child (null exit, timeout/abort) — never offered",
      exitCode: null,
      candidate: true,
      floor: false,
      canAsk: true,
      expected: false,
    },
    {
      name: "noise-only denial (ordinary failure stays ordinary)",
      exitCode: 1,
      candidate: false,
      floor: false,
      canAsk: true,
      expected: false,
    },
    {
      name: "denyRead floor hit suppresses even with a write deny",
      exitCode: 1,
      candidate: true,
      floor: true,
      canAsk: true,
      expected: false,
    },
    {
      name: "no dialog channel (subagent / no UI / deny posture)",
      exitCode: 1,
      candidate: true,
      floor: false,
      canAsk: false,
      expected: false,
    },
  ];
  for (const { name, exitCode, candidate, floor, canAsk, expected } of cases) {
    test(name, () => {
      expect(
        shouldOfferRerun({
          exitCode,
          digest: { rerunCandidate: candidate, denyReadHit: floor },
          canAsk,
        }),
      ).toBe(expected);
    });
  }
});

describe("digestFailure (dual evidence: store lines + streamed text)", () => {
  const DUAL_WRITE_LINE = "bash(1) deny(1) file-write-create /private/var/folders/x.txt";
  const DUAL_READ_LINE = "cat(1) deny(1) file-read-data /Users/wrr/.ssh/config";

  test("EPERM signature in the failure text makes a candidate even with no lines (kernel log lag)", () => {
    const digest = digestFailure({
      lines: [],
      failureText: "tee: /var/folders/x.txt: Operation not permitted\n",
      denyReadRoots: [],
    });
    expect(digest.rerunCandidate).toBe(true);
    expect(digest.denyReadHit).toBe(false);
  });

  test("ordinary failure text is not a candidate", () => {
    const digest = digestFailure({
      lines: [],
      failureText: "grep: no such file or directory\n",
      denyReadRoots: [],
    });
    expect(digest.rerunCandidate).toBe(false);
  });

  test("failure text naming a denyRead root hits the floor in BOTH path forms", () => {
    // The gate supplies BOTH forms via denyReadRootVariants (effect space
    // realpath + lexical expansion) — mirror that input here.
    const roots = ["/private/var/folders/rd", "/var/folders/rd"];
    expect(
      digestFailure({
        lines: [],
        failureText: "cat: /var/folders/rd/secret: Operation not permitted\n",
        denyReadRoots: roots,
      }).denyReadHit,
    ).toBe(true);
    expect(
      digestFailure({
        lines: [],
        failureText: "cat: /private/var/folders/rd/secret: Operation not permitted\n",
        denyReadRoots: roots,
      }).denyReadHit,
    ).toBe(true);
  });

  test("line evidence still works alone (no signature in text)", () => {
    expect(
      digestFailure({ lines: [DUAL_WRITE_LINE], failureText: "", denyReadRoots: [] })
        .rerunCandidate,
    ).toBe(true);
    expect(
      digestFailure({
        lines: [DUAL_READ_LINE],
        failureText: "",
        denyReadRoots: ["/Users/wrr/.ssh"],
      }).denyReadHit,
    ).toBe(true);
  });

  test("floor wins over the signature (read of a credential root)", () => {
    const digest = digestFailure({
      lines: [],
      failureText: "cat: /Users/wrr/.ssh/id_rsa: Operation not permitted\n",
      denyReadRoots: ["/Users/wrr/.ssh"],
    });
    expect(digest.rerunCandidate).toBe(true);
    expect(digest.denyReadHit).toBe(true); // shouldOfferRerun stays false
  });
});
