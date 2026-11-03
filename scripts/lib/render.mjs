// Turn an asciinema v2 cast into terminal screens (with a headless terminal
// emulator, so cursor moves, the alternate screen and colours are exact) and
// the screens into SVG: one still per marker, and one animated SVG of the
// whole cast that plays with CSS alone. The text is set in IBM Plex Mono,
// embedded in each SVG: an SVG shown as an <img> (as the README shows these)
// may not fetch anything, so a font it links to would never load.
import xterm from "@xterm/headless";
import { readFileSync } from "node:fs";

const { Terminal } = xterm;

export const THEME = {
  background: "#0f1418",
  foreground: "#d6dde4",
  ansi: [
    "#1b2229",
    "#f2777a",
    "#7bd88f",
    "#e5c07b",
    "#6ab0f3",
    "#c792ea",
    "#5ccfe6",
    "#d6dde4",
    "#5c6773",
    "#ff8f8f",
    "#a3f0b5",
    "#f5d896",
    "#8cc7ff",
    "#dcb5ff",
    "#8ae3f2",
    "#ffffff",
  ],
};
const FONT = 14;
const CELL = 8.4; // IBM Plex Mono's advance is 0.6 em
const LINE = 19;
const PAD = 18;
// Plex Mono's latin file has no checks, arrows, box-drawing or geometric shapes
// (✓ ✗ → ─ ━ ● ▲ ≠ …); those come from the next face on the stack, and every
// run's width is locked to the grid, so a fallback glyph cannot move its row.
const FONT_STACK = "'IBM Plex Mono', 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace";
const BOLD = 600;

/** The @font-face rules for the weights a drawing uses, with the files inlined as data URIs. */
function fontFaces(bold) {
  const face = (weight, file) => {
    const data = readFileSync(new URL(`../../fonts/${file}`, import.meta.url)).toString("base64");
    return `@font-face{font-family:"IBM Plex Mono";font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${data}) format("woff2")}`;
  };
  return [
    face(400, "ibm-plex-mono-latin-400-normal.woff2"),
    ...(bold ? [face("600 700", "ibm-plex-mono-latin-600-normal.woff2")] : []),
  ].join("");
}

