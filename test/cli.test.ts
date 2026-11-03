import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliContext } from "../src/commands/context.js";
import { ExitCode } from "../src/errors.js";
import { main } from "../src/main.js";
import type { CommandRunner } from "../src/schedule/install.js";
import {
  FAKE_AGENT,
  NOW,
  hoursAgo,
  makeSandbox,
  memoryFile,
  userEntry,
  writeConfigFile,
  writeMemory,
  writeTranscript,
  type Sandbox,
} from "./helpers/sandbox.js";

const REPLY = JSON.stringify({
  summary: "1 session: 1 new preference.",
  proposals: [
    {
      action: "add",
      name: "small-commits",
      description: "Keep commits small, one concern each",
      type: "feedback",
      body: "Keep commits small.\n\n**Why:** easier review.\n\n**How to apply:** split unrelated changes.",
      reason: "Stated directly.",
      evidence: [{ session: "S1", quote: "please keep commits small, one concern each" }],
      confidence: "high",
    },
  ],
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

describe("dreaming CLI", () => {
  let sandbox: Sandbox;
  let runnerCalls: string[];

  beforeEach(async () => {
    sandbox = await makeSandbox();
    runnerCalls = [];
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  const runner: CommandRunner = (bin, args) => {
    runnerCalls.push(`${bin} ${args.join(" ")}`);
    return Promise.resolve({ code: 1, stdout: "", stderr: "not loaded" });
  };

  async function cli(
    argv: string[],
    options: { stdin?: string[]; env?: Record<string, string>; platform?: NodeJS.Platform; columns?: number } = {},
  ): Promise<Result> {
    const terminal = (stream: PassThrough) =>
      options.columns === undefined ? stream : Object.assign(stream, { isTTY: true, columns: options.columns });
    const stdout = terminal(new PassThrough());
    const stderr = terminal(new PassThrough());
    let out = "";
    let err = "";
    stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    const ctx: CliContext = {
      env: {
        PATH: process.env.PATH,
        DREAMING_HOME: sandbox.paths.home,
        FAKE_AGENT_REPLY: REPLY,
        ...options.env,
      },
      homedir: sandbox.homedir,
      stdin: Readable.from(options.stdin ?? []),
      stdout,
      stderr,
      now: () => NOW,
      platform: options.platform ?? "darwin",
      uid: 501,
      runner,
      cliPath: "/opt/dreaming/dist/cli.js",
      nodePath: process.execPath,
    };
    const code = await main(argv, ctx);
    return { code, stdout: out, stderr: err };
  }

  async function setUp(): Promise<void> {
    await writeConfigFile(sandbox, {
      memoryDir: sandbox.memoryDir,
      transcripts: { root: sandbox.projectsDir },
      agent: { bin: FAKE_AGENT, timeoutSeconds: 20 },
    });
    await writeMemory(sandbox, "MEMORY.md", "");
    await writeTranscript(
      sandbox,
      "-work-tidepool",
      "11111111-aaaa-4aaa-8aaa-111111111111",
      [userEntry("Before you push: please keep commits small, one concern each.")],
      hoursAgo(5),
    );
  }

  it("prints help on request", async () => {
    const help = await cli(["--help"]);
    expect(help.code).toBe(ExitCode.ok);
    expect(help.stdout).toContain("\n  why <memory>          where a memory came from");
    expect(help.stdout).toContain("\n    --plain             line by line, for pipes and screen readers");
    // One description column (24) for commands, flags and environment alike.
    const rows = help.stdout
      .slice(help.stdout.indexOf("Commands\n"), help.stdout.indexOf("\nExit codes"))
      .split("\n")
      .filter((line) => line.startsWith("  "));
    expect(rows.length).toBeGreaterThan(30);
    for (const row of rows) expect([row, row[23], row[24]]).toEqual([row, " ", expect.stringMatching(/\S/)]);
  });

  it("with no command and no config, says how to start", async () => {
    const bare = await cli([]);
    expect(bare.code).toBe(ExitCode.ok);
    expect(bare.stdout).toContain("Not set up yet. Point it at the memory directory to curate:");
    expect(bare.stdout).toContain("dreaming init --memory-dir");
  });

  it("wraps an error and its hint at word breaks on a narrow terminal", async () => {
    const result = await cli(["status"], { columns: 40, env: { NO_COLOR: "1" } });
    expect(result.code).toBe(ExitCode.usage);
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(3); // the message and the hint both had to wrap
    expect(lines[0]).toMatch(/^dreaming: error: /);
    for (const line of lines.slice(1)) expect(line).toMatch(/^ {2}\S/);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
  });

  it("lays help out for a narrow terminal, each description under its label", async () => {
    const help = await cli(["--help"], { columns: 50 });
    expect(help.stdout).toContain(
      "\n  review\n      approve, reject, edit or skip each proposal,\n      then submit\n    --plain\n        line by line, for pipes and screen readers\n",
    );
    for (const line of help.stdout.split("\n")) expect(line.length).toBeLessThanOrEqual(50);
    expect((await cli(["--help"], { columns: 120 })).stdout).toBe((await cli(["--help"])).stdout);
  });

  it("on a narrow terminal, wraps the words but never cuts or breaks a command", async () => {
    const bare = await cli([], { columns: 40, env: { NO_COLOR: "1" } });
    expect(bare.stdout).toContain("\n  dreaming init --memory-dir ~/.claude/projects/<project>/memory\n");
    expect(bare.stdout).toContain("npm run demo");
    expect(bare.stdout).not.toContain("…");
    const prose = bare.stdout.split("\n").filter((line) => !line.includes("dreaming init"));
    for (const line of prose) expect(line.length).toBeLessThanOrEqual(40);
  });

  it("with no command, shows what is waiting and the one next step", async () => {
    await setUp();
    expect((await cli([])).stdout).toContain("Next  dreaming run --dry-run  see what the first dream would read");
    await cli(["run"]);
    const home = await cli([]);
    expect(home.stdout).toContain("Waiting     1 proposal from 1 dream");
    expect(home.stdout).toContain("Next  dreaming review  decide on what is waiting");
  });

  it("prints the package version", async () => {
    const result = await cli(["--version"]);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("exits 2 on an unknown command or flag", async () => {
    const unknown = await cli(["dream"]);
    expect(unknown.code).toBe(ExitCode.usage);
    expect(unknown.stderr).toContain("unknown command 'dream'");
    const badFlag = await cli(["run", "--verbose"]);
    expect(badFlag.code).toBe(ExitCode.usage);
    expect(badFlag.stderr).toContain("Unknown option '--verbose'");
    expect((await cli(["run", "--max-sessions", "0"])).code).toBe(ExitCode.usage);
  });

  it("exits 2 and points at init when there is no config", async () => {
    const result = await cli(["run"]);
    expect(result.code).toBe(ExitCode.usage);
    expect(result.stderr).toContain("no config file at");
    expect(result.stderr).toContain("dreaming init --memory-dir");
  });

  it("exits 2 on an invalid environment", async () => {
    const result = await cli(["status"], { env: { DREAMING_HOME: "relative" } });
    expect(result).toMatchObject({ code: ExitCode.usage });
    expect(result.stderr).toContain("DREAMING_HOME: must be an absolute path");
  });

  it("init writes a minimal config and refuses to overwrite it", async () => {
    const first = await cli(["init", "--memory-dir", sandbox.memoryDir, "--transcripts", sandbox.projectsDir]);
    expect(first.code).toBe(ExitCode.ok);
    expect(JSON.parse(await readFile(sandbox.paths.config, "utf8"))).toEqual({
      memoryDir: sandbox.memoryDir,
      transcripts: { root: sandbox.projectsDir },
    });
    const second = await cli(["init", "--memory-dir", sandbox.memoryDir]);
    expect(second.code).toBe(ExitCode.usage);
    expect(second.stderr).toContain("a config file already exists");
    expect((await cli(["init", "--memory-dir", join(sandbox.root, "missing"), "--force"])).stderr).toContain(
      "memory directory not found",
    );
  });

  it("runs, reviews and applies end to end", async () => {
    await setUp();
    const run = await cli(["run"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(ExitCode.ok);
    expect(run.stdout).toContain("  ✓ 1 session to read");
    expect(run.stdout).toContain("  … asking claude, read-only (this usually takes a few minutes)");
    expect(run.stdout).toMatch(/ {2}✓ claude replied after 0:0\d/);
    expect(run.stdout).toContain("1 proposal filed for review · 1 of 1 quotes verified\n");
    expect(run.stdout).not.toContain("agent's reply contained");
    expect(run.stdout).toMatch(/ {2}\+ add {4}small-commits\.md +feedback {3}high {4}1\/1 ✓/);
    expect(run.stdout).toContain("“1 session: 1 new preference.”");
    expect(run.stdout).toContain("Next  dreaming review");

    const reviewed = await cli(["review"], { stdin: ["a\n", "y\n"] });
    expect(reviewed.code).toBe(ExitCode.ok);
    expect(reviewed.stdout).toContain("a approve · r reject · e edit · s skip · q stop here > a\n");
    expect(reviewed.stdout).toContain("Provenance dreaming why small-commits");

    const why = await cli(["why", "small-commits"]);
    expect(why.code).toBe(ExitCode.ok);
    expect(why.stdout).toContain("✓ The file is exactly what dreaming last wrote.");
    expect(why.stdout).toContain("✓ still in the transcript");
    expect(await readFile(join(sandbox.memoryDir, "small-commits.md"), "utf8")).toBe(
      memoryFile(
        "small-commits",
        "Keep commits small, one concern each",
        "feedback",
        "Keep commits small.\n\n**Why:** easier review.\n\n**How to apply:** split unrelated changes.",
      ),
    );
    expect((await cli(["review"])).stdout).toBe(
      "No proposals are waiting for review.\n\nNext  dreaming run  file new proposals from recent sessions\n",
    );
    expect((await cli(["run"])).stdout).toBe("No new sessions to dream over.\n");
  });

  it("exits 1 with a hint when the agent's output is invalid", async () => {
    await setUp();
    const result = await cli(["run"], { env: { FAKE_AGENT_REPLY: '{"summary": "x"}' } });
    expect(result.code).toBe(ExitCode.failure);
    expect(result.stderr).toContain("dreaming: error: agent output failed validation");
    expect(result.stderr).toContain(
      "  Nothing was added to the inbox and the watermark did not move.\n  The agent's output (redacted) and the prompt are in ",
    );
  });

  it("exits 3 when the dream was saved but the webhook failed", async () => {
    await setUp();
    const result = await cli(["run"], { env: { DREAMING_WEBHOOK_URL: "http://127.0.0.1:9/unreachable" } });
    expect(result.code).toBe(ExitCode.notifyFailed);
    expect(result.stderr).toMatch(/warning: the dream was saved, but webhook to http:\/\/127\.0\.0\.1:9 failed/);
    expect(result.stderr).not.toContain("/unreachable");
  });

  it("run --dry-run prints the exact read-only command", async () => {
    await setUp();
    const result = await cli(["run", "--dry-run"]);
    expect(result.code).toBe(ExitCode.ok);
    expect(result.stdout).toContain("Would read 1 session\n");
    for (const flag of [
      "--print \\",
      "--output-format json \\",
      "--restricted \\",
      "--tools Read,Glob,Grep \\",
      "--allowedTools Read,Glob,Grep \\",
      "--disallowedTools Bash,Edit,MultiEdit,Write,NotebookEdit,WebFetch,WebSearch,Task,Agent \\",
      "--permission-mode dontAsk \\",
      "--strict-mcp-config \\",
      "--no-session-persistence \\",
    ]) {
      expect(result.stdout).toContain(`\n    ${flag}\n`);
    }
    expect(result.stdout).toContain("Dry run: the agent was not started and the watermark did not move.");
  });

  it("schedule install --print shows the plist without touching launchd", async () => {
    await setUp();
    const result = await cli(["schedule", "install", "--print", "--at", "03:15"], {
      env: { PATH: `${join(FAKE_AGENT, "..")}:${process.env.PATH ?? ""}` },
    });
    expect(result.code).toBe(ExitCode.ok);
    expect(result.stdout).toContain("<string>dev.dreaming.nightly</string>");
    expect(result.stdout).toContain("<integer>3</integer>");
    expect(result.stdout).toContain(`<string>${process.execPath}</string>`);
    expect(runnerCalls).toEqual([]);
  });

  it("refuses to schedule on Windows instead of guessing", async () => {
    await setUp();
    const result = await cli(["schedule", "install"], { platform: "win32" });
    expect(result.code).toBe(ExitCode.failure);
    expect(result.stderr).toContain("scheduling is not supported on Windows");
    expect(runnerCalls).toEqual([]);
  });

  it("schedule install refuses when the agent binary cannot be found", async () => {
    await writeConfigFile(sandbox, { memoryDir: sandbox.memoryDir, agent: { bin: "no-such-agent-binary" } });
    const result = await cli(["schedule", "install"]);
    expect(result.code).toBe(ExitCode.failure);
    expect(result.stderr).toContain("cannot find the agent binary 'no-such-agent-binary'");
    expect(runnerCalls).toEqual([]);
  });

  it("status summarises config, watermark, inbox and schedule", async () => {
    await setUp();
    await cli(["run"]);
    const result = await cli(["status"]);
    expect(result.code).toBe(ExitCode.ok);
    expect(result.stdout).toContain(`dreaming  ${sandbox.memoryDir} · 0 memories`);
    expect(result.stdout).toContain("Last dream  2026-11-01 07:00 UTC  ok  1 session: 1 new preference.");
    expect(result.stdout).toContain("Waiting     1 proposal from 1 dream");
    expect(result.stdout).toContain("Schedule    not scheduled");
  });
});
