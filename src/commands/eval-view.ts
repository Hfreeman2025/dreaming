import type { ControlResult } from "../eval/isolation.js";
import type { EvalRecord, EvalRun } from "../eval/record.js";
import { summarise, type EvalSummary, type MeanChange, type Rate } from "../eval/summary.js";
import { stripControl } from "../text.js";
import { span, truncate, wrap, type Line, type Style } from "../ui/text.js";
import { clock } from "./run-view.js";

/**
 * The `dreaming eval` screen. One renderer draws it while the runs go (live
 * or replayed from a record) and once they are done: every run as a cell,
 * each arm's pass rate with its exact interval, and the change between the
 * arms as an interval on a −100 to +100 point axis that narrows as evidence
 * arrives. The screen changes only when a run starts or finishes, and the
 * elapsed clock ticks once a second.
 */

export interface PlannedRun {
  index: number;
  arm: EvalRun["arm"];
  task: string;
  rep: number;
}

export interface EvalView {
  record: Pick<EvalRecord, "proposal" | "suite" | "plan" | "agent" | "evalId" | "createdAt">;
  control: ControlResult | null;
  planned: PlannedRun[];
  runs: EvalRun[];
  /** Run index -> when it started, in ms from the start of the eval. */
  running: Map<number, number>;
  stopping: { ended: EvalRecord["ended"]; because: string } | null;
  elapsedMs: number;
  done: boolean;
  replay: { speed: number } | null;
}

const clean = stripControl;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const pts = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(Math.round(x * 100))}`;

export function compact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`;
  return `${sign}${Math.round(abs)}`;
}

const CELL: Record<EvalRun["outcome"] | "running" | "waiting", { mark: string; style: Style }> = {
  pass: { mark: "✓", style: "ok" },
  fail: { mark: "✗", style: "bad" },
  error: { mark: "!", style: "warn" },
  running: { mark: "●", style: "accent" },
  waiting: { mark: "○", style: "dim" },
};

function cells(view: EvalView, task: string, arm: EvalRun["arm"], gap: string): Line {
  const reps = view.record.plan.reps;
  const out: Line = [];
  for (let rep = 0; rep < reps; rep += 1) {
    const done = view.runs.find((r) => r.task === task && r.arm === arm && r.rep === rep);
    const planned = view.planned.find((p) => p.task === task && p.arm === arm && p.rep === rep);
    const state = done?.outcome ?? (planned !== undefined && view.running.has(planned.index) ? "running" : "waiting");
    if (rep > 0) out.push(span(gap));
    out.push(span(CELL[state].mark, CELL[state].style));
  }
  return out;
}

const count = (rate: Rate) => `${rate.passes}/${rate.n}`;

/**
 * An interval on a −100 to +100 point axis: the axis dim, zero marked, the
 * interval drawn heavy in the colour of what it says (green above zero, red
 * below, plain across it) and the estimate as a dot.
 */
export function intervalBar(change: { estimate: number; low: number; high: number } | null, width: number): Line {
  const w = Math.max(11, width % 2 === 0 ? width - 1 : width);
  const at = (x: number) => Math.round(((Math.max(-1, Math.min(1, x)) + 1) / 2) * (w - 1));
  const zero = at(0);
  const chars: { ch: string; style: Style }[] = Array.from({ length: w }, (_, i) => ({
    ch: i === zero ? "┼" : "─",
    style: "dim",
  }));
  if (change !== null) {
    const style: Style = change.low > 0 ? "ok" : change.high < 0 ? "bad" : "bold";
    for (let i = at(change.low); i <= at(change.high); i += 1) {
      const cell = chars[i];
      if (cell) {
        cell.ch = "━";
        cell.style = style;
      }
    }
    const dot = chars[at(change.estimate)];
    if (dot) {
      dot.ch = "●";
      dot.style = style;
    }
  }
  const line: Line = [];
  for (const { ch, style } of chars) {
    const last = line.at(-1);
    if (last && last.style === style) last.text += ch;
    else line.push(span(ch, style));
  }
  return line;
}

