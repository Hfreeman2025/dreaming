#!/usr/bin/env node
// Make the recorded evals in demo/recorded: a dream over the demo's synthetic
// sessions (fake agent), then three evals of its proposals, 30 real claude -p
// runs each, on the synthetic tidepool suite. This calls the model under your
// Claude Code login (about 90 runs, about 15 minutes, a few dollars at API
// prices), so it is never part of a test or CI run and needs --yes.
// Usage: npm run build && node scripts/record-evals.mjs --yes [--model sonnet]
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFixtures } from "../demo/fixtures.mjs";
import { runEval } from "../dist/eval/engine.js";
import { saveEval } from "../dist/eval/record.js";
import { summarise } from "../dist/eval/summary.js";
import { loadSuite } from "../dist/eval/suite.js";
import { loadRuns, pendingProposals } from "../dist/inbox/store.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const OUT = join(ROOT, "demo", "recorded");
const EVALS = [
  ["prefer-pnpm.md", 1],
  ["prefers-tabs.md", 2],
  ["deploy-window.md", 3],
];

if (!process.argv.includes("--yes")) {
  console.error("This makes about 90 real claude -p calls under your login. Run it again with --yes.");
  process.exit(2);
}
const flag = process.argv.indexOf("--model");
const model = flag > 0 ? process.argv[flag + 1] : "sonnet";

/** Paths from this machine out of a record: the sandbox as <tmp>, this checkout as <repo>, the agent by name, home as ~. */
const tidy = (text, root, agent) =>
  text
    .replaceAll(root, "<tmp>")
    .replaceAll(tmpdir(), "<tmp>")
    .replaceAll(ROOT, "<repo>")
    .replaceAll(JSON.stringify(agent), JSON.stringify(basename(agent)))
    .replaceAll(homedir(), "~");

const root = await mkdtemp(join(tmpdir(), "dreaming-recorded-"));
try {
  const home = join(root, "dreaming-home");
  await mkdir(home);
  const { memoryDir, projectsDir } = await writeFixtures(root, new Date());
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      memoryDir,
      transcripts: { root: projectsDir },
      agent: { bin: join(ROOT, "demo", "fake-agent.mjs") },
    }),
  );
  const dream = spawnSync(process.execPath, [join(ROOT, "dist", "cli.js"), "run"], {
    env: { ...process.env, DREAMING_HOME: home },
    encoding: "utf8",
  });
  if (dream.status !== 0) throw new Error(dream.stderr);
  const runs = await loadRuns(join(home, "inbox"));
  const pending = pendingProposals(runs);
  const suite = await loadSuite(join(ROOT, "demo", "suites", "tidepool"));
  const claude = spawnSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout.trim();
  const evalsDir = join(root, "evals");
  for (const [file, seed] of EVALS) {
    const proposal = pending.find((p) => p.proposal.file === file);
    console.log(`${new Date().toISOString()} eval ${file}`);
    const record = await runEval(
      {
        proposal,
        suite,
        memoryDir,
        runs: 30,
        tasks: undefined,
        model,
        parallel: 3,
        seed,
        bin: claude,
        home: homedir(),
        user: userInfo().username,
        keep: false,
      },
      {
        now: () => new Date(),
        onEvent: (e) => {
          if (e.kind === "finished")
            console.log(`  ${e.run.index + 1}/30 ${e.run.arm} ${e.run.task} ${e.run.outcome}: ${e.run.reason}`);
          if (e.kind === "stopping") console.log(`  stopping: ${e.because}`);
        },
      },
    );
    await saveEval(evalsDir, record);
    const s = summarise(
      record.runs,
      record.suite.tasks.map((t) => t.id),
      record.plan.seed,
    );
    console.log(`  ${record.ended}: ${JSON.stringify(s.verdict)}, $${s.costUsd.toFixed(2)}`);
    if (record.ended !== "completed") throw new Error(`the ${file} eval did not complete: ${record.endedBecause}`);
  }
  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, "evals"), { recursive: true });
  await writeFile(join(OUT, "inbox.json"), `${tidy(JSON.stringify(runs, null, 2), root, claude)}\n`);
  for (const name of await readdir(evalsDir)) {
    await writeFile(join(OUT, "evals", name), tidy(await readFile(join(evalsDir, name), "utf8"), root, claude));
  }
  console.log(`written to ${OUT}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
