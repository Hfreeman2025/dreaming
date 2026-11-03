import { join } from "node:path";
import { executePlan, type ApplyResult } from "../apply/execute.js";
import type { DreamingPaths } from "../config.js";
import { DreamingError, errorMessage } from "../errors.js";
import { makeRunId } from "../ids.js";
import { loadRuns, pendingProposals, recordDecisions, type StatusChange } from "../inbox/store.js";
import { withLock } from "../lock.js";
import { homedir } from "node:os";
import { span, tildify, toAnsi, wrap, type Line } from "../ui/text.js";
import { loadInsights } from "./insight.js";
import { ReviewModel } from "./model.js";
import { plainReview, type FrontEndResult } from "./plain.js";
import { DECISION_MARK } from "./render.js";
import { screenReview } from "./screen.js";
import type { PlainIO, ScreenIO } from "./terminal.js";

export interface ReviewContext {
  paths: DreamingPaths;
  memoryDir: string;
  now: () => Date;
  dryRun: boolean;
  allowUnverified: boolean;
}

export interface ReviewSummary {
  approved: number;
  rejected: number;
  skipped: number;
  /** What happened at the end of the review. */
  outcome: "nothing-pending" | "abandoned" | "nothing-decided" | "applied" | "dry-run" | "conflict";
  applied: ApplyResult | null;
}

/** A terminal that can run the full-screen review and print afterwards. */
export interface ScreenTerminal extends ScreenIO, PlainIO {
  startScreen(): void;
  stopScreen(): void;
}

/** The review's front end: the full screen when there is a terminal, otherwise line by line. */
export type ReviewFrontEnd = { kind: "screen"; terminal: ScreenTerminal } | { kind: "plain"; io: PlainIO };

const ABANDONED: Record<string, string> = {
  "input ended": "Input ended; nothing was written.",
  interrupted: "Review interrupted; nothing was written.",
  quit: "Quit without submitting; nothing was written.",
  declined: "Not submitted; nothing was written. The proposals are still in the inbox.",
  conflict: "Nothing was written: the approvals conflict with the memory directory as it is now.",
  "nothing decided": "Nothing decided; nothing was written.",
};

function printLines(io: PlainIO, lines: readonly Line[]): void {
  io.write(lines.map((line) => `${toAnsi(line, io.color)}\n`).join(""));
}

export async function review(ctx: ReviewContext, frontEnd: ReviewFrontEnd): Promise<ReviewSummary> {
  const out: PlainIO = frontEnd.kind === "screen" ? frontEnd.terminal : frontEnd.io;
  const pending = pendingProposals(await loadRuns(ctx.paths.inbox));
  const insights = await loadInsights(ctx.paths, ctx.memoryDir, pending);
  const model = new ReviewModel(pending, { memoryDir: ctx.memoryDir, allowUnverified: ctx.allowUnverified, insights });
  const summary = (outcome: ReviewSummary["outcome"], applied: ApplyResult | null = null): ReviewSummary => ({
    approved: model.count("approved"),
    rejected: model.count("rejected"),
    skipped: model.count("skipped"),
    outcome,
    applied,
  });
  if (pending.length === 0) {
    printLines(out, [
      [span("No proposals are waiting for review.")],
      [],
      ...wrap(
        [span("Next  ", "dim"), span("dreaming run", "key"), span("  file new proposals from recent sessions", "dim")],
        out.width,
        [span("      ")],
      ),
    ]);
    return summary("nothing-pending");
  }

  let result: FrontEndResult;
  if (frontEnd.kind === "screen") {
    frontEnd.terminal.startScreen();
    try {
      result = await screenReview(model, frontEnd.terminal, { dryRun: ctx.dryRun });
    } finally {
      frontEnd.terminal.stopScreen();
    }
  } else {
    result = await plainReview(model, frontEnd.io, { dryRun: ctx.dryRun });
  }

  if (result.kind === "abandoned") {
    out.write(`${ABANDONED[result.reason] ?? "Nothing was written."}\n`);
    if (result.reason === "conflict") return summary("conflict");
    return summary(result.reason === "nothing decided" ? "nothing-decided" : "abandoned");
  }
  if (ctx.dryRun) {
    out.write("Dry run: nothing was written.\n");
    return summary("dry-run");
  }

  // Apply exactly what was shown. If a file changed since, executePlan refuses.
  const { submission } = result;
  const now = ctx.now();
  let applied: ApplyResult | null = null;
  if (submission.plan !== null) {
    const plan = submission.plan;
    const applyId = makeRunId(now);
    applied = await withLock(ctx.paths.applyLock, "apply", () =>
      executePlan(plan, { applyId, backupDir: join(ctx.paths.backups, applyId), auditLog: ctx.paths.auditLog, now }),
    );
  }
  const at = now.toISOString();
  const changes: StatusChange[] = [
    ...submission.approved.map((item) => ({
      runId: item.run.runId,
      id: item.proposal.id,
      status: "applied" as const,
      at,
    })),
    ...submission.rejected.map((item) => ({
      runId: item.run.runId,
      id: item.proposal.id,
      status: "rejected" as const,
      at,
    })),
  ];
  try {
    await recordDecisions(ctx.paths.inbox, changes);
  } catch (error) {
    throw new DreamingError(
      `memory was updated and the audit log written, but the inbox could not be updated: ${errorMessage(error)}`,
      { hint: "Run `dreaming review` again; the proposals will show as already applied.", cause: error },
    );
  }
  printLines(out, report(model, applied, ctx));
  return summary("applied", applied);
}

/** What the review did, printed to the normal screen so it stays in the scrollback. */
function report(model: ReviewModel, applied: ApplyResult | null, ctx: ReviewContext): Line[] {
  const lines: Line[] = [];
  if (applied !== null) {
    const changed = applied.outcomes.filter((o) => o.result === "change").length;
    const inPlace = applied.outcomes.length - changed;
    lines.push([
      span(`Applied ${changed} change${changed === 1 ? "" : "s"}`, "ok"),
      span(inPlace > 0 ? ` (${inPlace} already in place)` : "", "dim"),
      span(` to ${tildify(ctx.memoryDir, homedir())}`),
    ]);
  } else {
    lines.push([span("Recorded the decisions; no memory files changed.", "dim")]);
  }
  const verbs = { add: "added", update: "updated", delete: "deleted" } as const;
  model.items.forEach((item, i) => {
    const mark = DECISION_MARK[item.decision];
    const what =
      item.decision === "approved"
        ? verbs[item.proposal.action]
        : item.decision === "rejected"
          ? "rejected"
          : "skipped";
    const note =
      item.decision === "skipped" || item.decision === "pending" ? [span("  still in the inbox", "dim")] : [];
    lines.push([span(`  ${mark.mark} `, mark.style), span(what.padEnd(10)), span(model.fileName(i)), ...note]);
  });
  if (applied !== null) {
    lines.push(
      [],
      [span("Backup     ", "dim"), span(tildify(applied.backupDir, homedir()))],
      [span("Audit log  ", "dim"), span(tildify(ctx.paths.auditLog, homedir()))],
    );
    const first = model.items.findIndex((item) => item.decision === "approved" && item.proposal.action !== "delete");
    if (first !== -1) {
      lines.push([
        span("Provenance ", "dim"),
        span(`dreaming why ${model.fileName(first).replace(/\.md$/, "")}`, "key"),
      ]);
    }
  }
  return lines;
}
