#!/usr/bin/env node
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { main } from "./main.js";
import { execRunner } from "./schedule/install.js";

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  homedir: homedir(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  now: () => new Date(),
  platform: process.platform,
  uid: process.getuid?.() ?? 0,
  runner: execRunner,
  cliPath: fileURLToPath(import.meta.url),
  nodePath: process.execPath,
});
