import { DreamingError } from "../errors.js";
import { rule, toAnsi, wrap, span, type Line } from "../ui/text.js";
import { parseEditedMemory } from "./edit.js";
import type { ReviewModel, Submission } from "./model.js";
import { renderProposal, renderSubmit } from "./render.js";
import type { PlainIO } from "./terminal.js";

/**
 * The line-by-line review: one proposal after another, an answer per line.
 * Used when input or output is not a terminal (pipes, scripts, CI logs) and
 * with --plain, which also suits screen readers. Same model and renderers as
 * the full-screen review.
 */

/** The submission is the one that was shown; it is applied exactly as shown, or not at all. */
export type FrontEndResult = { kind: "submit"; submission: Submission } | { kind: "abandoned"; reason: string };

const CHOICES = "a approve · r reject · e edit · s skip · q stop here > ";

function print(io: PlainIO, lines: readonly Line[]): void {
  io.write(lines.map((line) => `${toAnsi(line, io.color)}\n`).join(""));
}

async function editItem(model: ReviewModel, index: number, io: PlainIO): Promise<void> {
  const item = model.item(index);
  if (item.proposal.action === "delete") {
    io.write("A delete has nothing to edit. Approve, reject or skip it.\n");
    return;
  }
  let text: string;
  try {
    text = await io.edit(await model.editableText(index), model.fileName(index));
  } catch (error) {
    if (!(error instanceof DreamingError)) throw error;
    io.write(`${error.message}\n`);
    return;
  }
  const parsed = parseEditedMemory(text, item.proposal);
  if (!parsed.ok) {
    item.draft = text;
    io.write(`The edited file is not valid; press e to fix it:\n${parsed.errors.map((e) => `  - ${e}\n`).join("")}`);
    return;
  }
  model.setEdit(index, parsed.edit);
}

export async function plainReview(
  model: ReviewModel,
  io: PlainIO,
  options: { dryRun: boolean },
): Promise<FrontEndResult> {
  const width = Math.max(40, Math.min(io.width, 110));
  const total = model.items.length;

  items: for (let index = 0; index < total; index += 1) {
    let show = true;
    for (;;) {
      if (show) {
        print(io, [
          rule(width),
          ...renderProposal(model.item(index), index, total, await model.assess(index), width),
          [],
        ]);
        show = false;
      }
      const answer = await io.ask(CHOICES);
      if (answer === null) return { kind: "abandoned", reason: "input ended" };
      const choice = answer.trim().toLowerCase();
      if (choice === "a") {
        const result = await model.approve(index);
        if (result.ok) continue items;
        print(io, wrap([span("Can't approve: ", "bad"), span(result.reason, "bad")], width));
      } else if (choice === "r" || choice === "s") {
        model.decide(index, choice === "r" ? "rejected" : "skipped");
        continue items;
      } else if (choice === "e") {
        await editItem(model, index, io);
        show = model.item(index).edit !== undefined;
      } else if (choice === "q") {
        break items;
      } else {
        io.write("Please answer a, r, e, s or q.\n");
      }
    }
  }

  const submission = await model.submission();
  print(io, [rule(width), ...renderSubmit(model, submission, width, options.dryRun), []]);
  if (submission.conflicts.length > 0) return { kind: "abandoned", reason: "conflict" };
  if (submission.approved.length + submission.rejected.length === 0) {
    return { kind: "abandoned", reason: "nothing decided" };
  }
  if (options.dryRun) return { kind: "submit", submission };
  const parts = [];
  if (submission.approved.length > 0) parts.push(`apply ${submission.approved.length} approved`);
  if (submission.rejected.length > 0) parts.push(`record ${submission.rejected.length} rejected`);
  const answer = await io.ask(`Submit: ${parts.join(" and ")}? [y/N] `);
  if (answer === null) return { kind: "abandoned", reason: "input ended" };
  return ["y", "yes"].includes(answer.trim().toLowerCase())
    ? { kind: "submit", submission }
    : { kind: "abandoned", reason: "declined" };
}
