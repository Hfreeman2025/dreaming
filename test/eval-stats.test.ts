import { describe, expect, it } from "vitest";
import type { EvalRun } from "../src/eval/record.js";
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
import { summarise } from "../src/eval/summary.js";

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
