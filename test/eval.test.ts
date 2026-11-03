import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredProposal } from "../src/inbox/schema.js";
import { memoryArms, memoryPrompt } from "../src/eval/arms.js";
import { runProcess } from "../src/agent/process.js";
import { MAX_RUNS, runEval, type EvalEvent, type EvalRequest } from "../src/eval/engine.js";
import { canarySettings, evalArgs, evalEnv, runControl, CANARY_EVENTS, EVAL_TOOLS } from "../src/eval/isolation.js";
import { startAudit } from "../src/eval/procwatch.js";
import { EvalRecordSchema, latestByProposal, loadEvals, saveEval, type EvalRun } from "../src/eval/record.js";
import {
  betaQuantile,
  bootstrapDifference,
  clopperPearson,
  fisherExact,
  incompleteBeta,
  newcombeDifference,
  normalQuantile,
  shuffled,
  simultaneousZ,
  wilson,
} from "../src/eval/stats.js";
import { parseStream, registryHookCount } from "../src/eval/stream.js";
import { summarise } from "../src/eval/summary.js";
import { loadSuite } from "../src/eval/suite.js";
import { ADD, DEPLOY, INDEX, UPDATE, runRecord } from "./helpers/review-fixtures.js";
import { makeSandbox, writeMemory, type Sandbox } from "./helpers/sandbox.js";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude-eval.mjs", import.meta.url));
const SUITE = fileURLToPath(new URL("../demo/suites/tidepool", import.meta.url));

describe("eval statistics", () => {
  it("computes the incomplete beta function and its quantiles", () => {
    expect(incompleteBeta(0.5, 2, 3)).toBeCloseTo(11 / 16, 10);
    expect(incompleteBeta(0.3, 1, 1)).toBeCloseTo(0.3, 10);
    expect(betaQuantile(0.6875, 2, 3)).toBeCloseTo(0.5, 6);
  });

  it("gives Clopper-Pearson exact intervals, including at 0 and n", () => {
    const at = (s: number, n: number) => {
      const { low, high } = clopperPearson(s, n);
      return [Number(low.toFixed(4)), Number(high.toFixed(4))];
    };
    expect(at(0, 10)).toEqual([0, 0.3085]);
    expect(at(5, 10)).toEqual([0.1871, 0.8129]);
    expect(at(10, 10)).toEqual([0.6915, 1]);
    expect(at(1, 5)).toEqual([0.0051, 0.7164]);
  });

  it("matches Newcombe's published examples for a difference of proportions (method 10)", () => {
    const round = (i: { low: number; high: number }) => [Number(i.low.toFixed(4)), Number(i.high.toFixed(4))];
    // Newcombe (1998), Statistics in Medicine 17:873-890, Table II.
    expect(round(newcombeDifference(48, 80, 56, 70))).toEqual([0.0524, 0.3339]);
    expect(round(newcombeDifference(3, 10, 9, 10))).toEqual([0.1705, 0.809]);
    expect(newcombeDifference(0, 5, 5, 5).low).toBeGreaterThan(0); // 0/5 against 5/5 is a real difference
    expect(newcombeDifference(4, 5, 5, 5).low).toBeLessThan(0); // 4/5 against 5/5 is not
    const w = wilson(0, 5);
    expect(w.low).toBe(0);
    expect(w.high).toBeCloseTo(0.4345, 4);
  });

  it("computes normal quantiles and the z that keeps several intervals at 95% together", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 6);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 6);
    expect(simultaneousZ(1)).toBeCloseTo(1.959964, 6);
    expect(simultaneousZ(3)).toBeCloseTo(2.39398, 5);
  });

  it("computes Fisher's exact test", () => {
    expect(fisherExact(0, 5, 5, 0)).toBeCloseTo(2 / 252, 6);
    expect(fisherExact(3, 2, 3, 2)).toBeCloseTo(1, 6);
  });

  it("bootstraps a difference in means within strata, reproducibly from the seed", () => {
    const strata = [
      { without: [10, 12, 11, 13, 9], with: [5, 6, 5, 7, 6] },
      { without: [100, 100, 100], with: [100, 100, 100] },
    ];
    const a = bootstrapDifference(strata, { seed: 3 });
    const b = bootstrapDifference(strata, { seed: 3 });
    expect(a).toEqual(b);
    expect(a?.estimate).toBeCloseTo((5 + 6 + 5 + 7 + 6 + 300) / 8 - (10 + 12 + 11 + 13 + 9 + 300) / 8, 10);
    expect(a?.high).toBeLessThan(0);
    const same = bootstrapDifference([{ without: [1, 2, 3, 4], with: [1, 2, 3, 4] }], { seed: 1 });
    expect(same?.low).toBeLessThanOrEqual(0);
    expect(same?.high).toBeGreaterThanOrEqual(0);
    expect(bootstrapDifference([{ without: [], with: [1] }], { seed: 1 })).toBeNull();
    // One run an arm resamples to itself: no interval until there are two.
    expect(bootstrapDifference([{ without: [3], with: [2] }], { seed: 1 })).toBeNull();
  });

  it("shuffles reproducibly from a seed", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(shuffled(items, 7)).toEqual(shuffled(items, 7));
    expect(shuffled(items, 7)).not.toEqual(items);
    expect([...shuffled(items, 7)].sort((x, y) => x - y)).toEqual(items);
  });
});

