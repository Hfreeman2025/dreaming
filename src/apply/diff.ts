import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";
import type { FileChange } from "./plan.js";

/** A unified diff of one planned file change (`/dev/null` for creations and deletions). */
export function fileDiff(change: FileChange): string {
  const patch = structuredPatch(
    change.before === null ? "/dev/null" : `a/${change.file}`,
    change.after === null ? "/dev/null" : `b/${change.file}`,
    change.before ?? "",
    change.after ?? "",
    undefined,
    undefined,
    { context: 3 },
  );
  return formatPatch(patch, FILE_HEADERS_ONLY);
}

export function planDiff(files: readonly FileChange[]): string {
  return files.map(fileDiff).join("");
}
