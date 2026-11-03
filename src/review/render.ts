import type { FileChange } from "../apply/plan.js";
import { evalSummaryLine } from "../commands/eval-view.js";
import type { StoredEvidence } from "../inbox/schema.js";
import { quoteDiffersFromSource } from "../proposals/verify.js";
import { stripControl } from "../text.js";
import { homedir } from "node:os";
import {
  lineWidth,
  rule,
  span,
  spread,
  textWidth,
  tildify,
  truncate,
  wrap,
  type Line,
  type Style,
} from "../ui/text.js";
import { fileDiff, type DiffRow } from "./diff-view.js";
import type { Assessment, Decision, ReviewItem, ReviewModel, Submission } from "./model.js";

/**
 * Pure renderers for the review: model in, width-limited styled lines out.
 * Every string the agent wrote passes through stripControl before display.
 */

const clean = stripControl;

export const DECISION_MARK: Record<Decision, { mark: string; style: Style | undefined; label: string }> = {
  pending: { mark: "○", style: "dim", label: "undecided" },
  approved: { mark: "✓", style: "ok", label: "approved" },
  rejected: { mark: "✗", style: "bad", label: "rejected" },
  skipped: { mark: "–", style: "dim", label: "skipped" },
};

const ACTION_STYLE = { add: "added", update: "accent", delete: "removed" } as const;

function stats(added: number, removed: number): Line {
  const parts: Line = [];
  if (added > 0) parts.push(span(`+${added}`, "added"));
  if (added > 0 && removed > 0) parts.push(span(" "));
  if (removed > 0) parts.push(span(`−${removed}`, "removed"));
  return parts.length > 0 ? parts : [span("no change", "dim")];
}

function evidenceSummary(evidence: readonly StoredEvidence[]): Line {
  const verified = evidence.filter((e) => e.status === "verified").length;
  const ok = verified === evidence.length;
  return [span(`${verified}/${evidence.length} `, ok ? undefined : "bad"), span(ok ? "✓" : "✗", ok ? "ok" : "bad")];
}

// --- the proposal list ------------------------------------------------------

export function renderList(
  model: ReviewModel,
  assessments: ReadonlyMap<number, Assessment>,
  current: number,
  width: number,
  maxRows: number,
): Line[] {
  const total = model.items.length;
  const rows = Math.min(total, maxRows);
  // Keep the current proposal visible in a list longer than the space for it.
  const first = Math.min(Math.max(0, current - Math.floor(rows / 2)), Math.max(0, total - rows));
  const wide = width >= 90;
  // The file column is as wide as the longest name needs (within limits), so the
  // columns after it, evidence and line counts, sit close enough to read across.
  const longest = Math.max(...model.items.map((_, i) => textWidth(clean(model.fileName(i)))));
  const fileWidth = Math.max(12, Math.min(longest + 2, width - (wide ? 44 : 26)));
  const lines: Line[] = [];
  for (let i = first; i < first + rows; i += 1) {
    const item = model.item(i);
    const { proposal } = item;
    const mark = DECISION_MARK[item.decision];
    const assessment = assessments.get(i);
    const left: Line = [
      span(i === current ? "›" : " ", "key"),
      span(" "),
      span(mark.mark, mark.style),
      span(" "),
      span(proposal.action.padEnd(7), ACTION_STYLE[proposal.action]),
      ...truncate([span(clean(model.fileName(i)), i === current ? "bold" : undefined)], fileWidth),
    ];
    const pad = fileWidth - lineWidth(truncate([span(clean(model.fileName(i)))], fileWidth));
    left.push(span(" ".repeat(Math.max(1, pad + 1))));
    if (wide) {
      left.push(span(("type" in proposal ? proposal.type : "").padEnd(11), "dim"));
      left.push(span(proposal.confidence.padEnd(8), "dim"));
    }
    left.push(...evidenceSummary(proposal.evidence), span("   "));
    left.push(...(assessment ? stats(assessment.added, assessment.removed) : [span("…", "dim")]));
    left.push(...insightMarks(item));
    lines.push(truncate(left, width));
  }
  if (total > rows) {
    lines.push([
      span(
        `  ${first > 0 ? `↑ ${first} more  ` : ""}${total - first - rows > 0 ? `↓ ${total - first - rows} more` : ""}`,
        "dim",
      ),
    ]);
  }
  return lines;
}

