import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliContext } from "../src/commands/context.js";
import { ExitCode } from "../src/errors.js";
import { saveRun } from "../src/inbox/store.js";
import { main } from "../src/main.js";
import { ADD, DEPLOY, INDEX, UPDATE, runRecord } from "./helpers/review-fixtures.js";
import { NOW, makeSandbox, writeConfigFile, writeMemory, type Sandbox } from "./helpers/sandbox.js";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude-eval.mjs", import.meta.url));
const SUITE = fileURLToPath(new URL("../demo/suites/tidepool", import.meta.url));

// Each test here spawns dozens of real processes; a busy machine or CI runner needs more than 5 s.
describe("dreaming eval, check and models on the command line", { timeout: 60_000 }, () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
    await writeMemory(sandbox, "deploy-window.md", DEPLOY);
    await writeMemory(sandbox, "MEMORY.md", INDEX);
    await writeConfigFile(sandbox, {
      memoryDir: sandbox.memoryDir,
      transcripts: { root: sandbox.projectsDir },
      agent: { bin: FAKE_CLAUDE },
      eval: { suite: SUITE },
    });
    await saveRun(
      sandbox.paths.inbox,
      runRecord([{ ...ADD, body: "Use pnpm, never npm." }, UPDATE], sandbox.memoryDir),
    );
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  async function cli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = "";
    let err = "";
    stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    const ctx: CliContext = {
      env: { PATH: process.env.PATH, DREAMING_HOME: sandbox.paths.home, NO_COLOR: "1" },
      homedir: sandbox.homedir,
      stdin: Readable.from([]),
      stdout,
      stderr,
      now: () => NOW,
      platform: "darwin",
      uid: 501,
      runner: () => Promise.resolve({ code: 1, stdout: "", stderr: "" }),
      cliPath: "/opt/dreaming/dist/cli.js",
      nodePath: process.execPath,
    };
    const code = await main(argv, ctx);
    return { code, stdout: out, stderr: err };
  }

  it("lists what is waiting and what has been measured", async () => {
    const result = await cli(["eval"]);
    expect(result.code).toBe(ExitCode.ok);
    expect(result.stdout).toMatch(/prefer-pnpm\.md +add +not measured/);
    expect(result.stdout).toContain("dreaming eval <file> --suite <dir>");
  });

  it("shows the plan and the exact isolated command on a dry run, calling no model", async () => {
    const result = await cli(["eval", "prefer-pnpm", "--dry-run"]);
    expect(result.code).toBe(ExitCode.ok);
    expect(result.stdout).toContain("30 fake-claude-eval.mjs -p runs: 3 tasks × 5 × 2 arms, 3 at a time");
    for (const flag of [
      "--safe-mode \\",
      "--setting-sources project \\",
      "--no-session-persistence \\",
      "--include-hook-events \\",
    ]) {
      expect(result.stdout).toContain(flag);
    }
    expect(result.stdout).toContain("Dry run: no model was called.");
    expect(await readdir(sandbox.paths.home)).not.toContain("evals");
  });

  it("will not start real model calls without a terminal unless told to", async () => {
    const result = await cli(["eval", "prefer-pnpm"]);
    expect(result.code).toBe(ExitCode.usage);
    expect(result.stderr).toContain("makes 30 model calls; pass --yes");
  });

  it("runs, saves the record, and then shows it in the list, a replay and the review", async () => {
    const run = await cli(["eval", "prefer-pnpm", "--yes", "--runs", "6", "--seed", "4"]);
    expect(run.code).toBe(ExitCode.ok);
    expect(run.stdout).toContain("isolated: canary fired on SessionStart");
    expect(run.stdout).toMatch(/ \d\/6 {2}(with|without) +install-and-test {2}(pass|fail)/);
    expect(run.stdout).toContain("No measurable effect at this sample size.");
    expect(run.stdout).toContain("Shown in dreaming review next to the proposal.");
    const [saved] = await readdir(join(sandbox.paths.home, "evals"));
    expect(saved).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}\.json$/);

    expect((await cli(["eval"])).stdout).toMatch(
      /prefer-pnpm\.md +add +no measurable effect · overall [±+−]?\d+ pts .* 6 runs/,
    );

    const replay = await cli(["eval", "--replay", join(sandbox.paths.home, "evals", saved ?? "")]);
    expect(replay.code).toBe(ExitCode.ok);
    expect(replay.stdout).toMatch(/▶ replay at \d+× of eval/);
    expect(replay.stdout).toContain("6 of 6 runs");

    const review = await cli(["review", "--plain", "--dry-run"]);
    expect(review.stdout).toMatch(/Measured +no measurable effect · [^\n]* 6 real runs on tidepool/);
    expect(review.stdout).toContain("dreaming eval --replay");
    expect(review.stdout).toMatch(/Conflicts +not checked · dreaming check/);
  });

  it("says plainly that a stopped eval has no verdict, and keeps it out of the review", async () => {
    await writeFile(join(sandbox.homedir, "fake-claude.json"), JSON.stringify({ hookEvent: true }));
    const run = await cli(["eval", "prefer-pnpm", "--yes", "--runs", "6", "--parallel", "1"]);
    expect(run.code).toBe(ExitCode.failure);
    expect(run.stdout).toContain("✗ not isolated: run 1 reported a hook");
    expect(run.stdout).toContain("No verdict. The 1 finished run is saved in");
    expect(run.stdout).not.toContain("Shown in dreaming review");
    expect(run.stdout).not.toContain("✓ isolated");
    expect(run.stderr).toContain("run 1 reported a hook");
    expect((await cli(["eval"])).stdout).toMatch(/prefer-pnpm\.md +add +not measured/);
  });

  it("prints the whole record and its summary as JSON for scripts", async () => {
    const result = await cli(["eval", "deploy-window", "--yes", "--runs", "2", "--tasks", "deploy-day", "--json"]);
    expect(result.code).toBe(ExitCode.ok);
    const parsed: unknown = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ record: { ended: "completed", plan: { runs: 2 } }, summary: { counted: 2 } });
  });

  it("explains, rather than fails strangely, when the contradiction model is not installed", async () => {
    const check = await cli(["check"]);
    expect(check.code).toBe(ExitCode.failure);
    expect(check.stderr).toContain("cannot check for contradictions: the NLI model is not installed");
    expect(check.stderr).toContain("dreaming models install downloads it (96 MB, from huggingface.co)");
    const models = await cli(["models"]);
    expect(models.stdout).toContain("Not installed. dreaming models install downloads 95.9 MB from huggingface.co");
    expect(models.stdout).toContain("Without it, everything works except the contradiction check.");
    const install = await cli(["models", "install"]);
    expect(install.code).toBe(ExitCode.usage);
    expect(install.stderr).toContain("the download is 95.9 MB; pass --yes to start it without a terminal");
  });
});
