import type { EditedContent } from "../apply/plan.js";
import type { StoredProposal } from "../inbox/schema.js";
import { memoryFields, parseMemoryDocument, renderWithRawFrontmatter } from "../memory/frontmatter.js";
import { MemoryNameSchema, MemoryTypeSchema } from "../proposals/schema.js";
import { isPlainText } from "../text.js";

/**
 * Validate a memory file a person edited during review. The same limits apply
 * as to agent output, except that the text is trusted to be what they meant.
 * An update cannot rename its target; an add may be renamed (and so moves to
 * a new file).
 */
export function parseEditedMemory(
  text: string,
  proposal: StoredProposal,
): { ok: true; edit: EditedContent } | { ok: false; errors: string[] } {
  const parsed = parseMemoryDocument(text);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  const { frontmatter, rawFrontmatter, body } = parsed.doc;
  const fields = memoryFields(frontmatter);
  const errors: string[] = [];

  let file = proposal.file;
  if (proposal.action === "add") {
    const name = MemoryNameSchema.safeParse(fields.name);
    if (name.success) file = `${name.data}.md`;
    else errors.push("name: must be a kebab-case slug such as 'prefer-small-prs'");
  } else if (fields.name !== undefined && fields.name !== proposal.name) {
    errors.push(`name: an update cannot rename the memory (expected '${proposal.name}')`);
  }

  const description = fields.description?.trim() ?? "";
  if (description === "" || description.length > 200 || /[\r\n]/.test(description) || !isPlainText(description)) {
    errors.push("description: must be a single line of 1-200 characters with no control or invisible characters");
  }
  if (!MemoryTypeSchema.safeParse(fields.type).success) {
    errors.push(`type: must be one of ${MemoryTypeSchema.options.join(", ")}`);
  }
  const trimmedBody = body.trim();
  if (trimmedBody === "" || trimmedBody.length > 4000 || !isPlainText(trimmedBody)) {
    errors.push("body: must be 1-4000 characters with no control or invisible characters");
  }

  if (errors.length > 0) return { ok: false, errors };
  // Keep the frontmatter exactly as the person wrote it.
  return { ok: true, edit: { file, content: renderWithRawFrontmatter(rawFrontmatter, body), description } };
}
