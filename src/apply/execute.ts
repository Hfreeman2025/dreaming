import { appendFile, copyFile, mkdir, readdir, rm, stat, truncate, unlink } from "node:fs/promises";
import { join } from "node:path";
import { auditLines } from "../audit.js";
import { DreamingError, errorCode, errorMessage } from "../errors.js";
import { fileKind, readTextIfExists, writeFileAtomic, writeJsonFile } from "../fsx.js";
import type { ApplyPlan, FileChange, PlannedOutcome } from "./plan.js";

/**
 * Executing a plan:
 *  1. re-check that every file still has the content the plan was made from;
 *  2. back up the memory directory's Markdown files;
 *  3. write each file atomically (memory files first, the index last);
 *  4. append one audit line per proposal to applied.jsonl.
 * If step 3 or 4 fails, every file already written is restored from the plan's
 * `before` content and the error says so. Memory is never left half-applied
 * without the person being told.
 */

export interface FileIo {
  write(path: string, content: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
  appendAudit(path: string, lines: string): Promise<void>;
  /** Cut the audit log back to `size` bytes (used to undo a partial append). */
  truncateAudit(path: string, size: number): Promise<void>;
}

export const realIo: FileIo = {
  write: writeFileAtomic,
  remove: unlink,
  appendAudit: (path, lines) => appendFile(path, lines, { encoding: "utf8", mode: 0o600 }),
  // With no log before the attempt, remove whatever the failed append created (if anything).
  truncateAudit: (path, size) => (size === 0 ? rm(path, { force: true }) : truncate(path, size)),
};

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }
}

export interface ExecuteContext {
  applyId: string;
  backupDir: string;
  auditLog: string;
  now: Date;
}

export interface ApplyResult {
  applyId: string;
  backupDir: string;
  outcomes: PlannedOutcome[];
}

async function modeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0o644;
    throw error;
  }
}

async function backup(memoryDir: string, backupDir: string, plan: ApplyPlan, now: Date): Promise<void> {
  await mkdir(join(backupDir, "files"), { recursive: true, mode: 0o700 });
  const copied: string[] = [];
  for (const entry of await readdir(memoryDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    await copyFile(join(memoryDir, entry.name), join(backupDir, "files", entry.name));
    copied.push(entry.name);
  }
  await writeJsonFile(join(backupDir, "manifest.json"), {
    memoryDir,
    createdAt: now.toISOString(),
    files: copied.sort(),
    changes: plan.files.map((f) => ({ file: f.file, existedBefore: f.before !== null, existsAfter: f.after !== null })),
  });
}

async function writeChange(io: FileIo, dir: string, change: FileChange, content: string | null): Promise<void> {
  const path = join(dir, change.file);
  if (content === null) {
    await io.remove(path);
  } else {
    await io.write(path, content, await modeOf(path));
  }
}

export async function executePlan(plan: ApplyPlan, ctx: ExecuteContext, io: FileIo = realIo): Promise<ApplyResult> {
  for (const change of plan.files) {
    const path = join(plan.memoryDir, change.file);
    const kind = await fileKind(path);
    const current = kind === "file" ? await readTextIfExists(path) : null;
    if ((kind !== "file" && kind !== "missing") || current !== change.before) {
      throw new DreamingError(`${change.file} changed after the diff was shown; nothing was written`, {
        hint: "Run `dreaming review` again to see the current diff.",
      });
    }
  }

  await backup(plan.memoryDir, ctx.backupDir, plan, ctx.now);

  const written: FileChange[] = [];
  const auditSize = await sizeOf(ctx.auditLog);
  let auditTouched = false;
  try {
    for (const change of plan.files) {
      await writeChange(io, plan.memoryDir, change, change.after);
      written.push(change);
    }
    if (plan.outcomes.length > 0) {
      auditTouched = true;
      await io.appendAudit(ctx.auditLog, auditLines(plan, ctx));
    }
  } catch (error) {
    const restoreErrors: string[] = [];
    if (auditTouched) {
      // A failed append may have written part of the lines; never leave a
      // record of changes that are about to be undone.
      try {
        await io.truncateAudit(ctx.auditLog, auditSize);
      } catch (truncateError) {
        restoreErrors.push(`${ctx.auditLog}: ${errorMessage(truncateError)}`);
      }
    }
    for (const change of written.reverse()) {
      try {
        await writeChange(io, plan.memoryDir, change, change.before);
      } catch (restoreError) {
        restoreErrors.push(`${change.file}: ${errorMessage(restoreError)}`);
      }
    }
    if (restoreErrors.length > 0) {
      throw new DreamingError(
        `applying failed (${errorMessage(error)}) and restoring also failed for ${restoreErrors.join("; ")}`,
        { hint: `Restore the memory directory by hand from the backup: ${ctx.backupDir}/files`, cause: error },
      );
    }
    throw new DreamingError(`applying failed and every change was rolled back: ${errorMessage(error)}`, {
      hint: `A backup taken before the attempt is in ${ctx.backupDir}`,
      cause: error,
    });
  }
  return { applyId: ctx.applyId, backupDir: ctx.backupDir, outcomes: plan.outcomes };
}