function axisLabels(width: number, offset: number): Line {
  const w = Math.max(11, width % 2 === 0 ? width - 1 : width);
  const middle = Math.floor((w - 1) / 2);
  const left = "−100";
  const right = "+100";
  const pad = (n: number) => " ".repeat(Math.max(0, n));
  return [
    span(pad(offset)),
    span(left, "dim"),
    span(pad(middle - left.length)),
    span("0", "dim"),
    span(pad(w - middle - 1 - right.length)),
    span(right, "dim"),
  ];
}

/** A number with a true minus sign. */
const minus = (x: number, digits: number) => `${x < 0 ? "−" : ""}${Math.abs(x).toFixed(digits)}`;
const fmtTurns = (x: number) => minus(x, 1);
const fmtSeconds = (x: number) => `${minus(x, 0)} s`;

function meanLine(label: string, change: MeanChange | null, format: (x: number) => string, labelWidth: number): Line {
  if (change === null) return [span(label.padEnd(labelWidth), "dim"), span("—", "dim")];
  const clear = change.low > 0 || change.high < 0;
  const delta = (x: number) => `${x > 0 ? "+" : ""}${format(x)}`;
  return [
    span(label.padEnd(labelWidth), "dim"),
    span(`${format(change.without)} → ${format(change.with)}`),
    span(`   ${delta(change.estimate)}`, clear ? "bold" : undefined),
    span(`  (95% CI ${delta(change.low)} to ${delta(change.high)})`, "dim"),
  ];
}

function header(view: EvalView, width: number): Line[] {
  const p = view.record.proposal;
  const reps = view.record.plan.reps;
  const tasks = view.record.suite.tasks.length;
  const model =
    view.runs.find((r) => r.agent.model !== null)?.agent.model ?? view.record.agent.model ?? "the CLI's default model";
  const lines: Line[] = [
    truncate(
      [
        span("dreaming eval", "heading"),
        span(`  ${clean(p.file)}`, "bold"),
        span(
          `  ${p.action} · proposal ${p.id.split("-").at(-1) ?? ""}${width >= 90 ? ` of dream ${p.runId}` : ""}`,
          "dim",
        ),
      ],
      width,
    ),
    ...wrap(
      [
        span(
          `${view.record.suite.name}: ${tasks} task${tasks === 1 ? "" : "s"} × ${reps} run${reps === 1 ? "" : "s"} × 2 arms`,
          "dim",
        ),
        span(` · ${clean(model)} · ${view.record.plan.parallel} at a time`, "dim"),
      ],
      width,
    ),
  ];
  const control = view.control;
  if (view.stopping?.ended === "isolation") {
    lines.push(
      ...wrap([span("✗ ", "bad"), span("not isolated: ", "bad"), span(clean(view.stopping.because), "bad")], width, [
        span("  "),
      ]),
    );
  } else if (control === null) {
    lines.push([span("● ", "accent"), span("checking the hook detector (a free control run, no model call)", "dim")]);
  } else if (control.ok) {
    lines.push(
      ...wrap(
        [
          span("✓ ", "ok"),
          span("isolated: "),
          span(
            `safe mode, no user settings, hooks off; the detector is proved (canary fired on ${control.canaries.join(", ")})`,
            "dim",
          ),
        ],
        width,
        [span("  ")],
      ),
    );
  } else {
    lines.push(
      ...wrap([span("✗ ", "bad"), span(`hook detector not proved: ${control.detail}`, "bad")], width, [span("  ")]),
    );
  }
  return lines;
}

