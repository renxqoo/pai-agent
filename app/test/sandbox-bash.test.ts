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
 * denies = rerun candidates; ANY file-read deny = denyRead hard floor —
 * denyRead is the only read policy, so attribution-free flooring is the
 * glob/relative-echo-proof rule from the full review P1; sysctl and mach =
 * noise) and the offer gate (non-zero exit + positive write/network
 * evidence + no floor + someone to ask — the streamed-text EPERM signature
 * alone NEVER flips the candidate, review P1/P3).
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
    const digest = digestViolationLines([WRITE_LINE, NET_LINE], [], "/proj");
    expect(digest.rerunCandidate).toBe(true);
    expect(digest.denyReadHit).toBe(false);
  });

  test("noise lines (sysctl/mach) classify to nothing", () => {
    const digest = digestViolationLines(NOISE_LINES, [], "/proj");
    expect(digest.rerunCandidate).toBe(false);
    expect(digest.denyReadHit).toBe(false);
  });

  test("ANY file-read deny floors, attribution-free (review P1: globs and relative echoes defeat root matching)", () => {
    // denyRead is the ONLY read policy: a read deny IS a denyRead hit, no
    // matter whether the logged literal path matches the entry's shape.
    const digest = digestViolationLines(
      [READ_LINE, ...NOISE_LINES],
      ["~/.config/*.secret"],
      "/proj",
    );
    expect(digest.denyReadHit).toBe(true);
    expect(digest.rerunCandidate).toBe(false);
  });

  test("write deny whose target matches a denyRead ENTRY floors (glob-aware, review P1)", () => {
    // Realistic entry form: "~" expands to the actual home (a nonexistent
    // fake root would distort the entry's effect-space resolution).
    const home = process.env.HOME ?? "";
    const line = `tee(1) deny(1) file-write-create ${home}/.config/api.secret`;
    const digest = digestViolationLines([line], ["~/.config/*.secret"], "/proj");
    expect(digest.denyReadHit).toBe(true);
  });

  test("write deny outside every denyRead entry stays a plain candidate", () => {
    const digest = digestViolationLines([WRITE_LINE], ["~/.ssh"], "/proj");
    expect(digest.rerunCandidate).toBe(true);
    expect(digest.denyReadHit).toBe(false);
  });

  test("empty lines digest to nothing", () => {
    expect(digestViolationLines([], [], "/proj")).toEqual({
      rerunCandidate: false,
      denyReadHit: false,
    });
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

/** digestFailure with table defaults (module scope — captures nothing). */
const digestWithDefaults = (overrides: Partial<Parameters<typeof digestFailure>[0]>) =>
  digestFailure({
    lines: [],
    failureText: "",
    commandText: "",
    denyReadEntries: [],
    denyReadRoots: [],
    cwd: "/proj",
    ...overrides,
  });

describe("digestFailure (dual evidence: store lines + streamed text)", () => {
  const DUAL_WRITE_LINE = "bash(1) deny(1) file-write-create /private/var/folders/x.txt";
  const DUAL_READ_LINE = "cat(1) deny(1) file-read-data /Users/wrr/.ssh/config";

  test("EPERM signature alone is a candidate (kernel lines lag/drop; the floor triad compensates)", () => {
    const result = digestWithDefaults({
      failureText: "tee: /var/folders/x.txt: Operation not permitted\n",
    });
    expect(result.rerunCandidate).toBe(true);
    expect(result.denyReadHit).toBe(false);
  });

  test("ordinary failure text is not a candidate", () => {
    expect(
      digestWithDefaults({ failureText: "grep: no such file or directory\n" }).rerunCandidate,
    ).toBe(false);
  });

  test("failure text naming a denyRead root hits the floor in BOTH path forms", () => {
    // The gate supplies BOTH forms via denyReadRootVariants (effect space
    // realpath + lexical expansion) — mirror that input here.
    const roots = ["/private/var/folders/rd", "/var/folders/rd"];
    expect(
      digestWithDefaults({
        failureText: "cat: /var/folders/rd/secret: Operation not permitted\n",
        denyReadRoots: roots,
      }).denyReadHit,
    ).toBe(true);
    expect(
      digestWithDefaults({
        failureText: "cat: /private/var/folders/rd/secret: Operation not permitted\n",
        denyReadRoots: roots,
      }).denyReadHit,
    ).toBe(true);
  });

  test("line evidence still works alone (no signature in text)", () => {
    expect(digestWithDefaults({ lines: [DUAL_WRITE_LINE] }).rerunCandidate).toBe(true);
    expect(
      digestWithDefaults({ lines: [DUAL_READ_LINE], denyReadEntries: ["~/.ssh"] }).denyReadHit,
    ).toBe(true);
  });

  test("text floor wins even without any line (read of a credential root)", () => {
    const result = digestWithDefaults({
      failureText: "cat: /Users/wrr/.ssh/id_rsa: Operation not permitted\n",
      denyReadRoots: ["/Users/wrr/.ssh"],
    });
    expect(result.rerunCandidate).toBe(true); // the signature fired…
    expect(result.denyReadHit).toBe(true); // …but the floor suppresses the offer
  });

  test("COMMAND text naming a denyRead root floors relative-echo shapes (review P1 channel 4)", () => {
    const result = digestWithDefaults({
      failureText: "cat: id_rsa: Operation not permitted\n", // relative echo: no root in output
      commandText: "cd ~/.ssh && cat id_rsa",
      denyReadEntries: ["~/.ssh"], // the gate passes entries AND root variants
      denyReadRoots: [`${process.env.HOME}/.ssh`],
    });
    expect(result.rerunCandidate).toBe(true);
    expect(result.denyReadHit).toBe(true);
  });
});
