import { DreamingError } from "../errors.js";
import { fit, lineWidth, rule, span, toAnsi, wrap, type Line } from "../ui/text.js";
import { parseEditedMemory } from "./edit.js";
import type { Assessment, ReviewModel, Submission } from "./model.js";
import type { FrontEndResult } from "./plain.js";
import { header, keyBar, renderHelp, renderList, renderProposal, renderSubmit, type KeyBarMode } from "./render.js";
import type { Key, ScreenIO } from "./terminal.js";

/**
 * The full-screen review, laid out like a pull request: the list of proposed
 * memory changes on top, the selected one below (its diff, its reason and its
 * evidence), and single keys to decide. Decisions can be changed until the
 * review is submitted; the submit view shows everything that will happen
 * before anything does.
 */

export const MIN_COLUMNS = 50;
export const MIN_ROWS = 14;

type Mode = "proposal" | "help" | "submit" | "quit";

interface State {
  current: number;
  scroll: number;
  mode: Mode;
  previous: Mode;
  /** The status line, as variants from longest to shortest; the first that fits is shown. */
  message: Line[] | null;
  submission: Submission | null;
  assessments: Map<number, Assessment>;
}

function bodyLines(model: ReviewModel, state: State, width: number, dryRun: boolean): Line[] {
  const mode = state.mode === "quit" ? state.previous : state.mode;
  if (mode === "help") return renderHelp(width);
  if (mode === "submit" && state.submission) return renderSubmit(model, state.submission, width, dryRun);
  const assessment = state.assessments.get(state.current);
  return assessment
    ? renderProposal(model.item(state.current), state.current, model.items.length, assessment, width)
    : [];
}

/** The whole screen as styled lines, exactly `rows` long. */
export function frame(
  model: ReviewModel,
  state: State,
  size: { columns: number; rows: number },
  dryRun: boolean,
): Line[] {
  const { columns: width, rows } = size;
  if (width < MIN_COLUMNS || rows < MIN_ROWS) {
    const lines = wrap(
      [
        span(
          `The review needs a terminal of at least ${MIN_COLUMNS}×${MIN_ROWS}; this one is ${width}×${rows}. Make it larger, or press q and run dreaming review --plain.`,
        ),
      ],
      Math.max(10, width),
    );
    return [...lines, ...Array.from({ length: Math.max(0, rows - lines.length) }, (): Line => [])].slice(0, rows);
  }
  const listRows = Math.min(model.items.length, Math.max(3, Math.floor(rows / 4)));
  const list = renderList(model, state.assessments, state.current, width, listRows);
  const top: Line[] = [header(model, width), rule(width), ...list];
  const viewport = Math.max(1, rows - top.length - 3);
  const body = bodyLines(model, state, width, dryRun);
  const maxScroll = Math.max(0, body.length - viewport);
  state.scroll = Math.min(Math.max(0, state.scroll), maxScroll);
  const position: Line =
    body.length > viewport
      ? [
          span(
            ` ${state.scroll + 1}–${Math.min(body.length, state.scroll + viewport)} of ${body.length} ${state.scroll < maxScroll ? "↓" : "↑"}`,
            "dim",
          ),
        ]
      : [];
  const divider = [...rule(width - lineWidth(position)), ...position];
  const visible = body.slice(state.scroll, state.scroll + viewport);
  while (visible.length < viewport) visible.push([]);
  const decisions = model.count("approved") + model.count("rejected") + model.count("skipped");
  const barMode: KeyBarMode = state.mode;
  return [
    ...top,
    position.length > 0 ? divider : rule(width),
    ...visible,
    pick(state.message ?? [[]], width),
    keyBar(barMode, width, { decisions, dryRun }),
  ].map((line) => fit(line, width));
}

/** The first variant that fits the width; the last one, cut, if none does. */
function pick(variants: readonly Line[], width: number): Line {
  return variants.find((line) => lineWidth(line) <= width) ?? variants.at(-1) ?? [];
}

const SCROLL_KEYS: Record<string, (scroll: number, page: number) => number> = {
  down: (s) => s + 1,
  j: (s) => s + 1,
  up: (s) => s - 1,
  k: (s) => s - 1,
  space: (s, page) => s + page,
  pagedown: (s, page) => s + page,
  b: (s, page) => s - page,
  pageup: (s, page) => s - page,
  g: () => 0,
  home: () => 0,
  G: () => Number.MAX_SAFE_INTEGER,
  end: () => Number.MAX_SAFE_INTEGER,
};

