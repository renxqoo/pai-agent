/**
 * Single derivation of the models.json path (mirrors the upstream
 * config.ts getModelsPath convention), shared by the host bundles so the
 * ModelRuntime loader and the set_model_override writer (v0.9) can never
 * disagree on the file. getAgentDir respects PI_CODING_AGENT_DIR.
 */

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function modelsJsonPath(): string {
  return join(getAgentDir(), "models.json");
}
