import { join } from "node:path";
import {
  planApply,
  proposedContent,
  targetFile,
  type ApplyPlan,
  type ApprovedChange,
  type Conflict,
  type EditedContent,
  type FileChange,
} from "../apply/plan.js";
import { readTextIfExists } from "../fsx.js";
import type { RunRecord, StoredProposal } from "../inbox/schema.js";
import type { PendingProposal } from "../inbox/store.js";
import { MARKERS } from "../redact.js";
import { insightKey, NO_INSIGHT, type Insight } from "./insight.js";
import { diffStats } from "./diff-view.js";

/**
 * The state of a review, independent of how it is shown. Decisions can be
 * made in any order and changed until the review is submitted; nothing is
 * written before that. Both front ends (the full-screen review and the plain
 * line-by-line one) drive this model, so the rules live in one place.
 */

export type Decision = "pending" | "approved" | "rejected" | "skipped";

export interface Assessment {
  /** What approving this proposal would change, on top of the other approvals. */
  files: FileChange[];
  /** Reasons approval is refused. */
  blockers: string[];
  /** Information that does not block approval. */
  notes: string[];
  added: number;
  removed: number;
}

export interface ReviewItem {
  run: RunRecord;
  proposal: StoredProposal;
  /** What `dreaming eval` measured and `dreaming check` found, if anything. */
  insight: Insight;
  decision: Decision;
  edit: EditedContent | undefined;
  /** An edit that failed validation, kept so the next edit starts from it. */
  draft: string | undefined;
}

export interface ReviewOptions {
  memoryDir: string;
  allowUnverified: boolean;
  /** By insightKey(runId, proposalId). */
  insights?: ReadonlyMap<string, Insight>;
}

export interface Submission {
  approved: ReviewItem[];
  rejected: ReviewItem[];
  plan: ApplyPlan | null;
  conflicts: Conflict[];
}

/** `full` relative to `baseline`: only what the last change adds. */
function incremental(baseline: ApplyPlan, full: ApplyPlan): FileChange[] {
  const after = new Map(baseline.files.map((f) => [f.file, f.after]));
  return full.files
    .map((f) => ({ ...f, before: after.has(f.file) ? (after.get(f.file) ?? null) : f.before }))
    .filter((f) => f.before !== f.after);
}

/** Redaction markers that approving would write into memory and that are not there already. */
function newMarkers(files: readonly FileChange[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    const before = new Set(file.before?.match(MARKERS) ?? []);
    for (const marker of file.after?.match(MARKERS) ?? []) if (!before.has(marker)) found.add(marker);
  }
  return [...found];
}

export class ReviewModel {
  readonly items: ReviewItem[];
  private readonly cache = new Map<number, Assessment>();

  constructor(
    pending: readonly PendingProposal[],
    readonly options: ReviewOptions,
  ) {
    this.items = pending.map(({ run, proposal }) => ({
      run,
      proposal,
      insight: options.insights?.get(insightKey(run.runId, proposal.id)) ?? NO_INSIGHT,
      decision: "pending",
      edit: undefined,
      draft: undefined,
    }));
  }

  get runs(): number {
    return new Set(this.items.map((item) => item.run.runId)).size;
  }

  count(decision: Decision): number {
    return this.items.filter((item) => item.decision === decision).length;
  }

  change(index: number): ApprovedChange {
    const item = this.item(index);
    return {
      runId: item.run.runId,
      proposal: item.proposal,
      sessions: item.run.sessions,
      ...(item.edit ? { edit: item.edit } : {}),
    };
  }

  item(index: number): ReviewItem {
    const item = this.items[index];
    if (item === undefined) throw new RangeError(`no proposal ${index}`);
    return item;
  }

  /** Approved changes in list order, optionally leaving one out. */
  private approvedChanges(except?: number): ApprovedChange[] {
    return this.items.flatMap((item, i) => (item.decision === "approved" && i !== except ? [this.change(i)] : []));
  }

