/**
 * Styled terminal text. Renderers build lines out of spans with a semantic
 * style; layout (width, wrapping, truncation) works on those spans; ANSI codes
 * are added only at the very end, and only when colour is on. With NO_COLOR
 * the same spans print as plain text, so no information depends on colour.
 */

export type Style =
  | "dim"
  | "bold"
  | "heading"
  | "added"
  | "removed"
  | "addedWord"
  | "removedWord"
  | "ok"
  | "bad"
  | "warn"
  | "key"
  | "accent"
  | "selected";

export interface Span {
  text: string;
  style?: Style | undefined;
}

export type Line = Span[];

const ANSI: Record<Style, [string, string]> = {
  dim: ["2", "22"],
  bold: ["1", "22"],
  heading: ["1", "22"],
  added: ["32", "39"],
  removed: ["31", "39"],
  // Changed words inside a changed line: a tinted background, as in a code review.
  addedWord: ["48;5;22;38;5;157", "49;39"],
  removedWord: ["48;5;52;38;5;217", "49;39"],
  ok: ["32", "39"],
  bad: ["31", "39"],
  warn: ["33", "39"],
  key: ["1;36", "22;39"],
  accent: ["36", "39"],
  selected: ["7", "27"],
};

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ZERO_WIDTH = /^[\p{M}\p{Cf}]+$/u;
const WIDE =
  /[\u1100-\u115f\u231a\u231b\u2329\u232a\u23e9-\u23ec\u23f0\u23f3\u25fd\u25fe\u2614\u2615\u2648-\u2653\u267f\u2693\u26a1\u26aa\u26ab\u26bd\u26be\u26c4\u26c5\u26ce\u26d4\u26ea\u26f2\u26f3\u26f5\u26fa\u26fd\u2705\u270a\u270b\u2728\u274c\u274e\u2753-\u2755\u2757\u2795-\u2797\u27b0\u27bf\u2b1b\u2b1c\u2b50\u2b55\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{1f900}-\u{1faff}\u{20000}-\u{3fffd}]/u;

/** Columns a grapheme occupies in a terminal: 0, 1 or 2. */
export function graphemeWidth(grapheme: string): number {
  if (grapheme === "" || ZERO_WIDTH.test(grapheme)) return 0;
  return WIDE.test(grapheme) ? 2 : 1;
}

export function textWidth(text: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) width += graphemeWidth(segment);
  return width;
}

export const lineWidth = (line: Line): number => line.reduce((sum, span) => sum + textWidth(span.text), 0);

export const span = (text: string, style?: Style): Span => ({ text, style });

interface Cell {
  grapheme: string;
  width: number;
  style: Style | undefined;
}

function cells(line: Line): Cell[] {
  const out: Cell[] = [];
  for (const part of line) {
    for (const { segment } of graphemes.segment(part.text)) {
      out.push({ grapheme: segment, width: graphemeWidth(segment), style: part.style });
    }
  }
  return out;
}

function join(list: readonly Cell[]): Line {
  const line: Line = [];
  for (const cell of list) {
    const last = line.at(-1);
    if (last !== undefined && last.style === cell.style) last.text += cell.grapheme;
    else line.push({ text: cell.grapheme, style: cell.style });
  }
  return line;
}

/**
 * Where a line may break: at a space, but not inside a command (a key span),
 * which has to stay pasteable, and not before a "·" separator, which belongs
 * at the end of the line it follows.
 */
function breakable(all: readonly Cell[], i: number): boolean {
  const cell = all[i];
  return cell?.grapheme === " " && cell.style !== "key" && all[i + 1]?.grapheme !== "·";
}

/**
 * Word-wrap a line to `width` columns. Breaks at spaces where it can and
 * hard-breaks words longer than a line. Continuation lines start with
 * `indent` (a prefix such as a gutter), which counts toward the width.
 */
export function wrap(line: Line, width: number, indent: Line = []): Line[] {
  const indentWidth = lineWidth(indent);
  const all = cells(line);
  const out: Line[] = [];
  let start = 0;
  let first = true;
  while (start < all.length) {
    const room = Math.max(1, first ? width : width - indentWidth);
    let used = 0;
    let end = start;
    let lastSpace = -1;
    while (end < all.length) {
      const cell = all[end];
      if (cell === undefined || used + cell.width > room) break;
      if (breakable(all, end)) lastSpace = end;
      used += cell.width;
      end += 1;
    }
    if (end < all.length && breakable(all, end)) lastSpace = end; // the text fills the room exactly
    if (end < all.length && lastSpace > start) {
      end = lastSpace; // break at the last space that fits, leaving no trailing spaces
      while (end > start + 1 && all[end - 1]?.grapheme === " ") end -= 1;
    } else if (end < all.length && all[end]?.style === "key") {
      // A command longer than the room stays whole; the terminal's own wrap still copies as one line.
      while (end < all.length && all[end]?.style === "key") end += 1;
    }
    if (end === start) end = start + 1; // a single character wider than the room
    const piece = join(all.slice(start, end));
    out.push(first ? piece : [...indent, ...piece]);
    start = end;
    while (all[start]?.grapheme === " ") start += 1; // the break swallows the space
    first = false;
  }
  return out.length === 0 ? [first ? [] : indent] : out;
}

/** Cut a line to `width` columns, ending in "…" when something was cut. */
export function truncate(line: Line, width: number): Line {
  if (lineWidth(line) <= width) return line;
  const all = cells(line);
  const kept: Cell[] = [];
  let used = 0;
  for (const cell of all) {
    if (used + cell.width > width - 1) break;
    kept.push(cell);
    used += cell.width;
  }
  return [...join(kept), { text: "…", style: "dim" }];
}

/** Pad (or truncate) to exactly `width` columns. */
export function fit(line: Line, width: number): Line {
  const cut = truncate(line, width);
  const gap = width - lineWidth(cut);
  return gap > 0 ? [...cut, { text: " ".repeat(gap) }] : cut;
}

/** Left part, then right part pushed to the right edge (the right part wins on a tight fit). */
export function spread(left: Line, right: Line, width: number): Line {
  const rightWidth = lineWidth(right);
  if (rightWidth + 1 >= width) return truncate(right, width);
  const leftPart = truncate(left, width - rightWidth - 1);
  const gap = width - lineWidth(leftPart) - rightWidth;
  return [...leftPart, { text: " ".repeat(Math.max(1, gap)) }, ...right];
}

export function toPlain(line: Line): string {
  return line.map((part) => part.text).join("");
}

export function toAnsi(line: Line, color: boolean): string {
  if (!color) return toPlain(line);
  return line
    .map((part) => {
      if (part.style === undefined || part.text === "") return part.text;
      const [open, close] = ANSI[part.style];
      return `\u001b[${open}m${part.text}\u001b[${close}m`;
    })
    .join("");
}

export const rule = (width: number): Line => [{ text: "─".repeat(Math.max(0, width)), style: "dim" }];

/** A path for display: the home directory shown as `~`. */
export function tildify(path: string, home: string): string {
  if (home === "" || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
