import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_BITS,
  capabilityError,
  COMMAND_CAPABILITIES,
  CORE_COMMANDS,
} from "../src/backend/capabilities.ts";
import { THREAD_SCOPED_COMMANDS } from "../src/protocol.ts";

/** The full external command set (api.md §3: 38 commands). */
const ALL_COMMANDS = [
  ...THREAD_SCOPED_COMMANDS,
  "thread/start",
  "thread/resume",
  "thread/stop",
  "thread/list",
  "thread/list_saved",
  "get_models",
  "set_model",
  "auth/list",
  "auth/set_api_key",
  "auth/remove_key",
  "ui_response",
  "get_permission_rules",
  "set_permission_rules",
  "agents/list",
  "get_host_info",
] as const;

describe("capability tables", () => {
  test("every one of the 38 commands is classified exactly once", () => {
    const unique = new Set(ALL_COMMANDS);
    expect(unique.size).toBe(38);
    for (const command of unique) {
      const classified = CORE_COMMANDS.has(command) || command in COMMAND_CAPABILITIES;
      expect(classified).toBeTrue();
    }
    // No table row for an unknown command.
    for (const command of Object.keys(COMMAND_CAPABILITIES)) {
      expect(unique.has(command)).toBeTrue();
    }
    for (const command of CORE_COMMANDS) {
      expect(unique.has(command)).toBeTrue();
      expect(command in COMMAND_CAPABILITIES).toBeFalse();
    }
  });

  test("mapped bits all exist in the closed bit set", () => {
    const bits = new Set<string>(CAPABILITY_BITS);
    for (const required of Object.values(COMMAND_CAPABILITIES)) {
      for (const bit of required) expect(bits.has(bit)).toBeTrue();
    }
  });

  test("core commands never fail capability gating", () => {
    const empty = new Set(CAPABILITY_BITS.slice(0, 0));
    for (const command of CORE_COMMANDS) {
      expect(capabilityError(command, "probe", empty)).toBeUndefined();
    }
  });

  test("capability error names the missing bit and backend (v0.8 shape)", () => {
    const none = new Set(CAPABILITY_BITS.slice(0, 0));
    expect(capabilityError("fork", "pi-agent-core", none)).toBe(
      "Unsupported capability: session.fork on backend pi-agent-core",
    );
    // Present bit -> no error even for gated commands.
    const withFork = new Set<(typeof CAPABILITY_BITS)[number]>(["session.fork"]);
    expect(capabilityError("fork", "pi-agent-core", withFork)).toBeUndefined();
    // Multi-bit commands fail on the first missing bit.
    expect(capabilityError("set_thinking_level", "probe", none)).toBe(
      "Unsupported capability: thinkingLevels on backend probe",
    );
  });
});
