#!/usr/bin/env node
// Record the measuring screens from the real CLI in a pseudo-terminal, into shots/measure:
//   eval.svg    the opener: a replay of a recorded eval (real claude -p runs, 2 Nov 2026)
//   loop.svg    dream, check for contradictions, review with the measurements, why
//   stills/     every eval, check and models screen state, at two terminal sizes
// The evals shown are replays of demo/recorded/evals (real runs, labelled as replays on
// screen); the dream and the error states use fake agents, which say "fake-claude" on
// screen; the contradiction check runs the real local NLI model when it is installed.
// Usage: npm run record:measure (builds first). No model API is called. The check
// scenes need the NLI model, found where the CLI finds it: $DREAMING_MODELS, else
// ~/.dreaming/models.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { availableParallelism, homedir, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFixtures } from "../demo/fixtures.mjs";
import { castFromTape, recordSession } from "./lib/pty.mjs";
import { animatedSvg, playCast, screenSvg } from "./lib/render.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const CLI = join(ROOT, "dist", "cli.js");
const DREAM_AGENT = join(ROOT, "demo", "fake-agent.mjs");
const EVAL_AGENT = join(ROOT, "test", "fixtures", "fake-claude-eval.mjs");
const SUITE = join(ROOT, "demo", "suites", "tidepool");
const RECORDED = join(ROOT, "demo", "recorded");
const MODELS = process.env.DREAMING_MODELS ?? join(homedir(), ".dreaming", "models");
const OUT = join(ROOT, "shots", "measure");
const SIZES = { wide: { cols: 120, rows: 36 }, narrow: { cols: 58, rows: 32 } };
const temps = [];

/** The recorded evals, by the file their proposal targets. */
async function recordedEvals() {
  const out = {};
  for (const name of (await readdir(join(RECORDED, "evals"))).sort()) {
    const record = JSON.parse(await readFile(join(RECORDED, "evals", name), "utf8"));
    out[record.proposal.file] = record;
  }
  return out;
}

async function sandbox({ inbox = true, model = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "dreaming-record-"));
  temps.push(root);
  const home = join(root, "dreaming-home");
  await mkdir(join(home, "evals"), { recursive: true });
  const { memoryDir, projectsDir } = await writeFixtures(root, new Date());
  // One agent on PATH, honestly named: the dream fake for dreams, the eval fake for eval runs.
  await mkdir(join(root, "bin"));
  const agent = join(root, "bin", "fake-claude");
  await writeFile(
    agent,
    `#!/bin/sh\ncase " $* " in *" stream-json "*) exec '${process.execPath}' '${EVAL_AGENT}' "$@";; esac\nexec '${process.execPath}' '${DREAM_AGENT}' "$@"\n`,
  );
  await chmod(agent, 0o755);
  if (model && existsSync(MODELS)) await symlink(MODELS, join(root, "models"));
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      memoryDir,
      transcripts: { root: projectsDir },
      agent: { bin: agent },
      eval: { suite: SUITE },
      contradictions: { modelDirs: model ? [join(root, "models")] : [] },
    }),
  );
  if (inbox) {
    // The inbox the recorded evals measured, so their proposals match.
    const runs = JSON.parse(await readFile(join(RECORDED, "inbox.json"), "utf8"));
    await mkdir(join(home, "inbox"), { recursive: true });
    for (const run of runs) {
      await writeFile(join(home, "inbox", `${run.runId}.json`), JSON.stringify({ ...run, memoryDir }, null, 2));
    }
    for (const name of await readdir(join(RECORDED, "evals")))
      await cp(join(RECORDED, "evals", name), join(home, "evals", name));
  }
  const env = { ...process.env, HOME: root, DREAMING_HOME: home, PATH: `${join(root, "bin")}:${process.env.PATH}` };
  delete env.NO_COLOR;
  delete env.DREAMING_MODELS;
  return { root, home, memoryDir, projectsDir, env };
}

const session = (box, args, steps, size, env = {}) =>
  recordSession({
    argv: [process.execPath, CLI, ...args],
    env: { ...box.env, ...env },
    cwd: box.root,
    cols: size.cols,
    rows: size.rows,
    steps,
    timeoutMs: 120_000,
  });