const run = (arm: EvalRun["arm"], task: string, outcome: EvalRun["outcome"], turns = 3): EvalRun => ({
  index: 0,
  arm,
  task,
  rep: 0,
  startedMs: 0,
  wallMs: 1000 * turns,
  outcome,
  reason: "",
  agent: {
    exitCode: 0,
    timedOut: false,
    subtype: "success",
    model: "m",
    turns,
    durationMs: 1000,
    costUsd: 0.01,
    usage: { input: 10, cacheCreation: 0, cacheRead: 100, output: 5 },
    toolCalls: {},
  },
  isolation: { hookEvents: 0, canaries: [], registryHooks: 0, packageCommands: 0, shimCalls: 0 },
});
const times = (n: number, make: () => EvalRun) => Array.from({ length: n }, make);

describe("eval verdicts", () => {
  it("says a memory helps when a task's interval is above zero", () => {
    const runs = [...times(5, () => run("without", "a", "fail")), ...times(5, () => run("with", "a", "pass"))];
    const s = summarise(runs, ["a"], 1);
    expect(s.verdict).toEqual({ kind: "helps", better: ["a"] });
    expect(s.tasks[0]?.with).toMatchObject({ passes: 5, n: 5 });
  });

  it("flags a memory that makes a task worse, even when another task improves", () => {
    const runs = [
      ...times(5, () => run("without", "a", "fail")),
      ...times(5, () => run("with", "a", "pass")),
      ...times(5, () => run("without", "b", "pass")),
      ...times(5, () => run("with", "b", "fail")),
    ];
    expect(summarise(runs, ["a", "b"], 1).verdict).toEqual({ kind: "mixed", better: ["a"], worse: ["b"] });
    const worse = [...times(5, () => run("without", "b", "pass")), ...times(5, () => run("with", "b", "fail"))];
    expect(summarise(worse, ["b"], 1).verdict).toEqual({ kind: "hurts", worse: ["b"] });
  });

  it("does not call a chance difference on one of several tasks an effect", () => {
    const chance = [
      ...times(5, () => run("without", "a", "fail")),
      ...times(4, () => run("with", "a", "pass")),
      run("with", "a", "fail"),
    ];
    const flat = (task: string) => [
      ...times(5, () => run("without", task, "pass")),
      ...times(5, () => run("with", task, "pass")),
    ];
    // On its own, 0/5 against 4/5 clears both the exact test (p = 0.048) and the 95% interval ...
    expect(summarise(chance, ["a"], 1).verdict).toEqual({ kind: "helps", better: ["a"] });
    // ... but as one of three tasks it does not clear the simultaneous one.
    const three = summarise([...chance, ...flat("b"), ...flat("c")], ["a", "b", "c"], 1);
    expect(three.taskConfidence).toBeCloseTo(1 - 0.05 / 3, 10);
    expect(three.verdict).toEqual({ kind: "no-effect" });
  });

  it("does not flag 5/5 against 1/5 on one of three tasks, where only the approximate interval clears zero", () => {
    const flat = (task: string) => [
      ...times(5, () => run("without", task, "pass")),
      ...times(5, () => run("with", task, "pass")),
    ];
    const runs = [
      ...times(5, () => run("without", "a", "pass")),
      run("with", "a", "pass"),
      ...times(4, () => run("with", "a", "fail")),
      ...flat("b"),
      ...flat("c"),
    ];
    const s = summarise(runs, ["a", "b", "c"], 1);
    expect(s.tasks[0]?.change?.high).toBeLessThan(0);
    expect(s.tasks[0]?.p).toBeCloseTo(10 / 210, 6);
    expect(s.tasks[0]?.significant).toBe(false);
    expect(s.verdict).toEqual({ kind: "no-effect" });
  });

  it("says there is no measurable effect when the interval includes zero", () => {
    const runs = [
      ...times(4, () => run("without", "a", "pass")),
      run("without", "a", "fail"),
      ...times(5, () => run("with", "a", "pass")),
    ];
    expect(summarise(runs, ["a"], 1).verdict).toEqual({ kind: "no-effect" });
  });

  it("does not count runs where the agent could not run, and says too few when an arm is empty", () => {
    const runs = [run("without", "a", "error"), run("with", "a", "pass")];
    const s = summarise(runs, ["a"], 1);
    expect(s.errors).toBe(1);
    expect(s.counted).toBe(1);
    expect(s.verdict).toEqual({ kind: "too-few" });
  });

  it("reports the change in turns and tokens with an interval", () => {
    const runs = [...times(5, () => run("without", "a", "pass", 8)), ...times(5, () => run("with", "a", "pass", 3))];
    const s = summarise(runs, ["a"], 1);
    expect(s.turns).toMatchObject({ without: 8, with: 3, estimate: -5, low: -5, high: -5 });
    expect(s.usage?.estimate).toBe(0);
    expect(s.costUsd).toBeCloseTo(0.1, 10);
  });
});

