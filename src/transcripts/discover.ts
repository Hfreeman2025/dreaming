import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { DreamingError, errorCode } from "../errors.js";
import type { State } from "../state.js";

export interface TranscriptFile {
  path: string;
  /** Project directory name under the transcripts root. */
  project: string;
  /** File name without `.jsonl`; Claude Code uses the session UUID. */
  sessionId: string;
  mtimeMs: number;
  size: number;
}

export interface SelectedTranscript extends TranscriptFile {
  /** Lines already dreamt over in an earlier run (0 for a new session). */
  fromLine: number;
}

export type SkipReason = "active" | "deferred" | "too-large";

export interface SkippedTranscript {
  path: string;
  reason: SkipReason;
  detail: string;
}

export interface DiscoveryOptions {
  root: string;
  state: State;
  nowMs: number;
  settleMinutes: number;
  maxSessions: number;
  maxTranscriptBytes: number;
}

export interface DiscoveryResult {
  selected: SelectedTranscript[];
  skipped: SkippedTranscript[];
}

async function listDirectory(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new DreamingError(`transcripts directory not found: ${path}`, {
        hint: "Set transcripts.root in the config to the directory that holds one folder per project.",
      });
    }
    throw error;
  }
}

/** Every `<root>/<project>/<session>.jsonl` regular file. Symlinks are not followed. */
export async function listTranscripts(root: string): Promise<TranscriptFile[]> {
  const files: TranscriptFile[] = [];
  for (const project of await listDirectory(root)) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, project.name);
    for (const entry of await listDirectory(projectDir)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(projectDir, entry.name);
      const stats = await lstat(path);
      files.push({
        path,
        project: project.name,
        sessionId: basename(entry.name, ".jsonl"),
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      });
    }
  }
  return files;
}

/**
 * Choose the transcripts to dream over: changed since their last dream (or
 * since the cold-start floor), quiet for `settleMinutes`, oldest first, at
 * most `maxSessions`. Everything not chosen but in scope is reported, so a
 * person can see why a session was left out.
 */
export async function discoverTranscripts(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const cutoffMs = options.nowMs - options.settleMinutes * 60_000;
  const candidates: SelectedTranscript[] = [];
  const skipped: SkippedTranscript[] = [];

  for (const file of await listTranscripts(options.root)) {
    const mark = options.state.sessions[file.path];
    const since = mark?.mtimeMs ?? options.state.floorMs;
    if (file.mtimeMs <= since) continue;

    if (file.mtimeMs > cutoffMs) {
      skipped.push({
        path: file.path,
        reason: "active",
        detail: `modified in the last ${options.settleMinutes} minutes; will be read once it settles`,
      });
      continue;
    }
    if (file.size > options.maxTranscriptBytes) {
      skipped.push({
        path: file.path,
        reason: "too-large",
        detail: `${file.size} bytes exceeds transcripts.maxTranscriptBytes (${options.maxTranscriptBytes})`,
      });
      continue;
    }
    candidates.push({ ...file, fromLine: mark?.lines ?? 0 });
  }

  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  const selected = candidates.slice(0, options.maxSessions);
  for (const file of candidates.slice(options.maxSessions)) {
    skipped.push({
      path: file.path,
      reason: "deferred",
      detail: `over the limit of ${options.maxSessions} sessions per run; left for the next run`,
    });
  }
  return { selected, skipped };
}
