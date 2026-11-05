#!/usr/bin/env node
// Record the real CLI, in a real pseudo-terminal, against synthetic data and
// the demo's fake agent:
//   shots/core/demo.cast + demo.svg   the core loop (run, review, why)
//   shots/core/stills/<state>-<size>.svg   every screen state at two terminal sizes
// Usage: npm run record:core (builds first). No model is called; nothing outside a
// temporary directory and shots/core is touched.
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, homedir, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFixtures } from "../demo/fixtures.mjs";
import { castFromTape, recordSession } from "./lib/pty.mjs";
import { animatedSvg, playCast, screenSvg } from "./lib/render.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "dist", "cli.js");
const AGENT = join(ROOT, "demo", "fake-agent.mjs");
const EDITOR = join(ROOT, "scripts", "lib", "demo-editor.mjs");
const OUT = join(ROOT, "shots", "core");
const SIZES = { wide: { cols: 120, rows: 36 }, narrow: { cols: 58, rows: 32 } };
const temps = [];

async function sandbox({ configured = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "dreaming-record-"));
  temps.push(root);
  const home = join(root, "dreaming-home");
  await mkdir(home, { recursive: true });
  // The recording shows ~/…, so the sandbox stands in for the home directory.
  const { memoryDir, projectsDir } = await writeFixtures(root, new Date());
  // The agent goes in the sandbox too, under an honest name, so the dry run
  // shows ~/bin/fake-claude rather than a path on the recording machine.
  const agent = join(root, "bin", "fake-claude");
  await mkdir(join(root, "bin"));
  await writeFile(agent, `#!/bin/sh\nexec '${process.execPath}' '${AGENT}' "$@"\n`);
  await chmod(agent, 0o755);
  if (configured) {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ memoryDir, transcripts: { root: projectsDir }, agent: { bin: agent } }),
    );
  }
  const env = { ...process.env, HOME: root, DREAMING_HOME: home, EDITOR, NO_COLOR: undefined };
  delete env.NO_COLOR;
  return { root, home, memoryDir, projectsDir, env };
}