function palette256(index) {
  if (index < 16) return THEME.ansi[index];
  if (index < 232) {
    const i = index - 16;
    const level = (v) => (v === 0 ? 0 : 55 + v * 40);
    const [r, g, b] = [Math.floor(i / 36), Math.floor((i % 36) / 6), i % 6].map(level);
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  const v = (8 + (index - 232) * 10).toString(16).padStart(2, "0");
  return `#${v}${v}${v}`;
}

function colour(cell, which) {
  const isDefault = which === "fg" ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return null;
  const value = which === "fg" ? cell.getFgColor() : cell.getBgColor();
  const isRgb = which === "fg" ? cell.isFgRGB() : cell.isBgRGB();
  return isRgb ? `#${value.toString(16).padStart(6, "0")}` : palette256(value);
}

function snapshot(term) {
  const buffer = term.buffer.active;
  const rows = [];
  for (let y = 0; y < term.rows; y += 1) {
    const line = buffer.getLine(buffer.viewportY + y);
    const cells = [];
    for (let x = 0; x < term.cols; x += 1) {
      const cell = line?.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      let fg = colour(cell, "fg");
      let bg = colour(cell, "bg");
      if (cell.isInverse()) [fg, bg] = [bg ?? THEME.background, fg ?? THEME.foreground];
      cells.push({
        x,
        ch: cell.getChars() || " ",
        w: cell.getWidth(),
        fg,
        bg,
        bold: cell.isBold() !== 0,
        dim: cell.isDim() !== 0,
      });
    }
    rows.push(cells);
  }
  return rows;
}

/** Play a cast through a terminal emulator; return its screens over time and at each marker. */
export async function playCast(castText) {
  const [headerLine, ...lines] = castText.trim().split("\n");
  const header = JSON.parse(headerLine);
  const term = new Terminal({ cols: header.width, rows: header.height, allowProposedApi: true, scrollback: 0 });
  const write = (data) => new Promise((resolve) => term.write(data, resolve));
  const frames = [];
  const markers = new Map();
  try {
    for (const line of lines) {
      const [t, kind, data] = JSON.parse(line);
      if (kind === "o") {
        await write(data);
        frames.push({ t, screen: snapshot(term) });
      } else if (kind === "m") {
        markers.set(data, snapshot(term));
      }
    }
  } finally {
    term.dispose();
  }
  return { header, frames, markers };
}

const xml = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** One terminal row as SVG: background runs, then text runs with locked widths. */
function rowSvg(cells) {
  const parts = [];
  let run = null;
  const flush = () => {
    if (run && run.text.trim() !== "") {
      const attrs = [`x="${(PAD + run.x * CELL).toFixed(2)}"`, `textLength="${(run.width * CELL).toFixed(2)}"`];
      if (run.fg) attrs.push(`fill="${run.fg}"`);
      if (run.bold) attrs.push(`font-weight="${BOLD}"`);
      if (run.dim) attrs.push(`opacity="0.55"`);
      parts.push(`<text ${attrs.join(" ")}>${xml(run.text)}</text>`);
    }
    run = null;
  };
  for (const cell of cells) {
    if (cell.bg)
      parts.push(
        `<rect x="${(PAD + cell.x * CELL).toFixed(2)}" y="-14" width="${(cell.w * CELL + 0.4).toFixed(2)}" height="${LINE}" fill="${cell.bg}"/>`,
      );
    const key = `${cell.fg}|${cell.bold}|${cell.dim}`;
    // Keep wide characters in a run of their own so their width is exact.
    if (run && run.key === key && run.x + run.width === cell.x && cell.w === 1 && run.allNarrow) {
      run.text += cell.ch;
      run.width += cell.w;
    } else {
      flush();
      run = {
        key,
        x: cell.x,
        width: cell.w,
        text: cell.ch,
        fg: cell.fg,
        bold: cell.bold,
        dim: cell.dim,
        allNarrow: cell.w === 1,
      };
    }
  }
  flush();
  return parts.join("");
}

function frameSize(header) {
  return { width: Math.round(PAD * 2 + header.width * CELL), height: Math.round(PAD * 2 + header.height * LINE) };
}

// No fill here: a CSS rule would override every text run's own fill attribute.
// The default colour is inherited from a wrapping group instead.
const STYLE = `text{font-family:${FONT_STACK};font-size:${FONT}px;white-space:pre}`;
const usesBold = (body) => body.includes(`font-weight="${BOLD}"`);

/** A still image of one screen. */
export function screenSvg(header, screen, title) {
  const { width, height } = frameSize(header);
  const rows = screen
    .map((cells, y) => {
      const body = rowSvg(cells);
      return body === "" ? "" : `<g transform="translate(0 ${PAD + (y + 1) * LINE - 5})">${body}</g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(title)}"><title>${xml(title)}</title><style>${fontFaces(usesBold(rows))}${STYLE}</style><rect width="100%" height="100%" rx="8" fill="${THEME.background}"/><g fill="${THEME.foreground}">${rows}</g></svg>\n`;
}

/**
 * The whole cast as one animated SVG. Identical rows are defined once and
 * reused. Each frame is a group that is visible only during its own slice of
 * the loop (a stepped visibility animation), so the browser paints one frame
 * at a time; moving one tall filmstrip instead made Firefox repaint every
 * frame on every tick. It plays anywhere SVG does, with no script.
 */
export function animatedSvg(header, frames, { title, minFrameMs = 40, holdLastMs = 4000 }) {
  const { width, height } = frameSize(header);
  // Keep frames that stay on screen long enough to be seen; merge identical neighbours.
  const kept = [];
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    const next = frames[i + 1];
    const shown = next ? (next.t - frame.t) * 1000 : holdLastMs;
    const signature = JSON.stringify(frame.screen);
    const last = kept.at(-1);
    if (last && last.signature === signature) {
      last.ms += shown;
      continue;
    }
    if (shown < minFrameMs && next) {
      if (last) last.ms += shown;
      continue;
    }
    kept.push({ screen: frame.screen, signature, ms: shown });
  }
  const total = kept.reduce((sum, frame) => sum + frame.ms, 0);
  const at = (ms) => `${((ms / total) * 100).toFixed(3)}%`;
  const rowIds = new Map();
  const defs = [];
  const rules = [];
  let elapsed = 0;
  const film = kept.map((frame, f) => {
    const uses = frame.screen.map((cells, y) => {
      const body = rowSvg(cells);
      if (body === "") return "";
      let id = rowIds.get(body);
      if (id === undefined) {
        id = `r${rowIds.size.toString(36)}`;
        rowIds.set(body, id);
        defs.push(`<g id="${id}">${body}</g>`);
      }
      return `<use href="#${id}" y="${PAD + (y + 1) * LINE - 5}"/>`;
    });
    const from = elapsed;
    elapsed += frame.ms;
    const name = f.toString(36);
    const show = "{visibility:visible}";
    const hide = "{visibility:hidden}";
    const steps =
      f === 0
        ? `0%${show}${at(elapsed)}${hide}`
        : f === kept.length - 1
          ? `0%${hide}${at(from)}${show}100%${show}`
          : `0%${hide}${at(from)}${show}${at(elapsed)}${hide}`;
    rules.push(`#f${name}{animation-name:k${name}}@keyframes k${name}{${steps}}`);
    return `<g id="f${name}" class="fr">${uses.join("")}</g>`;
  });
  const last = `#f${(kept.length - 1).toString(36)}`;
  const css = `${fontFaces(defs.some(usesBold))}${STYLE}.fr{visibility:hidden;animation:${(total / 1000).toFixed(2)}s step-end infinite}${rules.join("")}@media (prefers-reduced-motion:reduce){.fr{animation:none}${last}{visibility:visible}}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(title)}"><title>${xml(title)}</title><style>${css}</style><defs>${defs.join("")}<clipPath id="view"><rect width="${width}" height="${height}" rx="8"/></clipPath></defs><rect width="100%" height="100%" rx="8" fill="${THEME.background}"/><g clip-path="url(#view)" fill="${THEME.foreground}"><g id="film">${film.join("")}</g></g></svg>\n`;
  return { svg, frames: kept.length, durationMs: total, uniqueRows: rowIds.size };
}
