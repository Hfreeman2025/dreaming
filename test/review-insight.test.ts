import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryHash, readMemoryFiles, saveChecks, type Checks } from "../src/contradict/store.js";
import { EvalRecordSchema, saveEval, type EvalRecord, type EvalRun } from "../src/eval/record.js";
import { summarise } from "../src/eval/summary.js";
import { insightKey, loadInsights, NO_INSIGHT, type Insight } from "../src/review/insight.js";
import { ReviewModel } from "../src/review/model.js";
import { renderList } from "../src/review/render.js";
import { renderConflicts, renderMeasured } from "../src/review/render-insight.js";
import { toPlain } from "../src/ui/text.js";
import { ADD, DEPLOY, INDEX, RUN_ID, UPDATE, runRecord } from "./helpers/review-fixtures.js";
import { makeSandbox, writeMemory, type Sandbox } from "./helpers/sandbox.js";

const run = (arm: EvalRun["arm"], task: string, outcome: EvalRun["outcome"], reason = ""): EvalRun => ({
  index: 0,
  arm,
  task,
  rep: 0,
  startedMs: 0,
  wallMs: 1000,
  outcome,
  reason,
  agent: {
    exitCode: 0,
    timedOut: false,
    subtype: "success",
    model: "m",
    turns: 3,
    durationMs: 900,
    costUsd: 0.01,
    usage: { input: 1, cacheCreation: 0, cacheRead: 10, output: 1 },
    toolCalls: {},
  },
  isolation: { hookEvents: 0, canaries: [], registryHooks: 0, packageCommands: 0, shimCalls: 0 },
});

function record(proposalId: string, runs: EvalRun[]): EvalRecord {
  return EvalRecordSchema.parse({
    schemaVersion: 1,
    evalId: "20261102-120000-abcd",
    createdAt: "2026-11-02T12:00:00.000Z",
    finishedAt: "2026-11-02T12:05:00.000Z",
    ended: "completed",
    endedBecause: null,
    proposal: { runId: RUN_ID, id: proposalId, action: "add", file: "prefer-pnpm.md", description: "" },
    memoryDir: "/m",
    suite: { name: "tidepool", about: "a", tasks: [{ id: "high-tide", prompt: "p", passMeans: "lint passes" }] },
    plan: { runs: 10, reps: 5, seed: 1, parallel: 3 },
    agent: { bin: "claude", version: null, model: null, argv: [] },
    isolation: {
      control: { ok: true, hookEvents: 4, canaries: ["SessionStart"], detail: "fired" },
      workDir: "/tmp/x",
      bashrc: false,
      audit: { samples: 10, seen: [], soundPlayers: [] },
    },
    runs,
  });
}

const tabsBreakLint = (): EvalRun[] => [
  ...Array.from({ length: 5 }, () => run("without", "high-tide", "pass")),
  ...Array.from({ length: 5 }, () =>
    run("with", "high-tide", "fail", "lint fails: high-tide.js:2: indent with spaces, not tabs"),
  ),
];

const plain = (lines: ReturnType<typeof renderMeasured>) => lines.map(toPlain).join("\n");

