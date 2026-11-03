import { randomBytes } from "node:crypto";
import { link, readFile, rm, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { DreamingError, errorCode } from "./errors.js";
import { parseJson } from "./fsx.js";

const LockSchema = z.strictObject({
  pid: z.number().int().positive(),
  purpose: z.string(),
  startedAt: z.string(),
  /** Random per acquisition, so a holder can tell its own lock from a newer one. */
  token: z.string(),
});
type LockRecord = z.infer<typeof LockSchema>;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return errorCode(error) === "EPERM";
  }
}

/**
 * Create the lock file atomically: the record is written to a private temp
 * file and hard-linked into place, so the lock either does not exist or holds
 * a complete record. `link` fails with EEXIST if someone holds it.
 */
async function tryCreate(lockPath: string, record: LockRecord): Promise<boolean> {
  const temp = `${lockPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
  try {
    await link(temp, lockPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

async function readRecord(path: string): Promise<LockRecord | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  const parsed = parseJson(text);
  const result = parsed.ok ? LockSchema.safeParse(parsed.value) : null;
  if (!result?.success) {
    throw new DreamingError(`lock file is unreadable: ${path}`, {
      hint: "If no dreaming process is running, delete the lock file and try again.",
    });
  }
  return result.data;
}

/** A reclaim marker older than this was left by a process that died mid-reclaim. */
const ABANDONED_MARKER_MS = 30_000;

/**
 * Remove a lock left by a dead process. Only the holder of an exclusive
 * `<lock>.reclaim` marker may remove a lock it does not own, and it removes it
 * only if the file still holds the stale record it read. Live owners only ever
 * remove their own lock (by token), and a new lock can only be created while
 * none exists, so a fresh lock can never be removed by mistake.
 */
async function reclaim(lockPath: string, stale: LockRecord): Promise<void> {
  const marker = `${lockPath}.reclaim`;
  try {
    await writeFile(marker, String(process.pid), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    // Someone else is reclaiming; clear their marker only if it was clearly abandoned.
    const age = await stat(marker).then(
      (stats) => Date.now() - stats.mtimeMs,
      (statError: unknown) => {
        if (errorCode(statError) === "ENOENT") return 0;
        throw statError;
      },
    );
    if (age > ABANDONED_MARKER_MS) await rm(marker, { force: true });
    return;
  }
  try {
    const current = await readRecord(lockPath);
    if (current?.token === stale.token) await rm(lockPath, { force: true });
  } finally {
    await rm(marker, { force: true });
  }
}

/** Remove the lock only if it is still ours. */
async function release(lockPath: string, token: string): Promise<void> {
  const current = await readRecord(lockPath).catch((error: unknown) => {
    if (error instanceof DreamingError) return null; // unreadable: not ours to remove
    throw error;
  });
  if (current?.token === token) await rm(lockPath, { force: true });
}

/**
 * Run `fn` while holding an exclusive lock file. A lock left behind by a
 * process that no longer exists is reclaimed; a live holder is an error.
 */
export async function withLock<T>(lockPath: string, purpose: string, fn: () => Promise<T>): Promise<T> {
  const record: LockRecord = {
    pid: process.pid,
    purpose,
    startedAt: new Date().toISOString(),
    token: randomBytes(8).toString("hex"),
  };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    if (await tryCreate(lockPath, record)) {
      try {
        return await fn();
      } finally {
        await release(lockPath, record.token);
      }
    }
    const holder = await readRecord(lockPath);
    if (holder === null) continue; // released between our attempts
    if (processIsAlive(holder.pid)) {
      throw new DreamingError(
        `another dreaming ${holder.purpose} is in progress (pid ${holder.pid}, started ${holder.startedAt})`,
        { hint: `Wait for it to finish. Lock file: ${lockPath}` },
      );
    }
    await reclaim(lockPath, holder);
  }
  throw new DreamingError(`could not acquire lock: ${lockPath}`, {
    hint: "Another process keeps re-creating it; check for concurrent dreaming runs.",
  });
}
