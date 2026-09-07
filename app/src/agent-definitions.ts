/**
 * Agent definition discovery (plan ui-completeness §3.1, pi subagent
 * precedent): `.md` files with `{name, description, tools?, model?}`
 * frontmatter; the body is the system prompt. Directories are re-read on
 * every task call (hot discovery, zero restart).
 *
 * Scope: user level (`<agentDir>/agents`) is always visible; project level
 * (nearest `<cwd>/.pi/agents`, walking up) only for trusted threads — the
 * trust decision comes from the thread's spawn flag, NOT from pi's
 * settings-based project trust. Same-name project entries override user
 * entries (precedent agentScope "both" semantics).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

interface AgentFrontmatter {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
  [key: string]: unknown;
}

/** Both `tools: read, bash` and `tools: [read, bash]` are valid YAML. */
function parseToolList(value: unknown): string[] | undefined {
  let raw: unknown[] = [];
  if (Array.isArray(value)) raw = value;
  else if (typeof value === "string") raw = value.split(",");
  const tools = raw
    .map((tool) => (typeof tool === "string" ? tool.trim() : ""))
    .filter((tool) => tool.length > 0);
  return tools.length > 0 ? tools : undefined;
}

/** One bad file must not take down the whole directory (precedent behavior). */
function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = join(dir, entry.name);
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    let frontmatter: AgentFrontmatter;
    let body: string;
    try {
      ({ frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content));
    } catch {
      continue; // invalid YAML in one file must not take down the directory
    }
    if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
      continue;
    }
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parseToolList(frontmatter.tools),
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      systemPrompt: body,
      source,
      filePath,
    });
  }
  return agents;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = cwd;
  for (;;) {
    const candidate = join(current, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function discoverAgents(deps: { cwd: string; trusted: boolean }): AgentConfig[] {
  const userAgents = loadAgentsFromDir(join(getAgentDir(), "agents"), "user");
  if (!deps.trusted) return userAgents;
  const projectDir = findNearestProjectAgentsDir(deps.cwd);
  const projectAgents = projectDir === null ? [] : loadAgentsFromDir(projectDir, "project");
  const byName = new Map<string, AgentConfig>();
  for (const agent of userAgents) byName.set(agent.name, agent);
  for (const agent of projectAgents) byName.set(agent.name, agent); // project overrides
  return [...byName.values()];
}
