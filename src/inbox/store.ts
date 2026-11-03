import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DreamingError, errorCode } from "../errors.js";
import { readJsonFile, writeFileAtomic, writeJsonFile } from "../fsx.js";
import { renderRunMarkdown } from "./render.js";
import { RunRecordSchema, type RunRecord, type StoredProposal } from "./schema.js";

export function runFiles(inboxDir: string, runId: string): { json: string; markdown: string } {
  return { json: join(inboxDir, `${runId}.json`), markdown: join(inboxDir, `${runId}.md`) };
}

/** Write the run record, then its Markdown view. The JSON is the source of truth. */
export async function saveRun(inboxDir: string, record: RunRecord): Promise<{ json: string; markdown: string }> {
  await mkdir(inboxDir, { recursive: true, mode: 0o700 });
  const files = runFiles(inboxDir, record.runId);
  await writeJsonFile(files.json, record);
  await writeFileAtomic(files.markdown, renderRunMarkdown(record));
  return files;
}

/** Every run in the inbox, oldest first. An invalid run file is an error, not a skip. */
export async function loadRuns(inboxDir: string): Promise<RunRecord[]> {
  let names: string[];
  try {
    names = await readdir(inboxDir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const runs: RunRecord[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const record = await readJsonFile(join(inboxDir, name), RunRecordSchema, "inbox run file");
    if (record === null) continue; // deleted between readdir and read
    if (`${record.runId}.json` !== name) {
      throw new DreamingError(`inbox run file ${name} contains run ${record.runId}`, {
        hint: "Run files must be named after the run they contain.",
      });
    }
    runs.push(record);
  }
  return runs;
}

export interface PendingProposal {
  run: RunRecord;
  proposal: StoredProposal;
}

export function pendingProposals(runs: readonly RunRecord[]): PendingProposal[] {
  return runs.flatMap((run) =>
    run.proposals.filter((proposal) => proposal.status === "pending").map((proposal) => ({ run, proposal })),
  );
}

export type StatusChange = { runId: string; id: string; status: "rejected" | "applied"; at: string };

/** Record decisions in the run files they belong to (re-read first, then written atomically). */
export async function recordDecisions(inboxDir: string, changes: readonly StatusChange[]): Promise<void> {
  const byRun = new Map<string, StatusChange[]>();
  for (const change of changes) {
    // The run id names a file, so it must be a run id and nothing else.
    if (!RunRecordSchema.shape.runId.safeParse(change.runId).success) {
      throw new DreamingError(`invalid run id: ${change.runId}`);
    }
    byRun.set(change.runId, [...(byRun.get(change.runId) ?? []), change]);
  }
  for (const [runId, runChanges] of byRun) {
    const files = runFiles(inboxDir, runId);
    const record = await readJsonFile(files.json, RunRecordSchema, "inbox run file");
    if (record === null) throw new DreamingError(`inbox run file disappeared: ${files.json}`);
    const updated: RunRecord = {
      ...record,
      proposals: record.proposals.map((proposal) => {
        const change = runChanges.find((c) => c.id === proposal.id);
        return change ? { ...proposal, status: change.status, decidedAt: change.at } : proposal;
      }),
    };
    const unknown = runChanges.filter((change) => !record.proposals.some((p) => p.id === change.id));
    if (unknown.length > 0) {
      throw new DreamingError(`run ${runId} has no proposal ${unknown.map((c) => c.id).join(", ")}`);
    }
    await saveRun(inboxDir, updated);
  }
}