  /**
   * What approving proposal `index` would do given every other approval:
   * its own diff, and anything that blocks it. Recomputed whenever any
   * decision or edit changes, since approvals can conflict with each other.
   */
  async assess(index: number): Promise<Assessment> {
    const cached = this.cache.get(index);
    if (cached) return cached;
    const item = this.item(index);
    const blockers: string[] = [];
    const notes: string[] = [];
    let files: FileChange[] = [];

    if (item.run.memoryDir !== this.options.memoryDir) {
      blockers.push(
        `this proposal was made for ${item.run.memoryDir}, but the config now points at ${this.options.memoryDir}`,
      );
    } else {
      const unverified = item.proposal.evidence.filter((e) => e.status !== "verified").length;
      if (unverified > 0 && !this.options.allowUnverified) {
        blockers.push(
          `${unverified} evidence quote${unverified === 1 ? "" : "s"} could not be found in the cited session (override with --allow-unverified)`,
        );
      } else if (unverified > 0) {
        notes.push(
          `${unverified} evidence quote${unverified === 1 ? " was" : "s were"} not found; approval allowed by --allow-unverified`,
        );
      }
      const others = this.approvedChanges(index);
      const full = await planApply(this.options.memoryDir, [...others, this.change(index)]);
      if (!full.ok) {
        blockers.push(...full.conflicts.filter((c) => c.proposalId === item.proposal.id).map((c) => c.message));
        if (blockers.length === 0) blockers.push(...full.conflicts.map((c) => c.message));
      } else {
        const baseline = await planApply(this.options.memoryDir, others);
        files = baseline.ok ? incremental(baseline.plan, full.plan) : full.plan.files;
        if (full.plan.outcomes.at(-1)?.result === "already-applied") {
          notes.push("memory already matches this proposal; approving records it as applied");
        }
        const verdict = item.insight.measured?.summary.verdict;
        if (verdict !== undefined && (verdict.kind === "hurts" || verdict.kind === "mixed")) {
          notes.push(`measured: this memory made ${verdict.worse.join(" and ")} worse (see Measured below)`);
        }
        const markers = newMarkers(files);
        if (markers.length > 0) {
          notes.push(
            `this would save ${markers.join(", ")} into memory, not the secret: it was redacted before the agent saw it. Edit it out, or reject.`,
          );
        }
      }
    }
    const assessment = { files, blockers, notes, ...diffStats(files) };
    this.cache.set(index, assessment);
    return assessment;
  }

  private changed(): void {
    this.cache.clear();
  }

  async approve(index: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { blockers } = await this.assess(index);
    if (blockers.length > 0) return { ok: false, reason: blockers.join("; ") };
    this.item(index).decision = "approved";
    this.changed();
    return { ok: true };
  }

  decide(index: number, decision: "rejected" | "skipped" | "pending"): void {
    this.item(index).decision = decision;
    this.changed();
  }

  setEdit(index: number, edit: EditedContent): void {
    const item = this.item(index);
    item.edit = edit;
    item.draft = undefined;
    this.changed();
  }

  /** The text an edit starts from: the last draft, the last edit, or the proposed file. */
  async editableText(index: number): Promise<string> {
    const item = this.item(index);
    if (item.draft !== undefined) return item.draft;
    if (item.edit !== undefined) return item.edit.content;
    const current = await readTextIfExists(join(this.options.memoryDir, item.proposal.file));
    const proposed = proposedContent(item.proposal, current);
    return proposed.ok ? (proposed.content ?? "") : "";
  }

  fileName(index: number): string {
    return targetFile(this.change(index));
  }

  /** The next undecided proposal after `index`, wrapping around; -1 if none. */
  nextPending(index: number): number {
    for (let step = 1; step <= this.items.length; step += 1) {
      const i = (index + step) % this.items.length;
      if (this.items[i]?.decision === "pending") return i;
    }
    return -1;
  }

  /** Everything approved, planned together, plus the rejections to record. */
  async submission(): Promise<Submission> {
    const approved = this.items.filter((item) => item.decision === "approved");
    const rejected = this.items.filter((item) => item.decision === "rejected");
    if (approved.length === 0) return { approved, rejected, plan: null, conflicts: [] };
    const result = await planApply(this.options.memoryDir, this.approvedChanges());
    return result.ok
      ? { approved, rejected, plan: result.plan, conflicts: [] }
      : { approved, rejected, plan: null, conflicts: result.conflicts };
  }
}

export type { RunRecord, StoredProposal };
