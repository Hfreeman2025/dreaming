import { z } from "zod";
import type { ApplyPlan } from "./apply/plan.js";
import { DreamingError } from "./errors.js";
import { parseJson, readTextIfExists } from "./fsx.js";
import { SessionRefSchema, StoredEvidenceSchema } from "./inbox/schema.js";
import { ConfidenceSchema, MemoryFileSchema, MemoryTypeSchema } from "./proposals/schema.js";

/**
 * applied.jsonl: one line per applied proposal. Each line is self-contained
 * provenance (what changed, the hashes before and after, the reason, the
 * evidence and the sessions it came from), so `dreaming why` can answer
 * from the log alone even after inbox files are deleted.
 */

export const AuditEntrySchema = z.strictObject({
  at: z.string(),
  applyId: z.string(),
  runId: z.string(),
  proposalId: z.string(),
  action: z.enum(["add", "update", "delete"]),
  file: MemoryFileSchema,
  memoryDir: z.string(),
  result: z.enum(["change", "already-applied"]),
  edited: z.boolean(),
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
  description: z.string().optional(),
  type: MemoryTypeSchema.optional(),
  reason: z.string(),
  confidence: ConfidenceSchema,
  evidence: z.array(StoredEvidenceSchema),
  sessions: z.array(SessionRefSchema),
  backupDir: z.string(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export function auditLines(plan: ApplyPlan, ctx: { applyId: string; backupDir: string; now: Date }): string {
  return plan.outcomes
    .map((outcome): AuditEntry => {
      const { proposal, runId, edit, sessions = [] } = outcome.change;
      const cited = new Set(proposal.evidence.map((e) => e.session));
      return {
        at: ctx.now.toISOString(),
        applyId: ctx.applyId,
        runId,
        proposalId: proposal.id,
        action: proposal.action,
        file: outcome.file,
        memoryDir: plan.memoryDir,
        result: outcome.result,
        edited: edit !== undefined,
        beforeHash: outcome.beforeHash,
        afterHash: outcome.afterHash,
        ...(proposal.action === "delete"
          ? {}
          : { description: edit?.description ?? proposal.description, type: proposal.type }),
        reason: proposal.reason,
        confidence: proposal.confidence,
        evidence: proposal.evidence,
        sessions: sessions.filter((s) => cited.has(s.ref)),
        backupDir: ctx.backupDir,
      };
    })
    .map((entry) => `${JSON.stringify(entry)}\n`)
    .join("");
}

/** Every entry in the audit log, oldest first. A damaged line is an error naming it. */
export async function readAudit(path: string): Promise<AuditEntry[]> {
  const text = await readTextIfExists(path);
  if (text === null) return [];
  return text
    .split("\n")
    .map((line, i) => ({ line, number: i + 1 }))
    .filter(({ line }) => line.trim() !== "")
    .map(({ line, number }) => {
      const json = parseJson(line);
      const entry = json.ok ? AuditEntrySchema.safeParse(json.value) : null;
      if (!entry?.success) {
        throw new DreamingError(`audit log line ${number} is not a valid entry: ${path}`, {
          hint: "The audit log is append-only; restore that line from a backup or remove it by hand.",
        });
      }
      return entry.data;
    });
}
