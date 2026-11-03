import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { planApply, targetFile } from "../apply/plan.js";
import type { Config, DreamingEnv, DreamingPaths } from "../config.js";
import { errorCode } from "../errors.js";
import { readJsonFile, sha256, writeJsonFile } from "../fsx.js";
import type { PendingProposal } from "../inbox/store.js";
import { checkProposal, memoryText, type CheckResult, type MemoryText } from "./check.js";
import { findModel, modelBytes, modelDirs, NLI_MODEL } from "./models.js";
import { loadNliEngine, type NliEngine } from "./nli.js";

/**
 * Contradiction checks, kept beside the inbox: one file per dream, holding
 * for each of its proposals what the local NLI model found against the rest
 * of the memory set. Each file records a hash of the memory it was checked
 * against, so the review can say when a result is out of date.
 */

const Scores = z.strictObject({ contradiction: z.number(), entailment: z.number(), neutral: z.number() });
const Sentence = z.strictObject({
  file: z.string(),
  source: z.enum(["memory", "proposal"]),
  proposalId: z.string().optional(),
  sentence: z.string(),
});
const ContradictionSchema = z.strictObject({ a: Sentence, b: Sentence, score: z.number(), ab: Scores, ba: Scores });

export const ChecksSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string(),
  checkedAt: z.string(),
  model: z.strictObject({ id: z.string(), revision: z.string() }),
  threshold: z.number(),
  memoryHash: z.string(),
  proposals: z.array(
    z.strictObject({
      proposalId: z.string(),
      pairs: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      ms: z.number().nonnegative(),
      contradictions: z.array(ContradictionSchema),
    }),
  ),
});
export type Checks = z.infer<typeof ChecksSchema>;
export type ProposalCheck = Checks["proposals"][number];

/** The memory files as they are now (the index excluded: it repeats the descriptions). */
export async function readMemoryFiles(memoryDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of (await readdir(memoryDir)).sort()) {
    if (!name.endsWith(".md") || name === "MEMORY.md" || name.startsWith(".")) continue;
    files.set(name, await readFile(join(memoryDir, name), "utf8"));
  }
  return files;
}

export function memoryHash(files: ReadonlyMap<string, string>): string {
  return sha256([...files].map(([name, content]) => `${name}\u0000${content}`).join("\u0000\u0000"));
}

/** The text a proposal would leave in memory, or null for a delete (it says nothing). */
async function proposalText(memoryDir: string, pending: PendingProposal): Promise<MemoryText | null> {
  const change = { runId: pending.run.runId, proposal: pending.proposal };
  const planned = await planApply(memoryDir, [change]);
  if (!planned.ok) return null;
  const file = targetFile(change);
  const after = planned.plan.files.find((f) => f.file === file)?.after;
  return after === undefined || after === null ? null : memoryText(file, after, "proposal", pending.proposal.id);
}

/** Check every pending proposal against the memory set and the other pending proposals. */
export async function checkPending(
  engine: NliEngine,
  memoryDir: string,
  pending: readonly PendingProposal[],
  options: { threshold: number; now: () => Date },
): Promise<Checks[]> {
  const files = await readMemoryFiles(memoryDir);
  const existing = [...files].map(([name, content]) => memoryText(name, content));
  const texts = new Map<string, MemoryText>();
  for (const p of pending) {
    const text = await proposalText(memoryDir, p);
    if (text !== null) texts.set(p.proposal.id, text);
  }
  const byRun = new Map<string, Checks>();
  for (const p of pending) {
    const checks =
      byRun.get(p.run.runId) ??
      ({
        schemaVersion: 1,
        runId: p.run.runId,
        checkedAt: options.now().toISOString(),
        model: { id: NLI_MODEL.id, revision: NLI_MODEL.revision },
        threshold: options.threshold,
        memoryHash: memoryHash(files),
        proposals: [],
      } satisfies Checks);
    byRun.set(p.run.runId, checks);
    const text = texts.get(p.proposal.id);
    if (text === undefined) continue;
    const others = [...existing, ...[...texts.values()].filter((t) => t.proposalId !== p.proposal.id)];
    const result: CheckResult = await checkProposal(engine, text, others, { threshold: options.threshold });
    checks.proposals.push({
      proposalId: p.proposal.id,
      pairs: result.pairs,
      skipped: result.skipped,
      ms: Math.round(result.ms),
      contradictions: result.contradictions,
    });
  }
  return [...byRun.values()];
}

export async function saveChecks(dir: string, checks: Checks): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeJsonFile(join(dir, `${checks.runId}.json`), ChecksSchema.parse(checks));
}

export async function loadChecks(dir: string): Promise<Map<string, Checks>> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return new Map();
    throw error;
  }
  const out = new Map<string, Checks>();
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const checks = await readJsonFile(join(dir, name), ChecksSchema, "contradiction check");
    if (checks !== null) out.set(checks.runId, checks);
  }
  return out;
}

export type EngineLoad =
  { ok: true; engine: NliEngine; loadMs: number; dir: string } | { ok: false; reason: string; hint: string };

/** The model and runtime, from the configured directories; a reason and the fix when either is missing. */
export async function loadEngine(config: Config, env: DreamingEnv, paths: DreamingPaths): Promise<EngineLoad> {
  const dirs = modelDirs({ DREAMING_MODELS: env.DREAMING_MODELS }, paths.home, config.contradictions.modelDirs);
  const found = await findModel(dirs);
  if (found === null) {
    return {
      ok: false,
      reason: "the NLI model is not installed",
      hint: `dreaming models install downloads it (${(modelBytes(NLI_MODEL) / 1e6).toFixed(0)} MB, from huggingface.co)`,
    };
  }
  const loaded = await loadNliEngine(found.path);
  if (!loaded.ok)
    return { ok: false, reason: loaded.reason, hint: "npm install --include=optional installs the runtime" };
  return { ok: true, engine: loaded.engine, loadMs: loaded.loadMs, dir: found.dir };
}