describe("eval isolation", () => {
  const invocation = {
    bin: "claude",
    cwd: "/tmp/slot/repo",
    prompt: "do it",
    settingsPath: "/tmp/slot/settings.json",
    debugFile: "/tmp/slot/debug.log",
    maxTurns: 20,
    model: "sonnet",
    memoryFile: "/tmp/slot/memory.md",
  };

  it("runs the agent in safe mode, without user settings, hooks, MCP servers or a transcript", () => {
    expect(evalArgs(invocation)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-hook-events",
      "--safe-mode",
      "--setting-sources",
      "project",
      "--settings",
      "/tmp/slot/settings.json",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--tools",
      "Bash,Read,Edit,Write,Glob,Grep",
      "--allowedTools",
      "Bash,Read,Edit,Write,Glob,Grep",
      "--permission-mode",
      "dontAsk",
      "--max-turns",
      "20",
      "--debug-file",
      "/tmp/slot/debug.log",
      "--model",
      "sonnet",
      "--append-system-prompt-file",
      "/tmp/slot/memory.md",
    ]);
    expect(evalArgs({ ...invocation, model: undefined, memoryFile: undefined })).not.toContain(
      "--append-system-prompt-file",
    );
    expect(EVAL_TOOLS).not.toContain("WebFetch");
  });

  it("builds the environment from an allowlist, so nothing of the person's session leaks in", () => {
    const env = evalEnv({
      binDir: "/s/bin",
      home: "/Users/sam",
      user: "sam",
      tmpDir: "/s/tmp",
      extra: { EVAL_REPO: "/s/repo" },
    });
    expect(Object.keys(env).sort()).toEqual([
      "EVAL_REPO",
      "HOME",
      "LANG",
      "LOGNAME",
      "PATH",
      "SHELL",
      "TERM",
      "TMPDIR",
      "USER",
    ]);
    expect(env.PATH).toBe("/s/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("arms a canary hook on every event, and turns all hooks off", () => {
    const settings: unknown = JSON.parse(canarySettings("/s/canary", true));
    expect(settings).toMatchObject({ disableAllHooks: true });
    const text = canarySettings("/s/canary", true);
    for (const event of CANARY_EVENTS) expect(text).toContain(`/usr/bin/touch '/s/canary/${event}'`);
    expect(JSON.parse(canarySettings("/s/canary", false))).not.toHaveProperty("disableAllHooks");
  });

  it("reads hook events, tool calls, usage and the answer from stream-json, counting what it does not recognise", () => {
    const stream = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        model: "claude-x",
        tools: ["Bash"],
        plugins: [{ name: "telemetry" }],
        mcp_servers: [],
      }),
      JSON.stringify({ type: "system", subtype: "hook_started", hook_event: "Stop", hook_name: "Stop" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm install" } }, { type: "text" }],
        },
      }),
      "not json",
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "YES",
        num_turns: 2,
        duration_ms: 900,
        total_cost_usd: 0.02,
        usage: { input_tokens: 5, cache_creation_input_tokens: 6, cache_read_input_tokens: 7, output_tokens: 8 },
      }),
    ].join("\n");
    const t = parseStream(stream);
    expect(t.model).toBe("claude-x");
    expect(t.plugins).toEqual(["telemetry"]);
    expect(t.hookEvents).toEqual([{ subtype: "hook_started", event: "Stop", name: "Stop" }]);
    expect(t.toolCalls).toEqual({ Bash: 1 });
    expect(t.bashCommands).toEqual(["pnpm install"]);
    expect(t.result).toMatchObject({
      answer: "YES",
      turns: 2,
      usage: { input: 5, cacheCreation: 6, cacheRead: 7, output: 8 },
    });
    expect(t.unrecognised).toBe(1);
    expect(
      registryHookCount("[DEBUG] Registered 0 hooks from 2 plugins\n[DEBUG] Hooks: Found 0 total hooks in registry"),
    ).toBe(0);
    expect(registryHookCount("[DEBUG] Hooks: Found 3 total hooks in registry")).toBe(3);
    expect(registryHookCount("nothing here")).toBeNull();
  });

  it("finds sound players anywhere below an agent, and ignores the rest of the machine", async () => {
    const rows = [
      { pid: 10, ppid: 1, name: "claude" },
      { pid: 11, ppid: 10, name: "bash" },
      { pid: 12, ppid: 11, name: "afplay" },
      { pid: 20, ppid: 1, name: "say" }, // someone else's
    ];
    const audit = startAudit(() => Promise.resolve(rows), 5);
    audit.track(10, 3);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const report = await audit.stop();
    expect(report.samples).toBeGreaterThan(0);
    expect(report.seen).toEqual(["afplay", "bash", "claude"]);
    expect(report.soundPlayers).toEqual([{ name: "afplay", run: 3 }]);
  });
});