/** ≠ when the check found a contradiction; ▲ or ▼ when an eval measured the memory helping or hurting. */
function insightMarks(item: ReviewItem): Line {
  const marks: Line = [];
  const c = item.insight.contradictions;
  if (c.state === "checked" && c.check.contradictions.length > 0) marks.push(span("  ≠", "bad"));
  const verdict = item.insight.measured?.summary.verdict.kind;
  if (verdict === "hurts" || verdict === "mixed") marks.push(span("  ▼", "bad"));
  else if (verdict === "helps") marks.push(span("  ▲", "ok"));
  return marks;
}

// --- one proposal -----------------------------------------------------------

/**
 * The proposal's title. The file name is never cut; if the details do not fit
 * beside it they move to a second line.
 */
function title(item: ReviewItem, index: number, total: number, width: number): Line[] {
  const { proposal } = item;
  const mark = DECISION_MARK[item.decision];
  const left: Line = [
    span(proposal.action.toUpperCase(), ACTION_STYLE[proposal.action]),
    span("  "),
    span(clean(item.edit?.file ?? proposal.file), "heading"),
    ...(item.edit ? [span("  edited", "warn")] : []),
  ];
  const details = [
    "type" in proposal ? proposal.type : "",
    `${proposal.confidence} confidence`,
    `${index + 1} of ${total}`,
  ]
    .filter((part) => part !== "")
    .join(" · ");
  const decision: Line =
    item.decision === "pending" ? [] : [span("  "), span(`${mark.mark} ${mark.label}`, mark.style)];
  const right: Line = [span(details, "dim"), ...decision];
  if (lineWidth(left) + lineWidth(right) + 2 <= width) return [spread(left, right, width)];
  return [[...left, ...decision], ...wrap([span(details, "dim")], width)];
}

