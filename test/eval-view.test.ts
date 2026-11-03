import { describe, expect, it } from "vitest";
import { intervalBar, renderEval, renderVerdict, type EvalView } from "../src/commands/eval-view.js";
import { EvalRecordSchema, type EvalRun } from "../src/eval/record.js";
import { toPlain, type Line } from "../src/ui/text.js";

const run = (index: number, arm: EvalRun["arm"], task: string, rep: number, outcome: EvalRun["outcome"]): EvalRun => ({
  index,
  arm,
  task,
  rep,
  startedMs: index * 1000,
  wallMs: 20_000,
  outcome,
  reason: outcome === "fail" ? "lint fails: high-tide.js:2: indent with spaces, not tabs" : "ok",
  agent: {
    exitCode: 0,
    timedOut: false,
    subtype: "success",
    model: "claude-sonnet-5",
    turns: 5,
    durationMs: 19_000,
    costUsd: 0.03,
    usage: { input: 10, cacheCreation: 1000, cacheRead: 50_000, output: 900 },
    toolCalls: {},
  },
  isolation: { hookEvents: 0, canaries: [], registryHooks: 0, packageCommands: 0, shimCalls: 0 },
});

function view(runs: EvalRun[]): EvalView {
  const record = EvalRecordSchema.parse({
    schemaVersion: 1,
    evalId: "20261102-120000-abcd",
    createdAt: "2026-11-02T12:00:00.000Z",
    finishedAt: "2026-11-02T12:05:00.000Z",
    ended: "completed",
    endedBecause: null,
    proposal: {
      runId: "20261101-020000-abcd",
      id: "20261101-020000-abcd-5",
      action: "add",
      file: "prefers-tabs.md",
      description: "",
    },
    memoryDir: "/m",
    suite: {
      name: "tidepool",
      about: "a",
      tasks: [
        { id: "high-tide", prompt: "p", passMeans: "lint passes" },
        { id: "deploy-day", prompt: "p", passMeans: "answers YES" },
      ],
    },
    plan: { runs: 20, reps: 5, seed: 1, parallel: 3 },
    agent: { bin: "claude", version: "2.1.281", model: null, argv: [] },
    isolation: {
      control: { ok: true, hookEvents: 4, canaries: ["SessionStart"], detail: "fired" },
      workDir: "/tmp/x",
      bashrc: false,
      audit: { samples: 10, seen: [], soundPlayers: [] },
    },
    runs,
  });
  return {
    record,
    control: { ...record.isolation.control, durationMs: 0 },
    planned: runs.map((r) => ({ index: r.index, arm: r.arm, task: r.task, rep: r.rep })),
    runs,
    running: new Map(),
    stopping: null,
    elapsedMs: 300_000,
    done: true,
    replay: null,
  };
}

const finished = (): EvalRun[] => {
  const runs: EvalRun[] = [];
  for (let rep = 0; rep < 5; rep += 1) {
    runs.push(run(runs.length, "without", "high-tide", rep, "pass"));
    runs.push(run(runs.length, "with", "high-tide", rep, "fail"));
    runs.push(run(runs.length, "without", "deploy-day", rep, rep < 2 ? "pass" : "fail"));
    runs.push(run(runs.length, "with", "deploy-day", rep, rep < 3 ? "pass" : "fail"));
  }
  return runs;
};
const text = (lines: Line[]) => lines.map(toPlain);

describe("the eval screen", () => {
  it("marks a change that holds up with a symbol as well as a colour, and leaves chance unmarked", () => {
    const lines = text(renderEval(view(finished()), 119));
    expect(lines.find((l) => l.startsWith("high-tide"))).toMatch(
      /✓ ✓ ✓ ✓ ✓ {2}5\/5 .* ✗ ✗ ✗ ✗ ✗ {2}0\/5 .*−100 pts ▼$/,
    );
    expect(lines.find((l) => l.startsWith("deploy-day"))).toMatch(/\+20 pts$/);
  });

  it("fits a narrow terminal and labels the arms when the column headers are gone", () => {
    for (const width of [57, 119]) {
      for (const line of text(renderEval(view(finished()), width))) expect(line.length).toBeLessThanOrEqual(width);
    }
    const narrow = text(renderEval(view(finished()), 57));
    expect(narrow).toContain("  without ✓✓✓✓✓  5/5        with ✗✗✗✗✗  0/5        ");
    expect(narrow.some((l) => l.startsWith("pass rate   without 70% ["))).toBe(true);
    expect(narrow.some((l) => /^ {12}with {4}30% \[/.test(l))).toBe(true);
  });

  it("shows waiting, running and finished runs as cells, and says when it is still checking the detector", () => {
    const v = view(finished().slice(0, 3));
    v.planned = finished().map((r) => ({ index: r.index, arm: r.arm, task: r.task, rep: r.rep }));
    v.running.set(3, 0);
    v.control = null;
    v.done = false;
    const lines = text(renderEval(v, 119));
    expect(lines.find((l) => l.startsWith("high-tide"))).toContain("✓ ○ ○ ○ ○");
    expect(lines.find((l) => l.startsWith("deploy-day"))).toContain("● ○ ○ ○ ○");
    expect(lines.join("\n")).toContain("checking the hook detector (a free control run, no model call)");
    expect(lines.at(-1)).toContain("3 of 20 runs · 1 running");
  });

  it("draws the interval on a −100 to +100 axis, zero in the middle", () => {
    expect(toPlain(intervalBar(null, 21))).toBe("──────────┼──────────");
    expect(toPlain(intervalBar({ estimate: -1, low: -1, high: -0.5 }, 21))).toBe("●━━━━━────┼──────────");
  });

  it("says why a memory is flagged, with the failing reason and the corrected interval", () => {
    const verdict = text(renderVerdict(view(finished()), 119)).join("\n");
    expect(verdict).toContain("✗ Makes things worse. Flagged in dreaming review.");
    expect(verdict).toContain("high-tide 5/5 → 0/5  −100 pts, 97.5% CI −100 to");
    expect(verdict).toContain("with it: lint fails: high-tide.js:2: indent with spaces, not tabs");
    expect(verdict).toContain("exact p = 0.008");
    expect(verdict).toContain(
      "A task counts only when Fisher's exact test is below 0.05/2 and its 97.5% interval clears zero",
    );
  });
});
