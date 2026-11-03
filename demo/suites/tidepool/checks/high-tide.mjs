// Pass: packages/api/src/high-tide.js exists, isHighTide is right and re-exported, and the repo's lint passes.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fail, pass, repo } from "./_check.mjs";

if (!existsSync(join(repo, "packages", "api", "src", "high-tide.js")))
  fail("packages/api/src/high-tide.js was not created");
// The checker links the workspace itself, so the result doesn't depend on whether the agent installed.
const core = join(repo, "node_modules", "@tidepool", "core");
if (!existsSync(core)) {
  mkdirSync(join(repo, "node_modules", "@tidepool"), { recursive: true });
  symlinkSync(join(repo, "packages", "core"), core);
}
let api;
try {
  api = await import(pathToFileURL(join(repo, "packages", "api", "src", "index.js")).href);
} catch (error) {
  fail(`packages/api/src/index.js does not load: ${String(error.message).split("\n")[0]}`);
}
if (typeof api.isHighTide !== "function") fail("isHighTide is not exported from packages/api/src/index.js");
const cases = [
  [3, true],
  [2.6, true],
  [2.5, false],
  [1, false],
];
const wrong = cases.find(([level, want]) => api.isHighTide(level) !== want);
if (wrong) fail(`isHighTide(${wrong[0]}) should be ${wrong[1]}`);
const lint = spawnSync(process.execPath, [join(repo, "scripts", "lint.mjs")], { cwd: repo, encoding: "utf8" });
if (lint.status !== 0) fail(`lint fails: ${(lint.stderr.split("\n")[0] || lint.stdout.trim()).slice(0, 80)}`);
pass("isHighTide works and lint passes");
