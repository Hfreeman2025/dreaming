import type { StoredEvidence, StoredProposal } from "../inbox/schema.js";
import type { MemorySnapshot } from "../memory/snapshot.js";
import type { Redactor } from "../redact.js";
import type { SessionDigest } from "../transcripts/digest.js";
import type { DreamOutput, Proposal } from "./schema.js";
import { verifyQuote } from "./verify.js";

/**
 * Turn schema-valid agent output into inbox proposals: verify every evidence
 * quote against the session it cites, note problems against the memory
 * snapshot the agent saw, and redact every agent-written string. Nothing is
 * dropped here; problems are recorded so the reviewer sees them.
 */

export interface CheckContext {
  runId: string;
  digests: ReadonlyMap<string, SessionDigest>;
  snapshot: MemorySnapshot;
  redact: Redactor;
}

export interface CheckedOutput {
  summary: string;
  proposals: StoredProposal[];
  redactions: number;
}

function stem(file: string): string {
  return file.replace(/\.md$/, "");
}

export function checkOutput(output: DreamOutput, ctx: CheckContext): CheckedOutput {
  let redactions = 0;
  const clean = (text: string): string => {
    const result = ctx.redact(text);
    redactions += result.count;
    return result.text;
  };

  const proposals = output.proposals.map((proposal: Proposal, i): StoredProposal => {
    const evidence: StoredEvidence[] = proposal.evidence.map((item) => {
      // Verify the quote as the agent wrote it, then redact what is stored.
      const check = verifyQuote(item.quote, ctx.digests.get(item.session));
      return {
        session: item.session,
        quote: clean(item.quote),
        status: check.status,
        line: check.line,
        source: check.source === undefined ? undefined : clean(check.source),
      };
    });
    const problems: string[] = [];
    const shared = {
      id: `${ctx.runId}-${i + 1}`,
      reason: clean(proposal.reason),
      confidence: proposal.confidence,
      evidence,
      status: "pending" as const,
    };

    if (proposal.action === "add") {
      const file = `${proposal.name}.md`;
      if (ctx.snapshot.entries.has(file)) {
        problems.push(`${file} already exists; an existing memory should be changed with an update`);
      }
      return {
        action: "add",
        file,
        name: proposal.name,
        description: clean(proposal.description),
        type: proposal.type,
        body: clean(proposal.body),
        baseHash: null,
        problems,
        ...shared,
      };
    }

    const entry = ctx.snapshot.entries.get(proposal.target);
    if (entry === undefined) problems.push(`${proposal.target} does not exist in the memory directory`);
    const target = {
      file: proposal.target,
      name: entry?.name ?? stem(proposal.target),
      baseHash: entry?.hash ?? null,
    };
    if (proposal.action === "update") {
      return {
        action: "update",
        ...target,
        description: clean(proposal.description),
        type: proposal.type,
        body: clean(proposal.body),
        problems,
        ...shared,
      };
    }
    return { action: "delete", ...target, problems, ...shared };
  });

  return { summary: clean(output.summary), proposals, redactions };
}
