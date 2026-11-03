// Pass: installed with pnpm, never tried npm install, and the api tests pass now.
import { spawnSync } from "node:child_process";
import { calls, fail, pass, repo } from "./_check.mjs";

const INSTALL = new Set(["install", "i", "ci", "add", "install-test", "it"]);
const verb = (call) => call.args.find((a) => !a.startsWith("-"));
const log = calls();
const npmInstalls = log.filter((c) => c.tool === "npm" && INSTALL.has(verb(c)));
const pnpmInstalls = log.filter((c) => c.tool === "pnpm" && ["install", "i"].includes(verb(c)));
if (npmInstalls.length > 0)
  fail(`ran npm ${verb(npmInstalls[0])} (${npmInstalls.length}×), which breaks the workspace links`);
if (pnpmInstalls.length === 0) fail("never installed the dependencies with pnpm");
const tests = spawnSync(process.execPath, ["--test", "packages/api/test/**/*.test.js"], {
  cwd: repo,
  encoding: "utf8",
});
if (tests.status !== 0) fail("installed with pnpm, but the api tests fail");
pass("installed with pnpm; the api tests pass");