describe("eval suites and memory arms", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
    await writeMemory(sandbox, "deploy-window.md", DEPLOY);
    await writeMemory(sandbox, "MEMORY.md", INDEX);
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("loads the demo suite and refuses paths that leave the suite directory", async () => {
    const suite = await loadSuite(SUITE);
    expect(suite.tasks.map((t) => t.id)).toEqual(["install-and-test", "deploy-day", "high-tide"]);
    expect(suite.tasks[0]?.timeoutSeconds).toBe(300);
    const dir = join(sandbox.root, "bad-suite");
    await mkdir(dir);
    const bad = {
      name: "x",
      about: "x",
      repo: "../../etc",
      tasks: [{ id: "a", prompt: "p", check: "c.mjs", passMeans: "p" }],
    };
    await writeFile(join(dir, "suite.json"), JSON.stringify(bad));
    await expect(loadSuite(dir)).rejects.toThrow("repo must be a path inside the suite directory");
  });

  it("differs between arms in the proposal only", async () => {
    const arms = await memoryArms(sandbox.memoryDir, { runId: "r", proposal: ADD });
    expect([...arms.without.keys()]).toEqual(["MEMORY.md", "deploy-window.md"]);
    expect([...arms.with.keys()].sort()).toEqual(["MEMORY.md", "deploy-window.md", "prefer-pnpm.md"]);
    expect(arms.with.get("deploy-window.md")).toBe(DEPLOY);
    expect(arms.with.get("MEMORY.md")).toContain("(prefer-pnpm.md)");
    const prompt = memoryPrompt(arms.with);
    expect(prompt.indexOf('name="MEMORY.md"')).toBeLessThan(prompt.indexOf('name="deploy-window.md"'));
    expect(memoryPrompt(new Map())).toBe("");
  });
});

