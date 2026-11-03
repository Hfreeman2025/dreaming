/**
 * Edits to `MEMORY.md`, the index Claude Code loads into context. Each memory
 * has one pointer line: `- [Title](file.md) — one-line hook`. Edits are
 * line-level and leave every other line exactly as it was.
 */

export const INDEX_FILE = "MEMORY.md";

const POINTER = /^(\s*[-*]\s+)\[([^\]]*)\]\(([^)\s]+)\)(.*)$/;

function linkTarget(line: string): { prefix: string; title: string; target: string } | null {
  const match = POINTER.exec(line);
  if (match === null) return null;
  const [, prefix = "", title = "", target = ""] = match;
  return { prefix, title, target: target.replace(/^\.\//, "") };
}

/** One line of the index with its own ending, so untouched lines are written back byte for byte. */
interface IndexLine {
  text: string;
  eol: string;
}

function splitIndex(index: string): IndexLine[] {
  if (index === "") return [];
  return index.split(/(?<=\n)/).map((piece) => {
    const eol = piece.endsWith("\r\n") ? "\r\n" : piece.endsWith("\n") ? "\n" : "";
    return { text: piece.slice(0, piece.length - eol.length), eol };
  });
}

/** Join lines, ending the file with a line break (in the style the file already uses). */
function joinIndex(lines: readonly IndexLine[]): string {
  const style = lines.find((line) => line.eol !== "")?.eol ?? "\n";
  return lines.map((line) => line.text + (line.eol === "" ? style : line.eol)).join("");
}

function newLine(lines: readonly IndexLine[], text: string): IndexLine {
  const last = [...lines].reverse().find((line) => line.eol !== "");
  return { text, eol: last?.eol ?? "\n" };
}

export function pointerLine(title: string, file: string, hook: string): string {
  return `- [${title.replace(/[[\]]/g, "")}](${file}) — ${hook}`;
}

export function indexLinksTo(index: string, file: string): boolean {
  return splitIndex(index).some((line) => linkTarget(line.text)?.target === file);
}

/**
 * Make sure the index has exactly one pointer to `file` with `hook` as its
 * description. An existing pointer keeps its title and position; duplicates
 * are removed; a missing pointer is appended.
 */
export function upsertPointer(index: string, file: string, title: string, hook: string): string {
  const lines = splitIndex(index);
  const out: IndexLine[] = [];
  let found = false;
  for (const line of lines) {
    const link = linkTarget(line.text);
    if (link?.target !== file) {
      out.push(line);
      continue;
    }
    if (found) continue;
    found = true;
    out.push({ text: `${link.prefix}[${link.title}](${file}) — ${hook}`, eol: line.eol });
  }
  if (!found) out.push(newLine(lines, pointerLine(title, file, hook)));
  return joinIndex(out);
}

/** Remove every pointer to `file`. */
export function removePointers(index: string, file: string): string {
  return joinIndex(splitIndex(index).filter((line) => linkTarget(line.text)?.target !== file));
}
