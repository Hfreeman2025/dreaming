import { readFile } from "node:fs/promises";
import { DreamingError } from "../errors.js";
import type { PendingProposal } from "../inbox/store.js";
import { dreamOutputJsonSchema, MAX_PROPOSALS } from "../proposals/schema.js";
import type { SessionDigest } from "../transcripts/digest.js";

const TEMPLATE_URL = new URL("../../prompts/dream.md", import.meta.url);

export async function loadPromptTemplate(): Promise<string> {
  return readFile(TEMPLATE_URL, "utf8");
}

/**
 * Fill `{{name}}` placeholders. Every placeholder must have a value and every
 * value must be used, so a renamed placeholder fails loudly instead of sending
 * the agent a prompt with a hole in it.
 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  const used = new Set<string>();
  const missing = new Set<string>();
  const filled = template.replace(/\{\{([a-zA-Z]+)\}\}/g, (placeholder, key: string) => {
    const value = values[key];
    if (value === undefined) {
      missing.add(key);
      return placeholder;
    }
    used.add(key);
    return value;
  });
  const unused = Object.keys(values).filter((key) => !used.has(key));
  if (missing.size > 0 || unused.length > 0) {
    throw new DreamingError(
      `prompt template mismatch: missing values for [${[...missing].join(", ")}], unused values [${unused.join(", ")}]`,
    );
  }
  return filled;
}

export function describeSession(digest: SessionDigest, file: string): string {
  const when = digest.lastTimestamp ? `, last message ${digest.lastTimestamp}` : "";
  return `  - ${digest.ref}: \`${file}\` (${digest.cwd ?? digest.project}, ${digest.messages.length} messages${when})`;
}

export function renderPending(pending: readonly PendingProposal[]): string {
  if (pending.length === 0) return "# Pending proposals\n\nNone.\n";
  const lines = ["# Pending proposals", "", "Already waiting for review. Do not propose these again.", ""];
  for (const { proposal } of pending) {
    const what = proposal.action === "delete" ? "" : `: ${proposal.description}`;
    lines.push(`- ${proposal.action} ${proposal.file}${what}`);
  }
  return `${lines.join("\n")}\n`;
}

export function buildPrompt(
  template: string,
  input: {
    today: string;
    memoryDir: string;
    pendingFile: string;
    sessions: readonly { digest: SessionDigest; file: string }[];
  },
): string {
  return fillTemplate(template, {
    today: input.today,
    memoryDir: input.memoryDir,
    pendingFile: input.pendingFile,
    maxProposals: String(MAX_PROPOSALS),
    schema: dreamOutputJsonSchema(),
    sessions: input.sessions.map(({ digest, file }) => describeSession(digest, file)).join("\n"),
  });
}
