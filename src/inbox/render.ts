import { quoteDiffersFromSource } from "../proposals/verify.js";
import type { RunRecord, StoredEvidence, StoredProposal } from "./schema.js";

/**
 * Markdown view of a run, for reading in an editor or a Markdown previewer.
 * Everything the agent wrote is inert: multi-line text goes in code fences
 * longer than any backtick run inside it, and single-line fields have
 * Markdown and HTML metacharacters escaped. A previewer therefore never
 * renders agent-supplied links, images or HTML (an image URL would otherwise
 * be fetched just by opening the file).
 */

function fenced(text: string, info = "text"): string {
  const longestRun = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = "`".repeat(longestRun + 1);
  return `${marks}${info}\n${text}\n${marks}`;
}

/** Keep single-line fields single-line and free of Markdown/HTML syntax. */
function inline(text: string): string {
  return text.replace(/\s+/g, " ").replace(/([\\`*_[\]()<>!#|~&])/g, "\\$1");
}

const STATUS_LABEL: Record<StoredEvidence["status"], string> = {
  verified: "verified",
  "not-found": "NOT FOUND in the session",
  "unknown-session": "UNKNOWN session ref",
};

function renderEvidence(record: RunRecord, evidence: StoredEvidence): string {
  const session = record.sessions.find((s) => s.ref === evidence.session);
  const parts = [`**${inline(evidence.session)}**`];
  if (session) parts.push(inline(session.cwd ?? session.project), `session ${inline(session.sessionId)}`);
  if (evidence.line !== undefined) parts.push(`line ${evidence.line}`);
  parts.push(STATUS_LABEL[evidence.status]);
  const lines = [parts.join(" · "), ""];
  if (evidence.source === undefined) {
    lines.push(fenced(evidence.quote), "");
  } else {
    lines.push("Transcript text:", "", fenced(evidence.source), "");
    if (quoteDiffersFromSource(evidence.quote, evidence.source)) {
      lines.push("Quoted by the agent as:", "", fenced(evidence.quote), "");
    }
  }
  return lines.join("\n");
}

function renderProposal(record: RunRecord, proposal: StoredProposal, index: number): string {
  const lines = [
    `## ${index + 1}. ${proposal.action} \`${proposal.file}\` (${proposal.status})`,
    "",
    `- Proposal id: \`${proposal.id}\``,
    `- Confidence: ${proposal.confidence}`,
  ];
  if (proposal.action !== "delete") {
    lines.push(`- Type: ${proposal.type}`, `- Description: ${inline(proposal.description)}`);
  }
  const unverified = proposal.evidence.filter((e) => e.status !== "verified").length;
  const problems = [...proposal.problems];
  if (unverified > 0) {
    problems.unshift(
      `${unverified} of ${proposal.evidence.length} evidence quotes could not be found in the cited session`,
    );
  }
  for (const problem of problems) lines.push(`- **Problem:** ${inline(problem)}`);
  lines.push("", "**Why**", "", fenced(proposal.reason), "", "**Evidence**", "");
  lines.push(...proposal.evidence.map((e) => renderEvidence(record, e)));
  if (proposal.action !== "delete") {
    lines.push("**Proposed body**", "", fenced(proposal.body, "markdown"), "");
  }
  return lines.join("\n");
}

export function renderRunMarkdown(record: RunRecord): string {
  const pending = record.proposals.filter((p) => p.status === "pending").length;
  const lines = [
    `# Dream ${record.runId}`,
    "",
    fenced(record.summary),
    "",
    `- Created: ${record.createdAt}`,
    `- Memory directory: ${inline(record.memoryDir)}`,
    `- Sessions read: ${record.sessions.length}`,
    `- Proposals: ${record.proposals.length} (${pending} pending)`,
    `- Secrets redacted: ${record.redactions}${record.replyRedactions ? ` (${record.replyRedactions} from the agent's reply)` : ""}`,
    "",
    "Agent command (the prompt goes in on stdin):",
    "",
    fenced(record.agent.command.join(" "), "sh"),
    "",
    "Review with `dreaming review`. This file is a view of the JSON next to it; edits here are not read back.",
    "",
  ];
  if (record.sessions.length > 0) {
    lines.push("## Sessions", "");
    for (const s of record.sessions) {
      const malformed = s.malformedLines > 0 ? `, ${s.malformedLines} malformed lines skipped` : "";
      lines.push(
        `- **${inline(s.ref)}** ${inline(s.cwd ?? s.project)}: session ${inline(s.sessionId)}, lines ${s.firstLine}-${s.lastLine}, ${s.messages} messages${malformed}`,
      );
    }
    lines.push("");
  }
  if (record.skipped.length > 0) {
    lines.push("## Not read this time", "");
    for (const s of record.skipped) lines.push(`- ${inline(s.path)}: ${s.reason} (${inline(s.detail)})`);
    lines.push("");
  }
  record.proposals.forEach((proposal, i) => lines.push(renderProposal(record, proposal, i)));
  return `${lines.join("\n").trimEnd()}\n`;
}
