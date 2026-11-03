import { join } from "node:path";
import { readAudit, type AuditEntry } from "./audit.js";
import { DreamingError } from "./errors.js";
import { readTextIfExists, sha256 } from "./fsx.js";
import type { SessionRef, StoredEvidence } from "./inbox/schema.js";
import { memoryFields, parseMemoryDocument } from "./memory/frontmatter.js";
import { snapshotMemory } from "./memory/snapshot.js";
import { verifyQuote } from "./proposals/verify.js";
import type { Redactor } from "./redact.js";
import { truncateMessage, type SessionDigest } from "./transcripts/digest.js";
import { parseTranscript } from "./transcripts/parse.js";

/**
 * Provenance for one memory: every change dreaming made to it, with the
 * evidence behind each, re-checked now against the transcripts it came from.
 * The audit log is the source; nothing here depends on the inbox still
 * existing.
 */

export type Recheck =
  /** The cited line still holds a message containing the quote. */
  | { kind: "still-there" }
  /** The transcript exists but that line no longer supports the quote. */
  | { kind: "changed" }
  /** The transcript file is gone. */
  | { kind: "transcript-gone" }
  /** No line was recorded (the quote never verified), so there is nothing to re-check. */
  | { kind: "not-checkable" };

export interface CheckedEvidence {
  evidence: StoredEvidence;
  session: SessionRef | undefined;
  recheck: Recheck;
}

export interface Provenance {
  file: string;
  memoryDir: string;
  exists: boolean;
  /** From the file as it is now. */
  description: string | undefined;
  /** What dreaming last wrote, for when the file no longer says it. */
  lastDescription: string | undefined;
  type: string | undefined;
  /** How the file on disk relates to the last change dreaming made. */
  state: "matches" | "changed-since" | "deleted-by-dreaming" | "removed-since" | "no-history";
  history: { entry: AuditEntry; evidence: CheckedEvidence[] }[];
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Find the memory file a person means: a file name, a file name without .md, or a frontmatter name. */
async function resolveFile(memoryDir: string, query: string, entries: readonly AuditEntry[]): Promise<string> {
  if (!NAME.test(query) || query.includes("..")) {
    throw new DreamingError(`not a memory name: ${query}`, {
      hint: "Use a file name such as prefer-pnpm or prefer-pnpm.md.",
    });
  }
  const file = query.endsWith(".md") ? query : `${query}.md`;
  const snapshot = await snapshotMemory(memoryDir);
  if (snapshot.entries.has(file) || entries.some((e) => e.file === file)) return file;
  const byName = [...snapshot.entries.values()].find((entry) => entry.name === query);
  if (byName) return byName.file;
  throw new DreamingError(`no memory named ${query} in ${memoryDir}, and nothing about it in the audit log`, {
    hint: "List the memory directory to see the names, or check the spelling.",
  });
}

async function recheck(evidence: StoredEvidence, session: SessionRef | undefined, redact: Redactor): Promise<Recheck> {
  if (session === undefined || evidence.line === undefined) return { kind: "not-checkable" };
  const content = await readTextIfExists(session.path);
  if (content === null) return { kind: "transcript-gone" };
  const message = parseTranscript(content).messages.find((m) => m.line === evidence.line);
  if (message === undefined) return { kind: "changed" };
  // Prepare the text exactly as the dream did, then check the stored quote against it.
  const text = redact(truncateMessage(message.text)).text;
  const digest: SessionDigest = {
    ref: session.ref,
    sessionId: session.sessionId,
    path: session.path,
    project: session.project,
    cwd: session.cwd,
    firstLine: message.line,
    lastLine: message.line,
    messages: [{ index: 1, line: message.line, role: message.role, timestamp: message.timestamp, text }],
    omittedMessages: 0,
    malformedLines: [],
    redactions: 0,
    continued: false,
    firstTimestamp: message.timestamp,
    lastTimestamp: message.timestamp,
  };
  return verifyQuote(evidence.quote, digest).status === "verified" ? { kind: "still-there" } : { kind: "changed" };
}

export async function provenance(
  memoryDir: string,
  auditLog: string,
  query: string,
  redact: Redactor,
): Promise<Provenance> {
  const all = (await readAudit(auditLog)).filter((entry) => entry.memoryDir === memoryDir);
  const file = await resolveFile(memoryDir, query, all);
  const entries = all.filter((entry) => entry.file === file);

  const text = await readTextIfExists(join(memoryDir, file));
  const parsed = text === null ? null : parseMemoryDocument(text);
  const fields = parsed?.ok === true ? memoryFields(parsed.doc.frontmatter) : undefined;

  const last = entries.at(-1);
  let state: Provenance["state"];
  if (last === undefined) state = "no-history";
  else if (last.action === "delete") state = text === null ? "deleted-by-dreaming" : "changed-since";
  else if (text === null) state = "removed-since";
  else state = sha256(text) === last.afterHash ? "matches" : "changed-since";

  const history = [];
  for (const entry of entries) {
    const evidence: CheckedEvidence[] = [];
    for (const item of entry.evidence) {
      const session = entry.sessions.find((s) => s.ref === item.session);
      evidence.push({ evidence: item, session, recheck: await recheck(item, session, redact) });
    }
    history.push({ entry, evidence });
  }

  return {
    file,
    memoryDir,
    exists: text !== null,
    description: fields?.description,
    lastDescription: entries.findLast((e) => e.description !== undefined)?.description,
    type: fields?.type ?? entries.findLast((e) => e.type !== undefined)?.type,
    state,
    history,
  };
}
