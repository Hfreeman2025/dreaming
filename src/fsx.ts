import { createHash, randomBytes } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { z } from "zod";
import { DreamingError, errorCode, errorMessage } from "./errors.js";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Write a file so readers only ever see the old or the new content: write a
 * sibling temp file, fsync it, then rename over the target. The temp file is
 * removed if anything fails before the rename.
 */
export async function writeFileAtomic(path: string, data: string, mode = 0o600): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  let renamed = false;
  try {
    const handle = await open(temp, "wx", mode);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
    renamed = true;
  } finally {
    if (!renamed) await rm(temp, { force: true });
  }
}

/** Read a UTF-8 file, or `null` if it does not exist. Other errors propagate. */
export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

export type FileKind = "missing" | "file" | "directory" | "symlink" | "other";

export async function fileKind(path: string): Promise<FileKind> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isFile()) return "file";
    if (stats.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
}

/** Parse JSON text into `unknown`; the caller validates the shape with a schema. */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Render zod issues as indented `path: message` lines. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * Read a JSON file and validate it. A missing file returns `null`; a file that
 * exists but is unreadable, not JSON, or the wrong shape is an error naming the
 * file, never a silent default.
 */
export async function readJsonFile<T>(path: string, schema: z.ZodType<T>, label: string): Promise<T | null> {
  const text = await readTextIfExists(path);
  if (text === null) return null;
  const parsed = parseJson(text);
  if (!parsed.ok) {
    throw new DreamingError(`${label} is not valid JSON: ${path}\n  ${parsed.error}`);
  }
  const result = schema.safeParse(parsed.value);
  if (!result.success) {
    throw new DreamingError(`${label} has an invalid shape: ${path}\n${formatIssues(result.error)}`);
  }
  return result.data;
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}