/** The whole screen for the current state. */
export function renderEval(view: EvalView, width: number): Line[] {
  const summary = summarise(
    view.runs,
    view.record.suite.tasks.map((t) => t.id),
    view.record.plan.seed,
  );
  const lines: Line[] = [...header(view, width), []];
  const taskWidth = Math.max(9, ...view.record.suite.tasks.map((t) => t.id.length)) + 2;
  const labels = { without: "without the memory", with: "with the memory" };
  const reps = view.record.plan.reps;
  // Wide only if both arms' columns (labels included) and the change column fit beside the task names.
  const wide = width >= taskWidth + 2 * (Math.max(reps * 2 + 7, labels.without.length) + 2) + 10;
  const gap = wide ? " " : "";
  const armWidth = Math.max(reps * (gap.length + 1) + 7, labels.without.length);

  if (wide) {
    lines.push([
      span(" ".repeat(taskWidth)),
      span(labels.without.padEnd(armWidth + 2), "dim"),
      span(labels.with.padEnd(armWidth + 2), "dim"),
      span("change", "dim"),
    ]);
  }
  for (const task of summary.tasks) {
    const name = span(clean(task.task).padEnd(taskWidth));
    const pad = armWidth - view.record.plan.reps * (gap.length + 1) + gap.length;
    const without = [...cells(view, task.task, "without", gap), span(`  ${count(task.without)}`.padEnd(pad), "dim")];
    const withIt = [...cells(view, task.task, "with", gap), span(`  ${count(task.with)}`.padEnd(pad), "dim")];
    const change: Line =
      task.change === null
        ? []
        : [
            span(
              // The mark says what the colour says, so NO_COLOR loses nothing.
              `${pts(task.change.estimate)} pts${!task.significant ? "" : task.change.estimate > 0 ? " ▲" : " ▼"}`,
              !task.significant ? "dim" : task.change.estimate > 0 ? "ok" : "bad",
            ),
          ];
    if (wide) {
      lines.push([name, ...without, span("  "), ...withIt, span("  "), ...change]);
    } else {
      lines.push([name, ...change]);
      lines.push([span("  without "), ...without, span("with "), ...withIt]);
    }
  }
  lines.push([]);

  const labelWidth = 12;
  const { without, with: withIt, change } = summary.overall;
  const rateText = (r: Rate) =>
    r.n === 0 ? "—" : `${pct(r.passes / r.n)} [${pct(r.interval.low)}–${pct(r.interval.high)}]`;
  if (wide) {
    lines.push([
      span("pass rate".padEnd(labelWidth), "dim"),
      span(rateText(without).padEnd(armWidth + taskWidth - labelWidth + 2)),
      span(rateText(withIt)),
    ]);
  } else {
    lines.push([span("pass rate".padEnd(labelWidth), "dim"), span("without ", "dim"), span(rateText(without))]);
    lines.push([span(" ".repeat(labelWidth)), span("with    ", "dim"), span(rateText(withIt))]);
  }
  const barWidth = Math.max(21, Math.min(61, width - labelWidth - 2));
  if (change === null) {
    lines.push([span("change".padEnd(labelWidth), "dim"), span("waiting for both arms", "dim")]);
  } else {
    const style: Style = change.low > 0 ? "ok" : change.high < 0 ? "bad" : "bold";
    lines.push([
      span("change".padEnd(labelWidth), "dim"),
      span(`${pts(change.estimate)} pts`, style),
      span(`   95% CI ${pts(change.low)} to ${pts(change.high)}`, "dim"),
    ]);
  }
  lines.push([span(" ".repeat(labelWidth)), ...intervalBar(change, barWidth)]);
  lines.push(axisLabels(barWidth, labelWidth));
  const indent = [span(" ".repeat(labelWidth))];
  lines.push(...wrap(meanLine("turns", summary.turns, fmtTurns, labelWidth), width, indent));
  lines.push(...wrap(meanLine("tokens", summary.usage, compact, labelWidth), width, indent));
  lines.push(...wrap(meanLine("time", summary.seconds, fmtSeconds, labelWidth), width, indent));
  lines.push([]);
  lines.push(...status(view, summary, width));
  return lines;
}

