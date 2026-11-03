import type { DreamingPaths } from "../config.js";
import { loadChecks, memoryHash, readMemoryFiles, type ProposalCheck } from "../contradict/store.js";
import { latestByProposal, loadEvals, type EvalRecord } from "../eval/record.js";
import { summarise, type EvalSummary } from "../eval/summary.js";
import type { PendingProposal } from "../inbox/store.js";

/**
 * What dreaming knows about a proposal beyond its own evidence: whether it was
 * measured (`dreaming eval`) and what the contradiction check found
 * (`dreaming check`). Both are read from files; nothing is computed or
 * downloaded when the review starts.
 */

export interface Measured {
  record: EvalRecord;
  summary: EvalSummary;
}

export type Contradictions =
  { state: "checked"; check: ProposalCheck; checkedAt: string; stale: boolean } | { state: "unchecked" };

export interface Insight {
  measured: Measured | null;
  contradictions: Contradictions;
}

export const NO_INSIGHT: Insight = { measured: null, contradictions: { state: "unchecked" } };

export const insightKey = (runId: string, proposalId: string): string => `${runId}/${proposalId}`;

export async function loadInsights(
  paths: DreamingPaths,
  memoryDir: string,
  pending: readonly PendingProposal[],
): Promise<Map<string, Insight>> {
  const evals = latestByProposal(await loadEvals(paths.evals));
  const checks = await loadChecks(paths.checks);
  const currentHash = memoryHash(await readMemoryFiles(memoryDir));
  const insights = new Map<string, Insight>();
  for (const { run, proposal } of pending) {
    const key = insightKey(run.runId, proposal.id);
    const record = evals.get(key);
    const runChecks = checks.get(run.runId);
    const check = runChecks?.proposals.find((p) => p.proposalId === proposal.id);
    insights.set(key, {
      measured:
        record === undefined
          ? null
          : {
              record,
              summary: summarise(
                record.runs,
                record.suite.tasks.map((t) => t.id),
                record.plan.seed,
              ),
            },
      contradictions:
        runChecks === undefined || check === undefined
          ? { state: "unchecked" }
          : { state: "checked", check, checkedAt: runChecks.checkedAt, stale: runChecks.memoryHash !== currentHash },
    });
  }
  return insights;
}