// Each test here spawns dozens of real processes; a busy machine or CI runner needs more than 5 s.
describe("dreaming eval, end to end with a fake agent", { timeout: 60_000 }, () => {
  let sandbox: Sandbox;
  let work: string;
  const events: EvalEvent[] = [];
  beforeEach(async () => {
    sandbox = await makeSandbox();
    await writeMemory(sandbox, "deploy-window.md", DEPLOY);
    await writeMemory(sandbox, "MEMORY.md", INDEX);
    work = await realpath(await mkdtemp(join(tmpdir(), "dreaming-evaltest-")));
    events.length = 0;
  });
  afterEach(async () => {
    await sandbox.cleanup();
    await rm(work, { recursive: true, force: true });
  });

  const knobs = (value: object) => writeFile(join(sandbox.homedir, "fake-claude.json"), JSON.stringify(value));
  const request = async (proposal: StoredProposal, overrides: Partial<EvalRequest> = {}): Promise<EvalRequest> => ({
    proposal: { run: runRecord([proposal], sandbox.memoryDir), proposal },
    suite: await loadSuite(SUITE),
    memoryDir: sandbox.memoryDir,
    runs: 6,
    tasks: undefined,
    model: undefined,
    parallel: 3,
    seed: 11,
    bin: FAKE_CLAUDE,
    home: sandbox.homedir,
    user: "sam",
    keep: false,
    ...overrides,
  });
  const deps = (signals = new EventEmitter()) => ({
    now: () => new Date("2026-11-02T10:00:00.000Z"),
    onEvent: (event: EvalEvent) => events.push(event),
    signals,
    tmpRoot: () => mkdtemp(join(work, "eval-")),
    version: () => Promise.resolve("fake 1.0"),
    audit: () => startAudit(() => Promise.resolve([]), 50),
  });

  it("proves the hook detector first, then measures the memory through the suite's real checks", async () => {
    const record = await runEval(await request({ ...ADD, body: "Use pnpm, never npm." }, { runs: MAX_RUNS }), deps());
    expect(EvalRecordSchema.safeParse(record).success).toBe(true);
    expect(record.ended).toBe("completed");
    expect(record.isolation.control).toMatchObject({ ok: true });
    expect(record.isolation.control.canaries).toContain("SessionStart");
    expect(events[0]?.kind).toBe("control");
    expect(record.runs).toHaveLength(30);
    expect(record.plan).toMatchObject({ runs: 30, reps: 5 });
    for (const r of record.runs) expect(r.isolation).toMatchObject({ hookEvents: 0, canaries: [], registryHooks: 0 });
    const install = (arm: string) => record.runs.find((r) => r.task === "install-and-test" && r.arm === arm)?.isolation;
    expect(install("without")).toMatchObject({ packageCommands: 3, shimCalls: 3 });
    expect(install("with")).toMatchObject({ packageCommands: 2, shimCalls: 2 });
    const s = summarise(
      record.runs,
      record.suite.tasks.map((t) => t.id),
      record.plan.seed,
    );
    const installTask = s.tasks.find((t) => t.task === "install-and-test");
    expect(installTask?.without).toMatchObject({ passes: 0, n: 5 });
    expect(installTask?.with).toMatchObject({ passes: 5, n: 5 });
    expect(record.runs.find((r) => r.task === "install-and-test" && r.arm === "without")?.reason).toBe(
      "ran npm install (1×), which breaks the workspace links",
    );
    expect(s.tasks.find((t) => t.task === "deploy-day")?.with.passes).toBe(0); // the deploy memory is unchanged
    expect(s.verdict).toEqual({ kind: "helps", better: ["install-and-test"] });
    expect(s.turns?.estimate).toBeLessThan(0);
  });

  it("never puts the memory in an argument, where any process listing would show it", async () => {
    const seen: { args: string[]; mode: number | null }[] = [];
    const spy: typeof runProcess = async (command, env, limits) => {
      const file = command.args[command.args.indexOf("--append-system-prompt-file") + 1];
      seen.push({ args: command.args, mode: file === undefined ? null : (await stat(file)).mode & 0o777 });
      return runProcess(command, env, limits);
    };
    await runEval(await request({ ...ADD, body: "Use pnpm, never npm." }, { runs: 2, tasks: ["deploy-day"] }), {
      ...deps(),
      runAgent: spy,
    });
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.args.join(" ")).not.toContain("Use pnpm, never npm.");
      expect(call.args.join(" ")).not.toContain("Deploys go out on Tuesdays");
      expect(call.mode).toBe(0o600);
    }
  });

  it("flags a memory that breaks a task", async () => {
    const tabs: StoredProposal = { ...ADD, file: "prefers-tabs.md", name: "prefers-tabs", body: "Indent with tabs." };
    const record = await runEval(await request(tabs, { runs: 20, tasks: ["high-tide", "deploy-day"] }), deps());
    const s = summarise(record.runs, ["high-tide", "deploy-day"], record.plan.seed);
    expect(s.verdict).toEqual({ kind: "hurts", worse: ["high-tide"] });
    expect(record.runs.find((r) => r.arm === "with" && r.task === "high-tide")?.reason).toBe(
      "lint fails: packages/api/src/high-tide.js:2: indent with spaces, not tabs",
    );
  });

  it("measures an update against the memory it replaces", async () => {
    const record = await runEval(await request(UPDATE, { runs: 6, tasks: ["deploy-day"] }), deps());
    const s = summarise(record.runs, ["deploy-day"], record.plan.seed);
    expect(s.tasks[0]).toMatchObject({ without: { passes: 0, n: 3 }, with: { passes: 3, n: 3 } });
  });

  it("stops at the first run that shows a hook, and says why", async () => {
    await knobs({ hookEvent: true });
    const record = await runEval(await request(ADD, { parallel: 1 }), deps());
    expect(record.ended).toBe("isolation");
    expect(record.endedBecause).toContain("reported a hook");
    expect(record.runs).toHaveLength(1);
  });

  it("catches a hook that ran without being reported, by its canary file", async () => {
    await knobs({ canary: true });
    const record = await runEval(await request(ADD, { parallel: 1 }), deps());
    expect(record.ended).toBe("isolation");
    expect(record.runs[0]?.isolation.canaries).toEqual(["SessionStart", "Stop"]);
  });

  it("stops when package-manager commands did not reach the sandbox's shims", async () => {
    await knobs({ bypass: true });
    const record = await runEval(await request(ADD, { parallel: 1, tasks: ["install-and-test"], runs: 2 }), deps());
    expect(record.ended).toBe("error");
    expect(record.endedBecause).toContain("used real package-manager tools instead of the sandbox's shims");
    expect(record.runs[0]).toMatchObject({ outcome: "error", isolation: { shimCalls: 0 } });
    expect(record.runs[0]?.isolation.packageCommands).toBeGreaterThan(0);
  });

  it("refuses to start when the positive control does not fire", async () => {
    const silent = () =>
      Promise.resolve({ ok: false, hookEvents: 0, canaries: [], durationMs: 1, detail: "the canary did not fire" });
    await expect(runEval(await request(ADD), { ...deps(), control: silent })).rejects.toThrow(
      "the hook detector could not be checked, so isolation cannot be proved",
    );
    expect(events.filter((e) => e.kind === "started")).toHaveLength(0);
  });

  it("stops and says so when Claude Code is not logged in, not counting those runs", async () => {
    await knobs({ loggedOut: true });
    const record = await runEval(await request(ADD, { parallel: 1 }), deps());
    expect(record.ended).toBe("error");
    expect(record.endedBecause).toContain("not logged in");
    expect(record.runs[0]?.outcome).toBe("error");
  });

  it("keeps the finished runs when stopped with Ctrl-C", async () => {
    await knobs({ sleepMs: 400 });
    const signals = new EventEmitter();
    const pending = runEval(await request(ADD, { parallel: 1 }), deps(signals));
    // Ctrl-C as soon as one run has finished, whatever the machine's speed.
    while (!events.some((e) => e.kind === "finished")) await new Promise((resolve) => setTimeout(resolve, 20));
    signals.emit("SIGINT", "SIGINT");
    const record = await pending;
    expect(record.ended).toBe("interrupted");
    expect(record.runs.length).toBeGreaterThan(0);
    expect(record.runs.length).toBeLessThan(6);
  });

  it("caps an eval at 30 runs and needs enough runs for both arms", async () => {
    await expect(runEval(await request(ADD, { runs: 31 }), deps())).rejects.toThrow("at most 30 runs");
    await expect(runEval(await request(ADD, { runs: 4 }), deps())).rejects.toThrow("too few for 3 tasks");
    await expect(runEval(await request(ADD, { tasks: ["nope"] }), deps())).rejects.toThrow("no task called nope");
  });

  it("refuses to put sandboxes inside the home directory", async () => {
    const inside = () => mkdtemp(join(sandbox.homedir, "eval-"));
    await expect(runEval(await request(ADD), { ...deps(), tmpRoot: inside })).rejects.toThrow(
      "outside the home directory",
    );
  });

  it("saves records and finds the latest completed eval of each proposal", async () => {
    const record = await runEval(await request(UPDATE, { runs: 2, tasks: ["deploy-day"] }), deps());
    const dir = join(sandbox.root, "evals");
    const path = await saveEval(dir, record);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ evalId: record.evalId });
    const latest = latestByProposal(await loadEvals(dir));
    expect(latest.get(`${record.proposal.runId}/${record.proposal.id}`)?.evalId).toBe(record.evalId);
  });

  it("runs the real positive control against the fake CLI's hook behaviour", async () => {
    const control = await runControl(FAKE_CLAUDE, join(work, "control"), { home: sandbox.homedir, user: "sam" });
    expect(control).toMatchObject({ ok: true });
  });
});
