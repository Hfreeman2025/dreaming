import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DreamingError } from "../errors.js";
import { fileKind, sha256 } from "../fsx.js";
import type { SessionRef, StoredProposal } from "../inbox/schema.js";
import { renderNewMemory, updateMemoryText } from "../memory/frontmatter.js";
import { INDEX_FILE, removePointers, upsertPointer } from "../memory/index-file.js";

/**
 * Planning is pure with respect to the memory directory: it reads the current
 * files, works out the exact content every touched file will have, and
 * reports conflicts. Nothing is written. The diff shown in review and in
 * `--dry-run` is rendered from this plan, and execution writes exactly it.
 *
 * Re-applying is idempotent by construction: a proposal whose result is
 * already on disk plans as "already-applied" and changes nothing.
 */

export interface EditedContent {
  /** File name, which changes if an add was renamed during review. */
  file: string;
  /** Complete, validated file content. */
  content: string;
  description: string;
}

export interface ApprovedChange {
  runId: string;
  proposal: StoredProposal;
  edit?: EditedContent;
  /** The run's sessions, so the audit log can record where the evidence came from. */
  sessions?: readonly SessionRef[];
}

export interface FileChange {
  file: string;
  before: string | null;
  after: string | null;
}

export interface PlannedOutcome {
  change: ApprovedChange;
  file: string;
  result: "change" | "already-applied";
  beforeHash: string | null;
  afterHash: string | null;
}

export interface Conflict {
  proposalId: string;
  message: string;
}

export interface ApplyPlan {
  memoryDir: string;
  /** Memory files first, the index last. Only files whose content changes. */
  files: FileChange[];
  outcomes: PlannedOutcome[];
}

export type PlanResult = { ok: true; plan: ApplyPlan } | { ok: false; conflicts: Conflict[] };

const hashOf = (content: string | null): string | null => (content === null ? null : sha256(content));

export function targetFile(change: ApprovedChange): string {
  return change.edit?.file ?? change.proposal.file;
}

/**
 * The content a proposal produces, given the target's current content: the
 * file text for an add or update, `null` for a delete, or an error when an
 * existing file cannot be updated safely.
 */
export function proposedContent(
  proposal: StoredProposal,
  current: string | null,
): { ok: true; content: string | null } | { ok: false; error: string } {
  if (proposal.action === "delete") return { ok: true, content: null };
  if (proposal.action === "add" || current === null) return { ok: true, content: renderNewMemory(proposal) };
  const updated = updateMemoryText(current, proposal);
  return updated.ok ? { ok: true, content: updated.text } : updated;
}

class VirtualDir {
  private readonly original = new Map<string, string | null>();
  private readonly current = new Map<string, string | null>();

  constructor(private readonly dir: string) {}

  async read(file: string): Promise<string | null> {
    if (!this.original.has(file)) {
      const path = join(this.dir, file);
      const kind = await fileKind(path);
      if (kind !== "missing" && kind !== "file") {
        throw new DreamingError(`${path} is a ${kind}; dreaming only edits regular files`);
      }
      const content = kind === "missing" ? null : await readFile(path, "utf8");
      this.original.set(file, content);
      this.current.set(file, content);
    }
    return this.current.get(file) ?? null;
  }

  write(file: string, content: string | null): void {
    this.current.set(file, content);
  }

  changes(): FileChange[] {
    const files = [...this.current.keys()].filter((file) => this.current.get(file) !== this.original.get(file));
    files.sort((a, b) => Number(a === INDEX_FILE) - Number(b === INDEX_FILE) || a.localeCompare(b));
    return files.map((file) => ({
      file,
      before: this.original.get(file) ?? null,
      after: this.current.get(file) ?? null,
    }));
  }
}

export async function planApply(memoryDir: string, changes: readonly ApprovedChange[]): Promise<PlanResult> {
  if ((await fileKind(memoryDir)) !== "directory") {
    throw new DreamingError(`memory directory not found: ${memoryDir}`);
  }
  const vdir = new VirtualDir(memoryDir);
  const outcomes: PlannedOutcome[] = [];
  const conflicts: Conflict[] = [];

  for (const change of changes) {
    const { proposal } = change;
    const file = targetFile(change);
    const conflict = (message: string) => conflicts.push({ proposalId: proposal.id, message });
    const current = await vdir.read(file);
    const proposed = change.edit
      ? { ok: true as const, content: change.edit.content }
      : proposedContent(proposal, current);
    if (!proposed.ok) {
      conflict(`${file} cannot be updated: ${proposed.error}`);
      continue;
    }
    const desired = proposed.content;
    const outcome = (result: PlannedOutcome["result"]) =>
      outcomes.push({ change, file, result, beforeHash: hashOf(current), afterHash: hashOf(desired) });

    if (desired === current) {
      outcome("already-applied");
    } else if (proposal.action === "add" && current !== null) {
      conflict(`${file} already exists with different content`);
      continue;
    } else if (proposal.action !== "add" && current === null) {
      conflict(`${file} no longer exists`);
      continue;
    } else if (proposal.action !== "add" && hashOf(current) !== proposal.baseHash) {
      conflict(`${file} has changed since this proposal was made; re-run dreaming to get a fresh proposal`);
      continue;
    } else {
      vdir.write(file, desired);
      outcome("change");
    }

    const index = (await vdir.read(INDEX_FILE)) ?? "";
    if (proposal.action === "delete") {
      if (index !== "") vdir.write(INDEX_FILE, removePointers(index, file));
    } else {
      const description = change.edit?.description ?? proposal.description;
      const name = file.replace(/\.md$/, "");
      vdir.write(INDEX_FILE, upsertPointer(index, file, name, description));
    }
  }

  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, plan: { memoryDir, files: vdir.changes(), outcomes } };
}