async function stills(size, evals) {
  const casts = [];
  const take = async (box, args, steps, env) => casts.push((await session(box, args, steps, size, env)).events);
  const box = await sandbox();
  const tabs = evals["prefers-tabs.md"];
  const pnpm = evals["prefer-pnpm.md"];
  const deploy = evals["deploy-window.md"];

  await take(box, ["eval"], [{ wait: "Measure one" }, { mark: "eval-list" }]);
  await take(box, ["eval", "prefers-tabs", "--dry-run"], [{ wait: "no model was called" }, { mark: "eval-dry-run" }]);
  await take(
    box,
    ["eval", "prefers-tabs"],
    [{ wait: "Start? [y/N]" }, { mark: "eval-confirm" }, { type: "n\r" }, { wait: "Not started" }],
  );
  await take(
    box,
    ["eval", "--replay", tabs.evalId, "--speed", "40"],
    [{ wait: "of 30 runs" }, { pause: 2600 }, { mark: "eval-running" }, { wait: "Flagged" }, { mark: "eval-hurts" }],
  );
  await take(
    box,
    ["eval", "--replay", deploy.evalId, "--speed", "400"],
    [{ wait: "No task got worse" }, { mark: "eval-helps" }],
  );
  await take(
    box,
    ["eval", "--replay", pnpm.evalId, "--speed", "400"],
    [{ wait: "fewer turns" }, { mark: "eval-no-effect" }],
  );
  if (existsSync(MODELS)) {
    await take(box, ["check"], [{ wait: "review shows" }, { mark: "check" }]);
    await take(box, ["models"], [{ wait: "Searched" }, { mark: "models" }]);
  }
  await take(
    box,
    ["review"],
    [
      { wait: "? help" },
      { mark: "review-measured" },
      { key: "n" },
      { key: "n" },
      { wait: "UPDATE  api-v2-deadline.md" },
      { key: "j" },
      { key: "j" },
      { key: "j" },
      { key: "j" },
      { key: "j" },
      { key: "j" },
      { mark: "review-conflict" },
      { key: "n" },
      { key: "n" },
      { wait: "ADD  prefers-tabs.md" },
      { key: "j" },
      { key: "j" },
      { key: "j" },
      { key: "j" },
      { mark: "review-worse" },
      { key: "q" },
      { key: "y" },
    ],
  );

  // States made with the fake eval agent: it says fake-claude on screen.
  const bare = await sandbox({ model: false });
  await take(bare, ["models"], [{ wait: "Searched" }, { mark: "models-missing" }]);
  await take(bare, ["check"], [{ wait: "models install" }, { mark: "check-missing" }]);
  await writeFile(join(bare.root, "fake-claude.json"), JSON.stringify({ hookEvent: true }));
  await take(
    bare,
    ["eval", "prefer-pnpm", "--yes", "--runs", "6", "--parallel", "1"],
    [{ wait: "No verdict" }, { mark: "eval-isolation" }],
  );
  await writeFile(join(bare.root, "fake-claude.json"), JSON.stringify({ loggedOut: true }));
  await take(
    bare,
    ["eval", "prefer-pnpm", "--yes", "--runs", "6", "--parallel", "1"],
    [{ wait: "No verdict" }, { mark: "eval-logged-out" }],
  );
  await writeFile(join(bare.root, "fake-claude.json"), JSON.stringify({ sleepMs: 1200 }));
  await take(
    bare,
    ["eval", "prefer-pnpm", "--yes", "--runs", "6", "--parallel", "2"],
    [
      { wait: "2 running" },
      { pause: 2500 },
      { mark: "eval-live" },
      { key: "ctrl-c" },
      { wait: "No verdict" },
      { mark: "eval-interrupted" },
    ],
  );
  return casts;
}

/** The opener: the recorded eval of the memory nobody said, replayed. */
async function opener(evals) {
  const size = { cols: 100, rows: 34 };
  const box = await sandbox();
  const tape = [
    { prompt: `dreaming eval --replay ${evals["prefers-tabs.md"].evalId}` },
    await session(
      box,
      ["eval", "--replay", evals["prefers-tabs.md"].evalId, "--speed", "12"],
      [{ wait: "Flagged" }],
      size,
    ),
    { pause: 6000 },
  ];
  return castFromTape(tape, { ...size, title: "dreaming eval: a replay of a recorded eval (30 real claude -p runs)" });
}