function labelled(label: string, text: string, width: number, style?: Style): Line[] {
  const pad = label.padEnd(10);
  return wrap([span(pad, "heading"), span(clean(text), style)], width, [span(" ".repeat(10))]);
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

export function renderEvidence(item: ReviewItem, width: number): Line[] {
  const { evidence } = item.proposal;
  const verified = evidence.filter((e) => e.status === "verified").length;
  const lines: Line[] = [
    [
      span("Evidence".padEnd(10), "heading"),
      span(
        `${verified} of ${evidence.length} verified against the transcript`,
        verified === evidence.length ? "dim" : "bad",
      ),
    ],
  ];
  for (const e of evidence) {
    const session = item.run.sessions.find((s) => s.ref === e.session);
    const ok = e.status === "verified";
    const bar = span("  ┃ ", ok ? "ok" : "bad");
    const where = session
      ? [clean(session.cwd ?? session.project), `session ${session.sessionId.slice(0, 8)}`]
      : ["no such session in this dream"];
    if (e.line !== undefined) where.push(`line ${e.line}`);
    const status = ok ? "✓ verified" : e.status === "not-found" ? "✗ not found in the session" : "✗ unknown session";
    // The verdict first, so it is seen even when the location wraps.
    lines.push(
      ...wrap([bar, span(status, ok ? "ok" : "bad"), span(` · ${e.session} · ${where.join(" · ")}`, "dim")], width, [
        bar,
      ]),
    );
    // Show what the transcript says; the agent's own rendering only if it differs.
    const shown = e.source ?? e.quote;
    lines.push(...wrap([bar, span(clean(shown))], width, [bar]));
    if (e.source !== undefined && quoteDiffersFromSource(e.quote, e.source)) {
      lines.push(...wrap([bar, span(`quoted with omissions as: "${clean(e.quote)}"`, "warn")], width, [bar]));
    }
  }
  return lines;
}

function diffRow(row: DiffRow, width: number): Line[] {
  if (row.kind === "gap") return [[span("     ⋯", "dim")]];
  const number = span(row.number === undefined ? "    " : String(row.number).padStart(4), "dim");
  const marker = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
  const base: Style | undefined = row.kind === "add" ? "added" : row.kind === "del" ? "removed" : undefined;
  const word: Style | undefined = row.kind === "add" ? "addedWord" : row.kind === "del" ? "removedWord" : undefined;
  const text = row.segments.map((s) => span(clean(s.text), s.changed ? word : base));
  return wrap([number, span(` ${marker} `, base), ...text], width, [span("       ", base)]);
}

export function renderDiff(files: readonly FileChange[], width: number): Line[] {
  const lines: Line[] = [];
  for (const [i, change] of files.entries()) {
    const diff = fileDiff(change);
    if (i > 0) lines.push([]);
    const status = diff.status === "new" ? "new file" : diff.status === "deleted" ? "deleted" : "modified";
    lines.push([span(clean(diff.file), "bold"), span(`  ${status}  `, "dim"), ...stats(diff.added, diff.removed)]);
    for (const row of diff.rows) lines.push(...diffRow(row, width));
  }
  return lines;
}

/** The detail pane for one proposal. */
export function renderProposal(
  item: ReviewItem,
  index: number,
  total: number,
  assessment: Assessment,
  width: number,
): Line[] {
  const lines: Line[] = [...title(item, index, total, width)];
  for (const blocker of assessment.blockers) {
    lines.push(...wrap([span("✗ Can't approve: ", "bad"), span(clean(blocker), "bad")], width, [span("  ")]));
  }
  for (const note of assessment.notes)
    lines.push(...wrap([span("! ", "warn"), span(clean(note), "warn")], width, [span("  ")]));
  lines.push([], ...labelled("Why", item.proposal.reason, width), [], ...renderEvidence(item, width), []);
  lines.push(...renderMeasured(item, width), []);
  const conflicts = renderConflicts(item, width);
  lines.push(...conflicts, ...(conflicts.length > 0 ? [[]] : []));
  if (item.proposal.action !== "delete") {
    const description = item.edit?.description ?? item.proposal.description;
    lines.push(...labelled("Memory", description, width), []);
  }
  if (assessment.files.length > 0) lines.push(...renderDiff(assessment.files, width));
  else if (assessment.blockers.length === 0)
    lines.push([span("No file changes: memory already matches this proposal.", "dim")]);
  return lines;
}

// --- help and submit --------------------------------------------------------

const KEYS: [string, string][] = [
  ["a", "approve"],
  ["r", "reject"],
  ["s", "skip (leave it in the inbox)"],
  ["u", "undo the decision"],
  ["e", "edit the memory in $EDITOR"],
  ["→ n", "next proposal"],
  ["← p", "previous proposal"],
  ["↓ j  ↑ k", "scroll"],
  ["space  b", "page down, page up"],
  ["enter", "submit the review"],
  ["?", "this help"],
  ["q", "quit"],
];

export function renderHelp(width: number): Line[] {
  const lines: Line[] = [[span("Keys", "heading")]];
  for (const [key, label] of KEYS) lines.push([span(`  ${key.padEnd(10)}`, "key"), span(label)]);
  lines.push(
    [],
    [span("Evidence", "heading")],
    ...wrap(
      [span("  ✓ verified ", "ok"), span("the quote is in the message it cites; the transcript line is shown.")],
      width,
      [span("    ")],
    ),
    ...wrap(
      [span("  ✗ not found ", "bad"), span("no message in that session contains it; approval is blocked.")],
      width,
      [span("    ")],
    ),
    [],
    ...wrap([span("Nothing is written until you submit and confirm the combined diff.", "dim")], width),
  );
  return lines;
}

export function renderSubmit(model: ReviewModel, submission: Submission, width: number, dryRun: boolean): Line[] {
  const lines: Line[] = [
    [span(dryRun ? "Submit review (dry run: nothing will be written)" : "Submit review", "heading")],
    [],
  ];
  model.items.forEach((item, i) => {
    const mark = DECISION_MARK[item.decision];
    const verb = { pending: "undecided", approved: "approve", rejected: "reject", skipped: "skip" }[item.decision];
    lines.push(
      truncate(
        [
          span(`  ${mark.mark} `, mark.style),
          span(verb.padEnd(10), mark.style),
          span(item.proposal.action.padEnd(7), ACTION_STYLE[item.proposal.action]),
          span(clean(model.fileName(i))),
          ...(item.decision === "pending" || item.decision === "skipped" ? [span("  stays in the inbox", "dim")] : []),
        ],
        width,
      ),
    );
  });
  lines.push([]);
  if (submission.conflicts.length > 0) {
    lines.push([span("These approvals cannot be applied together:", "bad")]);
    for (const c of submission.conflicts)
      lines.push(...wrap([span(`  ✗ ${clean(c.message)}`, "bad")], width, [span("    ")]));
  } else if (submission.plan === null || submission.plan.files.length === 0) {
    lines.push([
      span(submission.approved.length > 0 ? "No file changes: memory already matches." : "Nothing to apply.", "dim"),
    ]);
  } else {
    lines.push(
      [span(`Changes to ${clean(tildify(submission.plan.memoryDir, homedir()))}`, "heading")],
      [],
      ...renderDiff(submission.plan.files, width),
    );
  }
  return lines;
}

// --- chrome -----------------------------------------------------------------

export type KeyBarMode = "proposal" | "submit" | "help" | "quit";

export function keyBar(mode: KeyBarMode, width: number, context: { decisions: number; dryRun: boolean }): Line {
  const key = (k: string, label: string): Line => [span(k, "key"), span(` ${label}  `)];
  const sets: Record<KeyBarMode, Line[][]> = {
    proposal: [
      [
        key("a", "approve"),
        key("r", "reject"),
        key("e", "edit"),
        key("s", "skip"),
        key("←→", "proposals"),
        key("↑↓", "scroll"),
        key("enter", "submit"),
        key("?", "help"),
        key("q", "quit"),
      ],
      [
        key("a", "approve"),
        key("r", "reject"),
        key("e", "edit"),
        key("s", "skip"),
        key("←→", "move"),
        key("enter", "submit"),
        key("?", "help"),
      ],
      [key("a", "approve"), key("r", "reject"), key("e", "edit"), key("s", "skip"), key("?", "help")],
      [key("a", "approve"), key("r", "reject"), key("?", "help")],
    ],
    submit: [
      [
        key("y", context.dryRun ? "finish (dry run)" : "apply and record"),
        key("n", "back"),
        key("↑↓", "scroll"),
        key("q", "quit"),
      ],
      [key("y", context.dryRun ? "finish" : "apply"), key("n", "back"), key("q", "quit")],
    ],
    help: [[key("?", "close help"), key("q", "quit")]],
    quit: [
      [
        [span(`Quit and discard ${context.decisions} decision${context.decisions === 1 ? "" : "s"}? `, "warn")],
        key("y", "quit"),
        key("n", "stay"),
      ],
    ],
  };
  const options = sets[mode];
  for (const option of options) {
    const line = option.flat();
    if (lineWidth(line) <= width) return line;
  }
  return truncate((options.at(-1) ?? []).flat(), width);
}

export function header(model: ReviewModel, width: number): Line {
  const total = model.items.length;
  const dreams = model.runs;
  const left: Line = [
    span("dreaming review", "heading"),
    span(`  ${total} proposal${total === 1 ? "" : "s"} from ${dreams} dream${dreams === 1 ? "" : "s"}`, "dim"),
  ];
  const counts: Line = [
    span(`${model.count("approved")} ✓`, "ok"),
    span("  "),
    span(`${model.count("rejected")} ✗`, "bad"),
    span("  "),
    span(`${model.count("pending")} to go`, "dim"),
  ];
  // When space is short, the summary phrase goes whole rather than being cut.
  if (lineWidth(left) + lineWidth(counts) + 2 > width)
    return spread([span("dreaming review", "heading")], counts, width);
  return spread(left, counts, width);
}

export { rule };
