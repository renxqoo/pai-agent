import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "../src/backend/pi-coding-agent/agent-definitions.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pai-cli-agents-agent-"));
const projectDir = mkdtempSync(join(tmpdir(), "pai-cli-agents-proj-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function writeAgent(deps: { dir: string; file: string; frontmatter: string; body: string }): void {
  mkdirSync(deps.dir, { recursive: true });
  writeFileSync(join(deps.dir, deps.file), `---\n${deps.frontmatter}---\n${deps.body}`);
}

const USER_ECHOER = {
  dir: "",
  file: "echoer.md",
  frontmatter: "name: echoer\ndescription: echoes things\ntools: bash\nmodel: glm/test-model\n",
  body: "You echo.",
};

describe("discoverAgents (plan §3.1 scope + override semantics)", () => {
  test("empty directories discover nothing", () => {
    expect(discoverAgents({ cwd: projectDir, trusted: false })).toEqual([]);
  });

  test("user agents visible regardless of trust", () => {
    writeAgent({ ...USER_ECHOER, dir: join(agentDir, "agents") });
    const untrusted = discoverAgents({ cwd: projectDir, trusted: false });
    expect(untrusted.map((a) => a.name)).toEqual(["echoer"]);
    expect(untrusted[0]).toMatchObject({
      description: "echoes things",
      tools: ["bash"],
      model: "glm/test-model",
      systemPrompt: "You echo.",
      source: "user",
    });
  });

  test("project agents only for trusted threads (nearest .pi/agents wins upward)", () => {
    const nested = join(projectDir, "a", "b");
    writeAgent({
      dir: join(nested, ".pi", "agents"),
      file: "local.md",
      frontmatter: "name: helper\ndescription: project local\n",
      body: "Local prompt.",
    });
    expect(discoverAgents({ cwd: nested, trusted: false }).map((a) => a.name)).toEqual(["echoer"]);
    const trusted = discoverAgents({ cwd: nested, trusted: true });
    expect(trusted.map((a) => a.name).toSorted()).toEqual(["echoer", "helper"]);
  });

  test("same-name project entry overrides the user entry (both semantics)", () => {
    writeAgent({
      dir: join(projectDir, ".pi", "agents"),
      file: "echoer.md",
      frontmatter: "name: echoer\ndescription: project override\n",
      body: "Project prompt.",
    });
    const trusted = discoverAgents({ cwd: projectDir, trusted: true });
    const echoer = trusted.find((a) => a.name === "echoer");
    expect(echoer?.source).toBe("project");
    expect(echoer?.systemPrompt).toBe("Project prompt.");
    // Untrusted threads still see the user-level definition.
    const untrusted = discoverAgents({ cwd: projectDir, trusted: false });
    expect(untrusted.find((a) => a.name === "echoer")?.source).toBe("user");
  });

  test("malformed files are skipped, not fatal", () => {
    writeAgent({
      dir: join(agentDir, "agents"),
      file: "broken.md",
      frontmatter: "description: no name here\n",
      body: "body",
    });
    writeAgent({
      dir: join(agentDir, "agents"),
      file: "not-md.txt",
      frontmatter: "irrelevant",
      body: "body",
    });
    const agents = discoverAgents({ cwd: projectDir, trusted: false });
    expect(agents.some((a) => a.name === "broken")).toBe(false);
    expect(agents.some((a) => a.name === "echoer")).toBe(true);
  });

  test("syntactically invalid YAML is skipped, not fatal (review P1-4)", () => {
    writeAgent({
      dir: join(agentDir, "agents"),
      file: "bad-yaml.md",
      frontmatter: "name: badyaml\ndescription: broken\ntools: [read, bash\n",
      body: "p",
    });
    const agents = discoverAgents({ cwd: projectDir, trusted: false });
    expect(agents.some((a) => a.name === "badyaml")).toBe(false);
    expect(agents.some((a) => a.name === "echoer")).toBe(true);
  });

  test("tools accept array syntax; empty/invalid tools yield undefined", () => {
    writeAgent({
      dir: join(agentDir, "agents"),
      file: "array-tools.md",
      frontmatter: "name: arraytools\ndescription: x\ntools: [read, grep]\n",
      body: "p",
    });
    writeAgent({
      dir: join(agentDir, "agents"),
      file: "bad-tools.md",
      frontmatter: "name: badtools\ndescription: x\ntools: 42\n",
      body: "p",
    });
    const agents = discoverAgents({ cwd: projectDir, trusted: false });
    expect(agents.find((a) => a.name === "arraytools")?.tools).toEqual(["read", "grep"]);
    expect(agents.find((a) => a.name === "badtools")?.tools).toBeUndefined();
  });
});
