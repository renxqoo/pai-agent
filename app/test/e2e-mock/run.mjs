// Runner for hermetic mock-model e2e scenarios (docs/plans/2026-09-09-production-hardening.md §6).
// Discovers *.scenario.mjs next to this file, runs each in isolation with a
// per-scenario watchdog, dumps forensics (frames tail + stderr) to
// test/.runs/<ts>/ only for failed scenarios, and supports --only/--list so a
// failure costs one scenario's re-run, not the whole suite.
//
//   bun test/e2e-mock/run.mjs --list
//   bun test/e2e-mock/run.mjs --only=stream-basic,tool-permission

import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  APP_ROOT,
  beginScenarioBucket,
  dumpScenarioBucket,
  killAllHosts,
  makeAssert,
  sleep,
} from "../kit/host-client.mjs";

const args = process.argv.slice(2);

const scenarioDir = import.meta.dir;
const files = readdirSync(scenarioDir)
  .filter((f) => f.endsWith(".scenario.mjs"))
  .toSorted();

const modules = [];
for (const file of files) {
  const mod = await import(join(scenarioDir, file));
  modules.push(mod);
}

if (args.includes("--list")) {
  for (const mod of modules) {
    console.log(`${mod.name} (watchdog ${mod.timeoutMs ?? 120_000}ms)`);
  }
  process.exit(0);
}

const onlyArg = args.find((a) => a.startsWith("--only="));
const only = onlyArg !== undefined ? onlyArg.slice("--only=".length).split(",") : null;
const selected = modules.filter((mod) => only === null || only.includes(mod.name));
const unknown =
  only !== null ? only.filter((name) => !modules.some((mod) => mod.name === name)) : [];
if (unknown.length > 0) {
  console.error(`FAIL unknown scenario(s): ${unknown.join(", ")}; use --list`);
  process.exit(1);
}

const runDir = join(APP_ROOT, "test", ".runs", new Date().toISOString().replaceAll(":", "-"));
const results = [];

for (const mod of selected) {
  const timeoutMs = mod.timeoutMs ?? 120_000;
  const t0 = Date.now();
  const { assert, count } = makeAssert();
  console.log(`SCENARIO ${mod.name}`);
  beginScenarioBucket(mod.name);
  let watchdogFired = false;
  try {
    await Promise.race([
      mod.run({ assert }),
      sleep(timeoutMs).then(() => {
        watchdogFired = true;
        throw new Error(`scenario watchdog exceeded (${timeoutMs}ms)`);
      }),
    ]);
  } catch (error) {
    assert(false, `scenario crashed: ${error instanceof Error ? error.message : String(error)}`);
    watchdogFired = true;
  }
  const failures = count();
  // Guarantee no leaked hosts even when a scenario forgot its finally block.
  killAllHosts();
  if (failures > 0) {
    mkdirSync(runDir, { recursive: true });
    dumpScenarioBucket(runDir);
    console.log(`  artifacts: ${join(runDir)}`);
  }
  results.push({ name: mod.name, failures, ms: Date.now() - t0, watchdogFired });
  console.log(
    `RESULT ${mod.name}: ${failures === 0 ? "PASS" : "FAIL"} (${failures} failed, ${Date.now() - t0}ms)`,
  );
}

const totalFailures = results.reduce((sum, r) => sum + r.failures, 0);
console.log(
  `e2e-mock: ${results.filter((r) => r.failures === 0).length}/${results.length} scenarios passed, ${totalFailures} failed assertions`,
);
process.exit(totalFailures === 0 ? 0 : 1);
