#!/usr/bin/env bun
import { runHost } from "./host.ts";
import { WORKER_FLAG } from "./protocol.ts";
import { runWorker } from "./worker.ts";

const isWorker = process.argv.includes(WORKER_FLAG);
// ps(1) identity: the executable is `bun` in script form, so name the roles.
process.title = isWorker ? "pai-worker" : "pai-host";

if (isWorker) {
  runWorker();
} else {
  runHost(process.argv.slice(2));
}
