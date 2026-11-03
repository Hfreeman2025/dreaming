import { z } from "zod";
import { isPlainText } from "../text.js";

/**
 * The contract between dreaming and the agent. Agent output is untrusted: it
 * decides which files may be written or deleted, so every field is bounded and
 * file names are restricted to plain names inside the memory directory.
 */

export const MAX_PROPOSALS = 25;
export const MAX_EVIDENCE = 5;
export const MIN_QUOTE_CHARS = 10;
export const MAX_QUOTE_CHARS = 500;

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1, "must not be empty")
    .max(max)
    .refine(isPlainText, "must not contain control or invisible formatting characters");

const singleLine = (max: number) => text(max).refine((value) => !/[\r\n]/.test(value), "must be a single line");

/** New memory names: lowercase kebab-case, which is also the file name stem. */
export const MemoryNameSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a kebab-case slug such as 'prefer-small-prs'")
  .max(64)
  // memory.md and MEMORY.md are the same file on case-insensitive filesystems (the macOS default).
  .refine((value) => value !== "memory", "'memory' is reserved: it would collide with MEMORY.md");

/**
 * An existing memory file, named relative to the memory directory. No paths,
 * no hidden files, and never the index itself.
 */
export const MemoryFileSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/, "must be a file name like 'some-memory.md' with no directory part")
  .refine((value) => value.toLowerCase() !== "memory.md", "MEMORY.md is the index and cannot be a target")
  .refine((value) => !value.includes(".."), "must not contain '..'");

export const MemoryTypeSchema = z.enum(["user", "feedback", "project", "reference"]);
export const ConfidenceSchema = z.enum(["low", "medium", "high"]);

export const EvidenceSchema = z.strictObject({
  session: z.string().regex(/^S[1-9]\d{0,2}$/, "must be a session ref such as S1"),
  quote: text(MAX_QUOTE_CHARS).refine(
    (value) => value.replace(/\s+/g, "").length >= MIN_QUOTE_CHARS,
    `must be at least ${MIN_QUOTE_CHARS} characters`,
  ),
});

const common = {
  reason: text(1000),
  evidence: z.array(EvidenceSchema).min(1, "needs at least one evidence quote").max(MAX_EVIDENCE),
  confidence: ConfidenceSchema,
};

const memoryFields = {
  description: singleLine(200),
  type: MemoryTypeSchema,
  body: text(4000),
};

export const AddProposalSchema = z.strictObject({
  action: z.literal("add"),
  name: MemoryNameSchema,
  ...memoryFields,
  ...common,
});

export const UpdateProposalSchema = z.strictObject({
  action: z.literal("update"),
  target: MemoryFileSchema,
  ...memoryFields,
  ...common,
});

export const DeleteProposalSchema = z.strictObject({
  action: z.literal("delete"),
  target: MemoryFileSchema,
  ...common,
});

export const ProposalSchema = z.discriminatedUnion("action", [
  AddProposalSchema,
  UpdateProposalSchema,
  DeleteProposalSchema,
]);

export const DreamOutputSchema = z.strictObject({
  summary: singleLine(300),
  proposals: z.array(ProposalSchema).max(MAX_PROPOSALS),
});

export type Proposal = z.infer<typeof ProposalSchema>;
export type DreamOutput = z.infer<typeof DreamOutputSchema>;
export type MemoryType = z.infer<typeof MemoryTypeSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;

/** JSON Schema for the prompt, generated from the same zod schema that validates. */
export function dreamOutputJsonSchema(): string {
  return JSON.stringify(z.toJSONSchema(DreamOutputSchema, { io: "input", unrepresentable: "any" }), null, 2);
}
