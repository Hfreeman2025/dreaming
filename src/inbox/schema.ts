import { z } from "zod";
import { ConfidenceSchema, MemoryFileSchema, MemoryTypeSchema } from "../proposals/schema.js";
import { isPlainText } from "../text.js";

/**
 * The inbox: one JSON file per dream run (the source of truth) plus a
 * Markdown rendering for reading. Files are re-validated whenever they are
 * read, since a person may edit or copy them by hand.
 */

export const QuoteStatusSchema = z.enum(["verified", "not-found", "unknown-session"]);
export const ProposalStatusSchema = z.enum(["pending", "rejected", "applied"]);

export const StoredEvidenceSchema = z.strictObject({
  session: z.string(),
  quote: z.string(),
  status: QuoteStatusSchema,
  /** Transcript line where a verified quote was found. */
  line: z.number().int().positive().optional(),
  /** The transcript's own text for the matched span (shown instead of the agent's rendering). */
  source: z.string().optional(),
});

const base = {
  id: z.string().min(1),
  file: MemoryFileSchema,
  /** The memory's name: the new slug for an add, the existing name otherwise. */
  name: z.string().min(1),
  reason: z.string(),
  confidence: ConfidenceSchema,
  evidence: z.array(StoredEvidenceSchema).min(1),
  /** sha256 of the target file when the agent read it; null for an add. */
  baseHash: z.string().nullable(),
  /** Problems with the target found when the proposal was filed (review re-checks live). */
  problems: z.array(z.string()),
  status: ProposalStatusSchema,
  decidedAt: z.string().optional(),
};

/** Text that will be written into memory; re-checked here in case the file was edited by hand. */
const memoryText = z.string().min(1).refine(isPlainText, "must not contain control or invisible formatting characters");

const content = {
  description: memoryText,
  type: MemoryTypeSchema,
  body: memoryText,
};

export const StoredProposalSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("add"), ...content, ...base }),
  z.strictObject({ action: z.literal("update"), ...content, ...base }),
  z.strictObject({ action: z.literal("delete"), ...base }),
]);

export const SessionRefSchema = z.strictObject({
  ref: z.string(),
  sessionId: z.string(),
  path: z.string(),
  project: z.string(),
  cwd: z.string().optional(),
  firstLine: z.number().int(),
  lastLine: z.number().int(),
  messages: z.number().int(),
  omittedMessages: z.number().int(),
  malformedLines: z.number().int(),
  firstTimestamp: z.string().optional(),
  lastTimestamp: z.string().optional(),
});

export const RunRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().regex(/^\d{8}-\d{6}-[0-9a-f]{4}$/),
  createdAt: z.string(),
  memoryDir: z.string(),
  agent: z.strictObject({
    kind: z.string(),
    /** The exact argv dreaming ran (the prompt goes in on stdin). */
    command: z.array(z.string()),
    durationMs: z.number().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
    turns: z.number().int().nonnegative().optional(),
  }),
  summary: z.string(),
  sessions: z.array(SessionRefSchema),
  skipped: z.array(
    z.strictObject({
      path: z.string(),
      reason: z.enum(["active", "deferred", "too-large", "self", "empty"]),
      detail: z.string(),
    }),
  ),
  /** Every secret redacted: from the transcripts before the agent saw them, and from its reply. */
  redactions: z.number().int().nonnegative(),
  /** How many of those were in the agent's reply (absent in records from before it was counted). */
  replyRedactions: z.number().int().nonnegative().optional(),
  proposals: z.array(StoredProposalSchema),
});

export type StoredProposal = z.infer<typeof StoredProposalSchema>;
export type StoredEvidence = z.infer<typeof StoredEvidenceSchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
export type SessionRef = z.infer<typeof SessionRefSchema>;
export type SkippedEntry = RunRecord["skipped"][number];