function dreamQuietly(box) {
  const result = spawnSync(process.execPath, [CLI, "run"], { env: box.env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`setup run failed: ${result.stderr}`);
}

const session = (box, args, steps, size, env = {}) =>
  recordSession({
    argv: [process.execPath, CLI, ...args],
    env: { ...box.env, ...env },
    cwd: box.root,
    cols: size.cols,
    rows: size.rows,
    steps,
  });

/** Each scene: what to set up, which command, and where to take stills (markers). */
async function stills(size) {
  const casts = [];
  const take = (events) => casts.push(events);

  const unset = await sandbox({ configured: false });
  take((await session(unset, [], [{ wait: "Every command" }, { mark: "home-unset" }], size)).events);
  take((await session(unset, ["--help"], [{ wait: "Exit codes" }, { mark: "help" }], size)).events);

  const box = await sandbox();
  take((await session(box, ["run", "--dry-run"], [{ wait: "Dry run:" }, { mark: "run-dry" }], size)).events);
  take(
    (
      await session(
        box,
        ["run"],
        [{ wait: "asking claude" }, { pause: 2300 }, { mark: "run-loading" }, { wait: "Next" }, { mark: "run-result" }],
        size,
        { DEMO_AGENT_DELAY_MS: "5000" },
      )
    ).events,
  );
  take((await session(box, [], [{ wait: "Next" }, { mark: "home" }], size)).events);
  take(
    (
      await session(
        box,
        ["review"],
        [
          { wait: "? help" },
          { mark: "review-first" },
          { key: "j" },
          { key: "j" },
          { key: "j" },
          { key: "j" },
          { key: "j" },
          { key: "j" },
          { mark: "review-scrolled" },
          { key: "e" },
          { wait: "Edited." },
          { mark: "review-edited" },
          { key: "a" },
          { wait: "UPDATE" },
          { mark: "review-update" },
          { key: "a" },
          { wait: "api-v2-deadline.md" },
          { key: "a" },
          { wait: "staging-smoke-key.md" },
          { mark: "review-key" },
          { key: "r" },
          { wait: "prefers-tabs.md" },
          { key: "a" },
          { wait: "Can't approve" },
          { mark: "review-blocked" },
          { key: "?" },
          { wait: "Keys" },
          { mark: "review-help" },
          { key: "?" },
          { key: "q" },
          { wait: "Quit and discard" },
          { mark: "review-quit" },
          { key: "n" },
          { key: "r" },
          { wait: "Submit review" },
          { mark: "review-submit" },
          { key: "y" },
          { wait: "Provenance" },
          { mark: "review-applied" },
        ],
        size,
      )
    ).events,
  );
  take((await session(box, ["why", "prefer-pnpm"], [{ wait: "backup before" }, { mark: "why" }], size)).events);
  take((await session(box, ["run"], [{ wait: "No new sessions" }, { mark: "run-nothing" }], size)).events);
  take((await session(box, ["review"], [{ wait: "No proposals" }, { mark: "review-empty" }], size)).events);
  take((await session(box, ["status"], [{ wait: "Next" }, { mark: "status" }], size)).events);
  take(
    (await session(box, ["why", "user-role"], [{ wait: "No dreaming history" }, { mark: "why-none" }], size)).events,
  );
  // Then change things behind dreaming's back.
  await writeFile(join(box.memoryDir, "prefer-pnpm.md"), "---\nname: prefer-pnpm\n---\n\nChanged by hand.\n");
  for (const project of await readdir(box.projectsDir)) {
    for (const file of await readdir(join(box.projectsDir, project))) {
      if (file.startsWith("3b9e7c1a")) await rm(join(box.projectsDir, project, file));
    }
  }
  take((await session(box, ["why", "prefer-pnpm"], [{ wait: "backup before" }, { mark: "why-changed" }], size)).events);

  const plain = await sandbox();
  dreamQuietly(plain);
  take(
    (
      await session(
        plain,
        ["review", "--plain"],
        [
          { wait: "q stop here" },
          { mark: "review-plain" },
          { type: "s\r" },
          { wait: "q stop here" },
          { key: "ctrl-c" },
        ],
        size,
      )
    ).events,
  );
  take(
    (
      await session(plain, ["review"], [{ wait: "? help" }, { mark: "review-nocolor" }, { key: "q" }], size, {
        NO_COLOR: "1",
      })
    ).events,
  );
  take(
    (
      await session(plain, ["review"], [{ wait: "need" }, { mark: "review-small" }, { key: "q" }], {
        cols: 44,
        rows: 12,
      })
    ).events,
  );

  const broken = await sandbox();
  take(
    (
      await session(broken, ["run"], [{ wait: "Nothing was added" }, { mark: "run-error" }], size, {
        DEMO_AGENT_PROSE: "1",
      })
    ).events,
  );
  return casts;
}

async function demo() {
  const size = { cols: 100, rows: 30 };
  const box = await sandbox();
  const tape = [
    { prompt: "dreaming run" },
    await session(box, ["run"], [{ wait: "Next" }], size, { DEMO_AGENT_DELAY_MS: "3500" }),
    { pause: 2500 },
    { prompt: "dreaming review" },
    await session(
      box,
      ["review"],
      [
        { wait: "? help" },
        { pause: 2600 },
        { key: "j" },
        { pause: 250 },
        { key: "j" },
        { pause: 250 },
        { key: "j" },
        { pause: 250 },
        { key: "j" },
        { pause: 1600 },
        { key: "a" },
        { wait: "UPDATE" },
        { pause: 3200 },
        { key: "a" },
        { wait: "api-v2-deadline.md" },
        { pause: 1800 },
        { key: "a" },
        { wait: "staging-smoke-key.md" },
        { pause: 2200 },
        { key: "r" },
        { wait: "prefers-tabs.md" },
        { pause: 1400 },
        { key: "a" },
        { wait: "Can't approve" },
        { pause: 2600 },
        { key: "r" },
        { wait: "Submit review" },
        { pause: 3000 },
        { key: "y" },
        { wait: "Provenance" },
      ],
      size,
    ),
    { pause: 3000 },
    { prompt: "dreaming why prefer-pnpm" },
    await session(box, ["why", "prefer-pnpm"], [{ wait: "backup before" }], size),
    { pause: 1000 },
  ];
  const firstOutput = tape
    .filter((segment) => segment.events !== undefined)
    .map((segment) => `${(segment.events[0][0] * 1000).toFixed(0)} ms`);
  console.log(`demo: first output after starting run, review, why: ${firstOutput.join(", ")}`);
  return castFromTape(tape, { ...size, title: "dreaming: run, review, why (synthetic data, fake agent)" });
}

/** The recordings are published; a path from this machine in them means the sandbox leaked. */
async function refuseLocalPaths(files) {
  const local = [homedir(), ROOT.replace(/\/$/, ""), tmpdir()];
  for (const file of files) {
    const text = await readFile(join(OUT, file), "utf8");
    const found = local.find((path) => text.includes(path));
    if (found) throw new Error(`${file} contains a local path (${found}); fix the scene before publishing`);
  }
}

async function main() {
  // The demo is played back with the timing it was recorded with; on a busy
  // machine that timing shows the machine, not dreaming.
  const [load] = loadavg();
  if (load > availableParallelism()) {
    console.warn(
      `warning: load average ${load.toFixed(0)} on ${availableParallelism()} cores; the demo will look slower than dreaming is. Re-record when the machine is quieter.`,
    );
  }
  spawnSync("chmod", ["+x", AGENT, EDITOR]);
  await rm(join(OUT, "stills"), { recursive: true, force: true });
  await mkdir(join(OUT, "stills"), { recursive: true });
  const index = [];
  try {
    // The demo first, while this process is idle: its timing is shown as recorded.
    const cast = await demo();
    await writeFile(join(OUT, "demo.cast"), cast);
    for (const [name, size] of Object.entries(SIZES)) {
      for (const events of await stills(size)) {
        const still = castFromTape([{ events }], { ...size, title: "" });
        const { header, markers } = await playCast(still);
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
    const { header, frames } = await playCast(cast);
    const animation = animatedSvg(header, frames, {
      title: "dreaming: run, review and why, recorded in a real terminal with synthetic data",
    });
    await writeFile(join(OUT, "demo.svg"), animation.svg);
    await writeFile(join(OUT, "stills.json"), `${JSON.stringify(index, null, 2)}\n`);
    await refuseLocalPaths([...index.map((still) => still.file), "demo.cast", "demo.svg"]);
    console.log(
      `demo: ${animation.frames} frames, ${(animation.durationMs / 1000).toFixed(1)} s, ${animation.uniqueRows} unique rows, ${(animation.svg.length / 1024).toFixed(0)} KB`,
    );
    console.log(`stills: ${index.length}`);
  } finally {
    for (const dir of temps) await rm(dir, { recursive: true, force: true });
  }
}

await main();
