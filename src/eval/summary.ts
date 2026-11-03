import type { EvalRun } from "./record.js";
import { totalTokens } from "./stream.js";
import {
  bootstrapDifference,
  clopperPearson,
  fisherExact,
  newcombeDifference,
  simultaneousZ,
  type Interval,
} from "./stats.js";

/**
 * What an eval's runs say, computed the same way while it runs (from the
 * runs so far) and afterwards (from the record). Runs that errored (the agent
 * could not run at all) are not counted; they are reported.
 */

export interface Rate {
  passes: number;
  n: number;
  interval: Interval;
}

export interface TaskSummary {
  task: string;
  without: Rate;
  with: Rate;
  change: (Interval & { estimate: number }) | null;
  /** Two-sided Fisher exact p for the 2×2 table; null until both arms have runs. */
  p: number | null;
  /**
   * Moved beyond chance: Fisher's exact test below 0.05/k and the simultaneous
   * interval clear of zero. Both must agree, so a flag never rests on an
   * approximation at the edge (at 5/5 against 1/5 the interval clears zero, the
   * exact test does not).
   */
  significant: boolean;
}

export interface MeanChange {
  without: number;
  with: number;
  estimate: number;
  low: number;
  high: number;
}

export type Verdict =
  | { kind: "helps"; better: string[] }
  | { kind: "hurts"; worse: string[] }
  | { kind: "mixed"; better: string[]; worse: string[] }
  | { kind: "no-effect" }
  | { kind: "too-few" };

export interface EvalSummary {
  tasks: TaskSummary[];
  /** The confidence of each per-task interval: 95% shared across the tasks compared (Bonferroni). */
  taskConfidence: number;
  overall: { without: Rate; with: Rate; change: (Interval & { estimate: number }) | null };
  turns: MeanChange | null;
  /** Tokens per run (input, cached and output together). */
  usage: MeanChange | null;
  seconds: MeanChange | null;
  costUsd: number;
  totalUsage: number;
  counted: number;
  errors: number;
  verdict: Verdict;
}

const rate = (runs: readonly EvalRun[]): Rate => {
  const passes = runs.filter((r) => r.outcome === "pass").length;
  return { passes, n: runs.length, interval: clopperPearson(passes, runs.length) };
};

export function summarise(runs: readonly EvalRun[], taskIds: readonly string[], seed: number): EvalSummary {
  const counted = runs.filter((r) => r.outcome !== "error");
  const arm = (which: EvalRun["arm"], task?: string) =>
    counted.filter((r) => r.arm === which && (task === undefined || r.task === task));

  // Each task is its own comparison, so the per-task intervals are simultaneous: with k
  // tasks, a chance "effect" on one of them would otherwise turn up far more than 5% of the time.
  const compared = taskIds.filter((task) => arm("without", task).length > 0 && arm("with", task).length > 0).length;
  const z = simultaneousZ(compared);
  const tasks = taskIds.map((task): TaskSummary => {
    const a = rate(arm("without", task));
    const b = rate(arm("with", task));
    const both = a.n > 0 && b.n > 0;
    const change = both ? newcombeDifference(a.passes, a.n, b.passes, b.n, z) : null;
    const p = both ? fisherExact(a.passes, a.n - a.passes, b.passes, b.n - b.passes) : null;
    const clear = change !== null && (change.low > 0 || change.high < 0);
    return {
      task,
      without: a,
      with: b,
      change,
      p,
      significant: clear && p !== null && p < 0.05 / Math.max(1, compared),
    };
  });
  const without = rate(arm("without"));
  const withMemory = rate(arm("with"));
  const overallChange =
    without.n > 0 && withMemory.n > 0
      ? newcombeDifference(without.passes, without.n, withMemory.passes, withMemory.n)
      : null;

  // Means wait until every task has two runs in each arm: a partial average over whichever
  // tasks happen to have finished would describe a different mix of tasks.
  const ready = taskIds.every((task) => arm("without", task).length >= 2 && arm("with", task).length >= 2);
  const means = (value: (r: EvalRun) => number): MeanChange | null =>
    !ready
      ? null
      : bootstrapDifference(
          taskIds.map((task) => ({ without: arm("without", task).map(value), with: arm("with", task).map(value) })),
          { seed, resamples: 4000 },
        );

  const better = tasks.filter((t) => t.significant && (t.change?.estimate ?? 0) > 0).map((t) => t.task);
  const worse = tasks.filter((t) => t.significant && (t.change?.estimate ?? 0) < 0).map((t) => t.task);
  let verdict: Verdict;
  if (without.n < 2 || withMemory.n < 2) verdict = { kind: "too-few" };
  else if (worse.length > 0 && better.length > 0) verdict = { kind: "mixed", better, worse };
  // Decided task by task: the pooled interval mixes tasks with different base rates, so it is context only.
  else if (worse.length > 0) verdict = { kind: "hurts", worse };
  else if (better.length > 0) verdict = { kind: "helps", better };
  else verdict = { kind: "no-effect" };

  return {
    tasks,
    taskConfidence: 1 - 0.05 / Math.max(1, compared),
    overall: { without, with: withMemory, change: overallChange },
    turns: means((r) => r.agent.turns),
    usage: means((r) => totalTokens(r.agent.usage)),
    seconds: means((r) => r.wallMs / 1000),
    costUsd: runs.reduce((sum, r) => sum + r.agent.costUsd, 0),
    totalUsage: runs.reduce((sum, r) => sum + totalTokens(r.agent.usage), 0),
    counted: counted.length,
    errors: runs.length - counted.length,
    verdict,
  };
}