function status(view: EvalView, summary: EvalSummary, width: number): Line[] {
  const total = view.planned.length || view.record.plan.runs;
  const finished = view.runs.length;
  const parts = [
    `${finished} of ${total} runs`,
    ...(view.running.size > 0 ? [`${view.running.size} running`] : []),
    clock(view.elapsedMs),
    `${compact(summary.totalUsage)} tokens`,
    `$${summary.costUsd.toFixed(2)} at API prices`,
  ];
  const lead: Line = view.replay
    ? [
        span("▶ ", "accent"),
        span(
          `replay at ${view.replay.speed}× of eval ${view.record.evalId}, recorded ${view.record.createdAt.slice(0, 16).replace("T", " ")} UTC`,
          "dim",
        ),
      ]
    : [];
  const line: Line = view.done
    ? [span("■ ", "dim"), span(parts.join(" · "), "dim")]
    : [
        span("● ", "accent"),
        span(parts.join(" · ")),
        span(view.replay ? "" : "   Ctrl-C stops; finished runs are kept", "dim"),
      ];
  const out = [...(lead.length > 0 ? wrap(lead, width, [span("  ")]) : []), ...wrap(line, width, [span("  ")])];
  if (view.stopping !== null && view.stopping.ended !== "isolation") {
    out.push(...wrap([span("! ", "warn"), span(clean(view.stopping.because), "warn")], width, [span("  ")]));
  }
  if (summary.errors > 0) {
    const first = view.runs.find((r) => r.outcome === "error");
    out.push(
      ...wrap(
        [
          span("! ", "warn"),
          span(
            `${summary.errors} run${summary.errors === 1 ? " could not run and is" : "s could not run and are"} not counted: ${clean(first?.reason ?? "")}`,
            "warn",
          ),
        ],
        width,
        [span("  ")],
      ),
    );
  }
  return out;
}

