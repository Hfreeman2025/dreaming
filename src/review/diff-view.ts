import { diffWordsWithSpace, structuredPatch } from "diff";
import type { FileChange } from "../apply/plan.js";

/**
 * A planned file change as rows for display: line numbers, kind, and, for a
 * removed line followed by its replacement, which words actually changed.
 */

export interface Segment {
  text: string;
  changed: boolean;
}

export interface DiffRow {
  kind: "add" | "del" | "ctx" | "gap";
  /** Line number in the old file (deletions, context) or the new file (additions, context). */
  number: number | undefined;
  segments: Segment[];
}

export interface FileDiff {
  file: string;
  status: "new" | "deleted" | "modified";
  added: number;
  removed: number;
  rows: DiffRow[];
}

/** Merge changed words separated only by whitespace into one highlighted run. */
function joinChanged(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  segments.forEach((segment, i) => {
    const prev = out.at(-1);
    const next = segments[i + 1];
    const bridge = !segment.changed && segment.text.trim() === "" && prev?.changed === true && next?.changed === true;
    const changed = segment.changed || bridge;
    if (prev && prev.changed === changed) prev.text += segment.text;
    else out.push({ text: segment.text, changed });
  });
  return out;
}

function whole(text: string): Segment[] {
  return [{ text, changed: false }];
}

/** Pair the n-th removed line with the n-th added line of a block and mark the changed words. */
function pairWords(removed: DiffRow[], added: DiffRow[]): void {
  if (removed.length !== added.length) return;
  removed.forEach((del, i) => {
    const add = added[i];
    if (add === undefined) return;
    const before = del.segments.map((s) => s.text).join("");
    const after = add.segments.map((s) => s.text).join("");
    const parts = diffWordsWithSpace(before, after);
    // Highlight words only when most of the line survives; a rewritten line is
    // already marked as a whole, and speckled highlights would only add noise.
    const kept = parts.filter((p) => !p.added && !p.removed).reduce((sum, p) => sum + p.value.length, 0);
    if (kept < Math.max(before.length, after.length) / 2) return;
    del.segments = joinChanged(parts.filter((p) => !p.added).map((p) => ({ text: p.value, changed: p.removed })));
    add.segments = joinChanged(parts.filter((p) => !p.removed).map((p) => ({ text: p.value, changed: p.added })));
  });
}

export function fileDiff(change: FileChange, context = 3): FileDiff {
  const patch = structuredPatch(
    change.file,
    change.file,
    change.before ?? "",
    change.after ?? "",
    undefined,
    undefined,
    {
      context,
    },
  );
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  patch.hunks.forEach((hunk, h) => {
    if (h > 0) rows.push({ kind: "gap", number: undefined, segments: [] });
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    let dels: DiffRow[] = [];
    let adds: DiffRow[] = [];
    const flush = () => {
      pairWords(dels, adds);
      dels = [];
      adds = [];
    };
    for (const raw of hunk.lines) {
      const marker = raw[0];
      const text = raw.slice(1);
      if (marker === "\\") continue; // "\ No newline at end of file"
      if (marker === "-") {
        if (adds.length > 0) flush();
        const row: DiffRow = { kind: "del", number: oldNo, segments: whole(text) };
        rows.push(row);
        dels.push(row);
        oldNo += 1;
        removed += 1;
      } else if (marker === "+") {
        const row: DiffRow = { kind: "add", number: newNo, segments: whole(text) };
        rows.push(row);
        adds.push(row);
        newNo += 1;
        added += 1;
      } else {
        flush();
        rows.push({ kind: "ctx", number: newNo, segments: whole(text) });
        oldNo += 1;
        newNo += 1;
      }
    }
    flush();
  });
  const status = change.before === null ? "new" : change.after === null ? "deleted" : "modified";
  return { file: change.file, status, added, removed, rows };
}

export function diffStats(files: readonly FileChange[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    const diff = fileDiff(file, 0);
    added += diff.added;
    removed += diff.removed;
  }
  return { added, removed };
}
