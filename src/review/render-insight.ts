import { evalSummaryLine } from "../commands/eval-view.js";
import { stripControl } from "../text.js";
import { span, wrap, type Line } from "../ui/text.js";
import type { ReviewItem } from "./model.js";

/**
 * What the review shows beside each proposal from the two checks: what
 * `dreaming eval` measured, and what the contradiction check found.
 */

const clean = stripControl;

/** ≠ when the check found a contradiction; ▲ or ▼ when an eval measured the memory helping or hurting. */
export function insightMarks(item: ReviewItem): Line {
  const marks: Line = [];
  const c = item.insight.contradictions;
  if (c.state === "checked" && c.check.contradictions.length > 0) marks.push(span("  ≠", "bad"));
  const verdict = item.insight.measured?.summary.verdict.kind;
  if (verdict === "hurts" || verdict === "mixed") marks.push(span("  ▼", "bad"));
  else if (verdict === "helps") marks.push(span("  ▲", "ok"));
  return marks;
}

/** What `dreaming eval` measured for this proposal, or how to measure it. */
export function renderMeasured(item: ReviewItem, width: number): Line[] {
  const measured = item.insight.measured;
  const label = span("Measured".padEnd(10), "heading");
  const indent = [span(" ".repeat(10))];
  if (measured === null) {
    return wrap(
      [
        label,
        span(`not yet · dreaming eval ${clean(item.proposal.file)} runs a task suite with and without it`, "dim"),
      ],
      width,
      indent,
    );
  }
  const { record, summary } = measured;
  const v = summary.verdict;
  const line = evalSummaryLine(summary);
  const lines = wrap(
    [
      label,
      span(line.text, line.style),
      span(` · ${record.runs.length} real runs on ${record.suite.name}, ${record.createdAt.slice(0, 10)}`, "dim"),
    ],
    width,
    indent,
  );
  const perTask = summary.tasks.map(
    (t) => `${t.task} ${t.without.passes}/${t.without.n} → ${t.with.passes}/${t.with.n}`,
  );
  lines.push(...wrap([...indent, span(perTask.join(" · "), "dim")], width, indent));
  const worse = v.kind === "hurts" || v.kind === "mixed" ? v.worse[0] : undefined;
  const why =
    worse === undefined
      ? undefined
      : record.runs.find((r) => r.task === worse && r.arm === "with" && r.outcome === "fail");
  if (why !== undefined) lines.push(...wrap([...indent, span(`with it: ${clean(why.reason)}`, "bad")], width, indent));
  lines.push(
    ...wrap(
      [...indent, span(`dreaming eval --replay ${record.evalId}`, "key"), span("  to watch it", "dim")],
      width,
      indent,
    ),
  );
  return lines;
}

/** What the contradiction check found between this proposal and the rest of the memory set. */
export function renderConflicts(item: ReviewItem, width: number): Line[] {
  const c = item.insight.contradictions;
  const label = span("Conflicts".padEnd(10), "heading");
  const indent = [span(" ".repeat(10))];
  if (item.proposal.action === "delete") return [];
  if (c.state === "unchecked") {
    return wrap(
      [label, span("not checked · dreaming check compares it with every memory, on this machine", "dim")],
      width,
      indent,
    );
  }
  const stale = c.stale ? [span(" · memory changed since; run dreaming check again", "warn")] : [];
  const found = c.check.contradictions;
  if (found.length === 0) {
    const said =
      c.check.pairs === 0
        ? "nothing to compare: no other memory shares two content words with it"
        : `none found in ${c.check.pairs} sentence pairs (local NLI model)`;
    return wrap([label, span(said, "dim"), ...stale], width, indent);
  }
  const files = [...new Set(found.map((x) => (x.b.source === "proposal" ? `${x.b.file} (proposed)` : x.b.file)))];
  const lines = wrap(
    [
      label,
      span(`≠ contradicts ${files.map(clean).join(", ")}`, "bad"),
      span(" · inferred by a local NLI model; read both", "dim"),
      ...stale,
    ],
    width,
    indent,
  );
  // Grouped by the file contradicted: its name once, then its two strongest pairs.
  for (const file of [...new Set(found.map((x) => x.b.file))].slice(0, 3)) {
    const pairs = found.filter((x) => x.b.file === file);
    const bar = span("  ┃ ", "bad");
    lines.push(
      ...wrap(
        [
          bar,
          span(clean(file), "bold"),
          span(
            `  ${pairs.length} sentence pair${pairs.length === 1 ? "" : "s"}, up to ${(pairs[0]?.score ?? 0).toFixed(2)}`,
            "dim",
          ),
        ],
        width,
        [bar],
      ),
    );
    for (const x of pairs.slice(0, 2)) {
      lines.push(...wrap([bar, span("this  ", "dim"), span(clean(x.a.sentence))], width, [bar, span("      ")]));
      lines.push(...wrap([bar, span("that  ", "dim"), span(clean(x.b.sentence))], width, [bar, span("      ")]));
    }
  }
  return lines;
}