/** The loop: dream, check, review with the measurements, why. */
async function loop() {
  const size = { cols: 100, rows: 32 };
  const box = await sandbox({ inbox: false });
  const tape = [
    { prompt: "dreaming run" },
    await session(box, ["run"], [{ wait: "Next" }], size, { DEMO_AGENT_DELAY_MS: "2500" }),
    { pause: 2500 },
    { prompt: "dreaming review" },
    await session(
      box,
      ["review"],
      [
        { wait: "? help" },
        { pause: 1800 },
        { key: "a" },
        { wait: "UPDATE" },
        { pause: 1200 },
        { key: "a" },
        { wait: "UPDATE  api-v2-deadline.md" },
        { pause: 900 },
        { key: "j" },
        { key: "j" },
        { key: "j" },
        { key: "j" },
        { key: "j" },
        { key: "j" },
        { pause: 3600 },
        { key: "a" },
        { wait: "ADD  staging-smoke-key.md" },
        { pause: 1200 },
        { key: "r" },
        { wait: "ADD  prefers-tabs.md" },
        { pause: 1500 },
        { key: "r" },
        { wait: "Submit review" },
        { pause: 2000 },
        { key: "y" },
        { wait: "Provenance" },
      ],
      size,
    ),
    { pause: 3000 },
  ];
  return castFromTape(tape, {
    ...size,
    title: "dreaming: dream, contradiction check, review (synthetic data, fake agent)",
  });
}

async function refuseLocalPaths(files) {
  const local = [homedir(), ROOT, tmpdir()];
  for (const file of files) {
    const text = await readFile(join(OUT, file), "utf8");
    const found = local.find((path) => text.includes(path));
    if (found) throw new Error(`${file} contains a local path (${found}); fix the scene before publishing`);
  }
}

async function main() {
  const [load] = loadavg();
  if (load > availableParallelism())
    console.warn(`warning: load average ${load.toFixed(0)}; recorded timing will show it.`);
  if (!existsSync(MODELS)) console.warn(`note: no NLI model at ${MODELS}; the contradiction-check scenes are skipped.`);
  spawnSync("chmod", ["+x", DREAM_AGENT, EVAL_AGENT]);
  const evals = await recordedEvals();
  await rm(join(OUT, "stills"), { recursive: true, force: true });
  await mkdir(join(OUT, "stills"), { recursive: true });
  const index = [];
  try {
    // The animations first, while this process is idle: their timing is shown as recorded.
    const animations = { eval: await opener(evals), loop: await loop() };
    for (const [name, size] of Object.entries(SIZES)) {
      for (const events of await stills(size, evals)) {
        const cast = castFromTape([{ events }], { ...size, title: "" });
        const { header, markers } = await playCast(cast);
        for (const [state, screen] of markers) {
          const file = `${state}-${name}.svg`;
          await writeFile(
            join(OUT, "stills", file),
            screenSvg(header, screen, `dreaming: ${state} (${header.width}×${header.height})`),
          );
          index.push({ state, size: name, file: `stills/${file}`, cols: header.width, rows: header.height });
        }
      }
    }
    for (const [name, cast] of Object.entries(animations)) {
      await writeFile(join(OUT, `${name}.cast`), cast);
      const { header, frames } = await playCast(cast);
      const title =
        name === "eval"
          ? "dreaming eval: a replay of a recorded eval, 30 real claude -p runs, in which a proposed memory breaks lint in every run"
          : "dreaming: a dream, the contradiction check and the review, recorded in a real terminal with synthetic data";
      const animation = animatedSvg(header, frames, { title });
      await writeFile(join(OUT, `${name}.svg`), animation.svg);
      console.log(
        `${name}: ${animation.frames} frames, ${(animation.durationMs / 1000).toFixed(1)} s, ${(animation.svg.length / 1024).toFixed(0)} KB`,
      );
    }
    await writeFile(join(OUT, "stills.json"), `${JSON.stringify(index, null, 2)}\n`);
    await refuseLocalPaths([...index.map((s) => s.file), "eval.cast", "eval.svg", "loop.cast", "loop.svg"]);
    console.log(`stills: ${index.length}`);
  } finally {
    for (const dir of temps) await rm(dir, { recursive: true, force: true });
  }
}

await main();