/** The verdict, in words, with the evidence behind it. */
export function renderVerdict(view: EvalView, width: number): Line[] {
  const summary = summarise(
    view.runs,
    view.record.suite.tasks.map((t) => t.id),
    view.record.plan.seed,
  );
  const task = (id: string) => summary.tasks.find((t) => t.task === id);
  const passMeans = (id: string) => view.record.suite.tasks.find((t) => t.id === id)?.passMeans ?? "";
  const reasonFor = (id: string, arm: EvalRun["arm"], outcome: EvalRun["outcome"]) =>
    view.runs.find((r) => r.task === id && r.arm === arm && r.outcome === outcome)?.reason;
  const describe = (id: string): Line => {
    const t = task(id);
    if (t === undefined || t.change === null) return [];
    return [
      span(`${id} `, "bold"),
      span(`${count(t.without)} → ${count(t.with)}`),
      span(
        `  ${pts(t.change.estimate)} pts, ${level} CI ${pts(t.change.low)} to ${pts(t.change.high)}, exact p = ${t.p === null ? "—" : t.p.toFixed(t.p < 0.001 ? 4 : 3)}`,
        "dim",
      ),
    ];
  };
  const v = summary.verdict;
  const level = `${(summary.taskConfidence * 100).toFixed(1).replace(/\.0$/, "")}%`;
  const lines: Line[] = [];
  const say = (mark: string, style: Style, text: string) =>
    lines.push(...wrap([span(mark, style), span(text, style === "dim" ? undefined : "bold")], width, [span("  ")]));
  const detail = (line: Line) => lines.push(...wrap([span("  "), ...line], width, [span("    ")]));
  if (v.kind === "helps" || v.kind === "mixed") {
    say("✓ ", "ok", v.kind === "helps" ? "Helps. No task got worse." : "Helps on some tasks, and makes another worse.");
    for (const id of v.better) {
      detail(describe(id));
      const why = reasonFor(id, "without", "fail");
      if (why !== undefined) detail([span(`without it: ${clean(why)}`, "dim")]);
    }
  }
  if (v.kind === "hurts" || v.kind === "mixed") {
    say("✗ ", "bad", "Makes things worse. Flagged in dreaming review.");
    for (const id of v.worse) {
      detail(describe(id));
      const why = reasonFor(id, "with", "fail");
      if (why !== undefined) detail([span(`with it: ${clean(why)}`, "bad")]);
      detail([span(`pass means: ${clean(passMeans(id))}`, "dim")]);
    }
  }
  const overall = summary.overall.change;
  // With one task the overall change is that task's, already said above.
  if (
    (v.kind === "helps" || v.kind === "hurts" || v.kind === "mixed") &&
    overall !== null &&
    summary.tasks.length > 1
  ) {
    const crosses = overall.low <= 0 && overall.high >= 0;
    const moved = [...("better" in v ? v.better : []), ...("worse" in v ? v.worse : [])];
    detail([
      span(
        `Across all ${summary.tasks.length} tasks: ${pts(overall.estimate)} pts, 95% CI ${pts(overall.low)} to ${pts(overall.high)}${crosses ? `; only ${moved.join(" and ")} moved beyond chance` : ""}.`,
        "dim",
      ),
    ]);
  }
  if (v.kind === "no-effect") {
    const c = summary.overall.change;
    say("· ", "dim", "No measurable effect at this sample size.");
    if (c !== null) {
      detail([
        span(
          `Overall ${pts(c.estimate)} pts, 95% CI ${pts(c.low)} to ${pts(c.high)}: with ${summary.overall.with.n} runs per arm, any change in that range is still possible, and no task moved beyond chance.`,
          "dim",
        ),
      ]);
    }
  }
  if (v.kind === "too-few") say("· ", "dim", "Too few runs to say anything yet.");
  const costs = [
    summary.turns !== null && summary.turns.low > 0 ? "more turns" : null,
    summary.usage !== null && summary.usage.low > 0 ? "more tokens" : null,
  ].filter((x) => x !== null);
  const saves = [
    summary.turns !== null && summary.turns.high < 0
      ? `${Math.abs(summary.turns.estimate).toFixed(1)} fewer turns`
      : null,
    summary.usage !== null && summary.usage.high < 0
      ? `${compact(Math.abs(summary.usage.estimate))} fewer tokens`
      : null,
  ].filter((x) => x !== null);
  if (summary.tasks.length > 1 && v.kind !== "too-few") {
    detail([
      span(
        `A task counts only when Fisher's exact test is below 0.05/${summary.tasks.length} and its ${level} interval clears zero, so that across the ${summary.tasks.length} tasks a chance result is flagged at most 5% of the time.`,
        "dim",
      ),
    ]);
  }
  if (saves.length > 0) detail([span(`Per run: ${saves.join(", ")} (intervals exclude zero).`, "dim")]);
  if (costs.length > 0) detail([span(`Per run it costs ${costs.join(" and ")} (intervals exclude zero).`, "warn")]);
  return lines;
}

/** A one-line result for lists and the review. */
export function evalSummaryLine(summary: EvalSummary): { text: string; style: Style } {
  const c = summary.overall.change;
  const v = summary.verdict;
  // The tasks that decided it come first; the pooled change is context.
  const moved = (ids: readonly string[]) =>
    ids
      .map((id) => summary.tasks.find((t) => t.task === id))
      .filter((t) => t !== undefined)
      .map((t) => `${t.task} ${count(t.without)} → ${count(t.with)}, p = ${(t.p ?? 1).toFixed(3)}`)
      .join("; ");
  const overall = c === null ? "" : ` · overall ${pts(c.estimate)} pts (95% CI ${pts(c.low)} to ${pts(c.high)})`;
  if (v.kind === "hurts" || v.kind === "mixed") return { text: `▼ worse: ${moved(v.worse)}${overall}`, style: "bad" };
  if (v.kind === "helps") return { text: `▲ helps: ${moved(v.better)}${overall}`, style: "ok" };
  if (v.kind === "no-effect") return { text: `no measurable effect${overall}`, style: "dim" };
  return { text: "too few runs to say", style: "dim" };
}
