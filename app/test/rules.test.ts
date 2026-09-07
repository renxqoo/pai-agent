import { describe, expect, test } from "bun:test";
import {
  decide,
  globToRegExp,
  loadRules,
  matches,
  type PermissionRules,
  parseRules,
} from "../src/rules.ts";

describe("parseRules", () => {
  test("missing input returns ask default", () => {
    expect(parseRules(undefined)).toEqual({ mode: "ask" });
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

describe("globToRegExp / matches", () => {
  test("* spans any characters including slashes", () => {
    expect(matches(["/a/*/z"], "/a/b/c/z")).toBe(true);
  });
  test("literal match without wildcard", () => {
    expect(matches(["git status"], "git status")).toBe(true);
    expect(matches(["git status"], "git status ")).toBe(false);
    expect(matches(["git status"], "git  status")).toBe(false);
  });
  test("regex metacharacters are escaped", () => {
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
  test("escapeRegex escapes the glob star", () => {
    expect(globToRegExp("a*").source).toBe("^a.*$");
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
    require("node:fs").writeFileSync(path, '{"mode":"block-all"}');
    expect(loadRules(path)).toEqual({ mode: "block-all" });
    require("node:fs").unlinkSync(path);
  });
  test("corrupt file returns default", () => {
    const path = `/tmp/pai-cli-rules-bad-${Date.now()}.json`;
    require("node:fs").writeFileSync(path, "not json");
    expect(loadRules(path)).toEqual({ mode: "ask" });
    require("node:fs").unlinkSync(path);
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
