#!/usr/bin/env bun
import { runHost } from "./host.ts";
import { WORKER_FLAG } from "./protocol.ts";
import { runWorker } from "./worker.ts";

if (process.argv.includes(WORKER_FLAG)) {
  runWorker();
} else {
  runHost(process.argv.slice(2));
}
