#!/usr/bin/env node
// The whole dreaming loop against synthetic data, with a fake agent, in a temp directory:
//   run --dry-run -> run -> inbox -> review (scripted answers) -> applied -> run again.
// Usage: npm run demo                (builds first)
//        npm run demo -- --try       (file the same proposals, then review them yourself, full screen)
//        node demo/run-demo.mjs --keep   (keep the sandbox to poke around)
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFixtures } from "./fixtures.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));
const keep = process.argv.includes("--keep");
const tryIt = process.argv.includes("--try");
const color = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const heading = (text) => process.stdout.write(`\n${color ? `\u001b[1;36m${text}\u001b[0m` : text}\n`);

function fail(message) {
  process.stderr.write(`\ndemo failed: ${message}\n`);
  // The sandbox is left as it was, for a look at what went wrong.
  if (sandboxRoots[0] !== undefined) process.stderr.write(`The sandbox is kept for inspection: ${sandboxRoots[0]}\n`);
  process.exit(1);
}

/** Shorten the temp directory to $SANDBOX, and this checkout to ".", in everything the demo prints. */
const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
let sandboxRoots = [];
const shorten = (text) =>
  sandboxRoots.reduce((out, root) => out.replaceAll(root, "$SANDBOX"), text).replaceAll(`${REPO}/`, "./");

/** Run the built CLI as a user would, echoing its output. */
function dreaming(env, args, answers) {
  heading(`$ dreaming ${args.join(" ")}${answers ? `   # answers piped in: ${answers.join(" ")}` : ""}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: [answers ? "pipe" : "ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(shorten(chunk.toString())));
    child.stderr.on("data", (chunk) => process.stderr.write(shorten(chunk.toString())));
    if (answers) child.stdin.end(answers.map((a) => `${a}\n`).join(""));
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
}

/** Run the built CLI on this terminal, keys and all. */
function interactive(env, args) {
  heading(`$ dreaming ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
}

async function expectExit(promise, expected, what) {
  const code = await promise;
  if (code !== expected) fail(`${what} exited with ${code}, expected ${expected}`);
}

async function main() {
  // Checked before the sandbox exists, so refusing leaves nothing behind.
  if (tryIt && !(process.stdin.isTTY && process.stdout.isTTY)) {
    fail("--try opens the full-screen review, so it needs a terminal");
  }
  try {
    await readFile(CLI);
  } catch {
    fail("dist/cli.js is missing; run `npm run build` first (or use `npm run demo`)");
  }
  await chmod(FAKE_AGENT, 0o755);

  const root = await mkdtemp(join(tmpdir(), "dreaming-demo-"));
  sandboxRoots = [root, await realpath(root)];
  const home = join(root, "dreaming-home");
  const now = new Date();
  const { memoryDir, projectsDir } = await writeFixtures(root, now);
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ memoryDir, transcripts: { root: projectsDir }, agent: { bin: FAKE_AGENT } }, null, 2),
  );
  const env = { DREAMING_HOME: home };

  process.stdout.write(
    "dreaming demo: a synthetic memory directory, three synthetic sessions (one still active) and a fake agent.\n" +
      `$SANDBOX is ${root}${keep ? "" : " (removed at the end; pass --keep to keep it)"}\n`,
  );

  if (tryIt) {
    await expectExit(dreaming(env, ["run"]), 0, "run");
    process.stdout.write("\nYour turn: a approve, r reject, e edit, enter submit, ? every key, q quit.\n");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await interactive(env, ["review"]);
    const audit = await readFile(join(home, "applied.jsonl"), "utf8").catch(() => "");
    const first = audit
      .trim()
      .split("\n")
      .find((line) => line !== "");
    if (first === undefined)
      process.stdout.write("\nNothing was applied, so there is no history for dreaming why to show.\n");
    else await interactive(env, ["why", JSON.parse(first).file]);
    if (keep) process.stdout.write(`Sandbox kept at ${root}\n`);
    else await rm(root, { recursive: true, force: true });
    return;
  }

  await expectExit(dreaming(env, ["run", "--dry-run"]), 0, "run --dry-run");
  await expectExit(dreaming(env, ["run"]), 0, "run");

  // Approve the pnpm preference and the two outdated memories; reject the key;
  // try to approve the proposal with invented evidence (blocked), then reject it.
  await expectExit(dreaming(env, ["review"], ["a", "a", "a", "r", "a", "r", "y"]), 0, "review");

  heading("$ cat memory/MEMORY.md");
  process.stdout.write(await readFile(join(memoryDir, "MEMORY.md"), "utf8"));
  heading("$ ls memory/");
  process.stdout.write(`${(await readdir(memoryDir)).sort().join("  ")}\n`);
  heading("$ tail -n 3 applied.jsonl   # one audit line per applied proposal (trimmed)");
  const audit = (await readFile(join(home, "applied.jsonl"), "utf8")).trim().split("\n");
  for (const line of audit) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      fail(`applied.jsonl has a line that is not JSON: ${line.slice(0, 80)}`);
    }
    const hash = (value) => (value === null ? "null" : `"${value.slice(0, 12)}..."`);
    process.stdout.write(
      `{"action":"${entry.action}","file":"${entry.file}","result":"${entry.result}","beforeHash":${hash(entry.beforeHash)},"afterHash":${hash(entry.afterHash)},"evidence":[${entry.evidence.length}],...}\n`,
    );
  }

  await expectExit(dreaming(env, ["why", "prefer-pnpm"]), 0, "why");

  // A recorded eval, replayed: 30 real claude -p runs from the repository, no model called now.
  const recorded = join(REPO, "demo", "recorded", "evals");
  for (const name of (await readdir(recorded)).sort()) {
    const record = JSON.parse(await readFile(join(recorded, name), "utf8"));
    if (record.proposal.file !== "prefers-tabs.md") continue;
    await expectExit(dreaming(env, ["eval", "--replay", join(recorded, name)]), 0, "eval replay");
  }
  await expectExit(dreaming(env, ["run"]), 0, "second run");

  const files = (await readdir(memoryDir)).sort();
  const expected = [
    "MEMORY.md",
    "api-v2-deadline.md",
    "deploy-window.md",
    "prefer-pnpm.md",
    "release-checklist.md",
    "user-role.md",
  ];
  if (JSON.stringify(files) !== JSON.stringify(expected)) fail(`memory directory has ${files.join(", ")}`);
  if (!(await readFile(join(memoryDir, "deploy-window.md"), "utf8")).includes("Tuesdays and Thursdays")) {
    fail("deploy-window.md was not updated");
  }
  if (audit.length !== 3) fail(`expected 3 audit lines, found ${audit.length}`);

  heading("Demo complete: run -> inbox -> review -> applied, with a backup and an audit line for every change.");
  if (keep) process.stdout.write(`Sandbox kept at ${root}\n`);
  else await rm(root, { recursive: true, force: true });
}

await main();
