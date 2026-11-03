import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DreamingError, errorCode } from "../errors.js";
import { readJsonFile, writeJsonFile } from "../fsx.js";

/**
 * Everything one `dreaming eval` did, as recorded: the plan, the isolation
 * evidence, and every run with its outcome, turns, tokens and time. The
 * statistics are not stored; they are recomputed from the runs (seeded, so a
 * reload gives the same numbers), so there is one source of truth.
 */

const UsageSchema = z.strictObject({
  input: z.number().int().nonnegative(),
  cacheCreation: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
});

export const EvalRunSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  arm: z.enum(["without", "with"]),
  task: z.string(),
  rep: z.number().int().nonnegative(),
  /** Milliseconds from the start of the eval. */
  startedMs: z.number().nonnegative(),
  wallMs: z.number().nonnegative(),
  /** pass and fail count; error (the agent could not run) does not. */
  outcome: z.enum(["pass", "fail", "error"]),
  reason: z.string(),
  agent: z.strictObject({
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    subtype: z.string().nullable(),
    model: z.string().nullable(),
    turns: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    costUsd: z.number().nonnegative(),
    usage: UsageSchema,
    toolCalls: z.record(z.string(), z.number().int().nonnegative()),
  }),
  isolation: z.strictObject({
    hookEvents: z.number().int().nonnegative(),
    canaries: z.array(z.string()),
    registryHooks: z.number().int().nonnegative().nullable(),
    /** Bash commands that called a package manager, and calls the suite's shims recorded. */
    packageCommands: z.number().int().nonnegative(),
    shimCalls: z.number().int().nonnegative(),
  }),
});

export const EvalRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  evalId: z.string().regex(/^\d{8}-\d{6}-[0-9a-f]{4}$/),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  /** How it ended: completed, interrupted (Ctrl-C), isolation (a run showed a hook), or error. */
  ended: z.enum(["completed", "interrupted", "isolation", "error"]),
  endedBecause: z.string().nullable(),
  proposal: z.strictObject({
    runId: z.string(),
    id: z.string(),
    action: z.enum(["add", "update", "delete"]),
    file: z.string(),
    description: z.string(),
  }),
  memoryDir: z.string(),
  suite: z.strictObject({
    name: z.string(),
    about: z.string(),
    tasks: z.array(z.strictObject({ id: z.string(), prompt: z.string(), passMeans: z.string() })),
  }),
  plan: z.strictObject({
    runs: z.number().int().positive().max(30),
    reps: z.number().int().positive(),
    seed: z.number().int().nonnegative(),
    parallel: z.number().int().positive(),
  }),
  agent: z.strictObject({
    bin: z.string(),
    version: z.string().nullable(),
    model: z.string().nullable(),
    /** The argv of every run, with the memory text shown as <memory>. */
    argv: z.array(z.string()),
  }),
  isolation: z.strictObject({
    control: z.strictObject({
      ok: z.boolean(),
      hookEvents: z.number().int().nonnegative(),
      canaries: z.array(z.string()),
      detail: z.string(),
    }),
    workDir: z.string(),
    bashrc: z.boolean(),
    audit: z.strictObject({
      samples: z.number().int().nonnegative(),
      seen: z.array(z.string()),
      soundPlayers: z.array(z.strictObject({ name: z.string(), run: z.number().int() })),
    }),
  }),
  runs: z.array(EvalRunSchema),
});

export type EvalRun = z.infer<typeof EvalRunSchema>;
export type EvalRecord = z.infer<typeof EvalRecordSchema>;

export const evalFile = (dir: string, evalId: string): string => join(dir, `${evalId}.json`);

export async function saveEval(dir: string, record: EvalRecord): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = evalFile(dir, record.evalId);
  await writeJsonFile(path, EvalRecordSchema.parse(record));
  return path;
}

export async function loadEval(path: string): Promise<EvalRecord> {
  const record = await readJsonFile(path, EvalRecordSchema, "eval record");
  if (record === null) throw new DreamingError(`no eval record at ${path}`);
  return record;
}

/** Every saved eval, oldest first. */
export async function loadEvals(dir: string): Promise<EvalRecord[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const records: EvalRecord[] = [];
  for (const name of names.filter((n) => /^\d{8}-\d{6}-[0-9a-f]{4}\.json$/.test(n)).sort()) {
    const record = await readJsonFile(join(dir, name), EvalRecordSchema, "eval record");
    if (record !== null) records.push(record);
  }
  return records;
}

/** The most recent completed eval of each proposal. */
export function latestByProposal(records: readonly EvalRecord[]): Map<string, EvalRecord> {
  const latest = new Map<string, EvalRecord>();
  for (const record of records) {
    if (record.ended !== "completed") continue;
    latest.set(`${record.proposal.runId}/${record.proposal.id}`, record);
  }
  return latest;
}