export async function screenReview(
  model: ReviewModel,
  io: ScreenIO,
  options: { dryRun: boolean },
): Promise<FrontEndResult> {
  const state: State = {
    current: 0,
    scroll: 0,
    mode: "proposal",
    previous: "proposal",
    message: null,
    submission: null,
    assessments: new Map(),
  };
  const refresh = async () => {
    state.assessments.clear();
    for (let i = 0; i < model.items.length; i += 1) state.assessments.set(i, await model.assess(i));
  };
  const draw = () => {
    io.draw(frame(model, state, io.size(), options.dryRun).map((line) => toAnsi(line, io.color)));
  };
  const select = (index: number) => {
    state.current = (index + model.items.length) % model.items.length;
    state.scroll = 0;
  };
  const enterSubmit = async () => {
    state.submission = await model.submission();
    state.mode = "submit";
    state.scroll = 0;
  };
  const advance = async () => {
    const next = model.nextPending(state.current);
    if (next === -1) await enterSubmit();
    else select(next);
  };

  await refresh();
  io.onResize(draw);
  for (;;) {
    draw();
    const key: Key | null = await io.key();
    if (key === null) return { kind: "abandoned", reason: "input ended" };
    state.message = null;
    if (key.ctrl && key.name === "c") return { kind: "abandoned", reason: "interrupted" };
    const page = Math.max(1, io.size().rows - 10);
    const scroll = SCROLL_KEYS[key.shift && key.name === "g" ? "G" : key.name];

    if (state.mode === "quit") {
      if (key.name === "y") return { kind: "abandoned", reason: "quit" };
      state.mode = state.previous;
      continue;
    }
    if (scroll && state.mode !== "help") {
      state.scroll = scroll(state.scroll, page);
      continue;
    }
    if (key.name === "q") {
      const decided = model.count("approved") + model.count("rejected") + model.count("skipped");
      if (decided === 0) return { kind: "abandoned", reason: "quit" };
      state.previous = state.mode === "help" ? "proposal" : state.mode;
      state.mode = "quit";
      continue;
    }
    if (state.mode === "help") {
      if (key.name === "?" || key.name === "escape") state.mode = "proposal";
      continue;
    }
    if (key.name === "?") {
      state.mode = "help";
      continue;
    }

    if (state.mode === "submit") {
      if (key.name === "y") {
        const submission = state.submission;
        if (submission === null) continue;
        if (submission.conflicts.length > 0) {
          state.message = [[span("These approvals conflict; go back (n) and change one.", "bad")]];
        } else if (submission.approved.length + submission.rejected.length === 0) {
          state.message = [
            [span("Nothing to submit: approve or reject at least one proposal.", "warn")],
            [span("Nothing to submit yet: decide on one first.", "warn")],
          ];
        } else {
          return { kind: "submit", submission };
        }
      } else if (key.name === "n" || key.name === "escape" || key.name === "left") {
        state.mode = "proposal";
        state.scroll = 0;
      }
      continue;
    }

    // Proposal mode.
    switch (key.name) {
      case "a": {
        const result = await model.approve(state.current);
        await refresh();
        if (result.ok) await advance();
        // The reason is shown in full above; here, say what happened and what to do next.
        else
          state.message = [
            [span("Can't approve this one (the reason is above). ", "bad"), span("r rejects it, s skips it.", "dim")],
            [span("Can't approve this one; ", "bad"), span("r rejects, s skips.", "dim")],
          ];
        break;
      }
      case "r":
      case "s":
        model.decide(state.current, key.name === "r" ? "rejected" : "skipped");
        await refresh();
        await advance();
        break;
      case "u":
        model.decide(state.current, "pending");
        await refresh();
        break;
      case "e":
        await editCurrent(model, state, io);
        await refresh();
        break;
      case "right":
      case "n":
      case "tab":
        select(key.shift ? state.current - 1 : state.current + 1);
        break;
      case "left":
      case "p":
        select(state.current - 1);
        break;
      case "return":
      case "enter":
        await enterSubmit();
        break;
      default:
        state.message = [[span("a approve · r reject · e edit · s skip · ? all keys", "dim")]];
    }
  }
}

async function editCurrent(model: ReviewModel, state: State, io: ScreenIO): Promise<void> {
  const item = model.item(state.current);
  if (item.proposal.action === "delete") {
    state.message = [
      [span("A delete has nothing to edit. Approve, reject or skip it.", "warn")],
      [span("A delete has nothing to edit.", "warn")],
    ];
    return;
  }
  let text: string;
  try {
    text = await io.edit(await model.editableText(state.current), model.fileName(state.current));
  } catch (error) {
    if (!(error instanceof DreamingError)) throw error;
    state.message = [[span(error.message, "bad")]];
    return;
  }
  const parsed = parseEditedMemory(text, item.proposal);
  if (!parsed.ok) {
    item.draft = text;
    state.message = [[span(`Edit not valid (${parsed.errors.join("; ")}); press e to fix it.`, "bad")]];
    return;
  }
  model.setEdit(state.current, parsed.edit);
  state.message = [[span("Edited. The diff now shows your version.", "ok")]];
}