describe("the review shows what was measured and what conflicts", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
    await writeMemory(sandbox, "deploy-window.md", DEPLOY);
    await writeMemory(sandbox, "MEMORY.md", INDEX);
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  const modelWith = (insight: Insight) => {
    const pending = [{ run: runRecord([ADD, UPDATE], sandbox.memoryDir), proposal: ADD }];
    return new ReviewModel(pending, {
      memoryDir: sandbox.memoryDir,
      allowUnverified: false,
      insights: new Map([[insightKey(RUN_ID, ADD.id), insight]]),
    });
  };

  it("says how to measure and check a proposal that has neither", () => {
    const item = modelWith(NO_INSIGHT).item(0);
    expect(plain(renderMeasured(item, 100))).toBe(
      "Measured  not yet · dreaming eval prefer-pnpm.md runs a task suite with and without it",
    );
    expect(plain(renderConflicts(item, 100))).toBe(
      "Conflicts not checked · dreaming check compares it with every memory, on this machine",
    );
  });

  it("flags a memory measured to make a task worse, with the reason and the way to watch it", async () => {
    const measured = record(ADD.id, tabsBreakLint());
    const model = modelWith({
      measured: { record: measured, summary: summarise(measured.runs, ["high-tide"], 1) },
      contradictions: { state: "unchecked" },
    });
    const text = plain(renderMeasured(model.item(0), 120));
    expect(text).toContain("▼ worse: high-tide 5/5 → 0/5, p = 0.008 · overall −100 pts");
    expect(text).toContain("high-tide 5/5 → 0/5");
    expect(text).toContain("with it: lint fails: high-tide.js:2: indent with spaces, not tabs");
    expect(text).toContain("dreaming eval --replay 20261102-120000-abcd");
    expect((await model.assess(0)).notes).toContain("measured: this memory made high-tide worse (see Measured below)");
    expect(renderList(model, new Map(), 0, 100, 5).map(toPlain)[0]).toMatch(/ {2}▼$/);
  });

  it("shows a contradiction as both sentences, marked inferred, and says when it is out of date", () => {
    const contradiction = {
      a: { file: "prefer-pnpm.md", source: "proposal" as const, proposalId: ADD.id, sentence: "Use pnpm, never npm." },
      b: { file: "setup.md", source: "memory" as const, sentence: "Run npm install, never pnpm." },
      score: 0.97,
      ab: { contradiction: 0.97, entailment: 0.01, neutral: 0.02 },
      ba: { contradiction: 0.9, entailment: 0.05, neutral: 0.05 },
    };
    const model = modelWith({
      measured: null,
      contradictions: {
        state: "checked",
        check: { proposalId: ADD.id, pairs: 4, skipped: 0, ms: 80, contradictions: [contradiction] },
        checkedAt: "2026-11-02T12:00:00.000Z",
        stale: true,
      },
    });
    const text = plain(renderConflicts(model.item(0), 160));
    expect(text).toContain("Conflicts ≠ contradicts setup.md · inferred by a local NLI model; read both");
    expect(text).toContain("memory changed since; run dreaming check again");
    expect(text).toContain("┃ setup.md  1 sentence pair, up to 0.97");
    expect(text).toContain("┃ this  Use pnpm, never npm.");
    expect(text).toContain("┃ that  Run npm install, never pnpm.");
    expect(renderList(model, new Map(), 0, 100, 5).map(toPlain)[0]).toMatch(/ {2}≠$/);
  });

  it("loads saved evals and checks, and notices when memory changed since the check", async () => {
    const pending = [{ run: runRecord([ADD], sandbox.memoryDir), proposal: ADD }];
    await saveEval(sandbox.paths.evals, record(ADD.id, tabsBreakLint()));
    const checks: Checks = {
      schemaVersion: 1,
      runId: RUN_ID,
      checkedAt: "2026-11-02T12:00:00.000Z",
      model: { id: "m", revision: "r" },
      threshold: 0.8,
      memoryHash: memoryHash(await readMemoryFiles(sandbox.memoryDir)),
      proposals: [{ proposalId: ADD.id, pairs: 3, skipped: 1, ms: 50, contradictions: [] }],
    };
    await saveChecks(sandbox.paths.checks, checks);
    const fresh = (await loadInsights(sandbox.paths, sandbox.memoryDir, pending)).get(insightKey(RUN_ID, ADD.id));
    expect(fresh?.measured?.summary.verdict).toEqual({ kind: "hurts", worse: ["high-tide"] });
    expect(fresh?.contradictions).toMatchObject({ state: "checked", stale: false });
    await writeMemory(sandbox, "deploy-window.md", `${DEPLOY}\nEdited by hand.\n`);
    const stale = (await loadInsights(sandbox.paths, sandbox.memoryDir, pending)).get(insightKey(RUN_ID, ADD.id));
    expect(stale?.contradictions).toMatchObject({ state: "checked", stale: true });
  });
});
