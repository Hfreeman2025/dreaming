import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { SkippedEntry } from "../inbox/schema.js";
import type { Redactor } from "../redact.js";
import type { SessionMark } from "../state.js";
import { buildDigest, type SessionDigest } from "../transcripts/digest.js";
import type { SelectedTranscript } from "../transcripts/discover.js";
import { parseTranscript } from "../transcripts/parse.js";

export interface PreparedSessions {
  digests: SessionDigest[];
  skipped: SkippedEntry[];
  /** Watermark entries to record once the run succeeds. */
  marks: Record<string, SessionMark>;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Read and digest the selected transcripts. Sessions that ran inside the
 * dreaming home (dreaming's own agent runs) and sessions with no readable
 * messages are skipped, reported, and still marked as read so they are not
 * reconsidered every night.
 */
export async function prepareSessions(
  selected: readonly SelectedTranscript[],
  options: { dreamingHome: string; maxChars: number; redact: Redactor; nowIso: string },
): Promise<PreparedSessions> {
  const homes = [options.dreamingHome, await realpath(options.dreamingHome)];
  const result: PreparedSessions = { digests: [], skipped: [], marks: {} };

  for (const file of selected) {
    const content = await readFile(file.path, "utf8");
    let parsed = parseTranscript(content, file.fromLine);
    let fromLine = file.fromLine;
    if (parsed.totalLines < file.fromLine) {
      // The file shrank, so it was rewritten rather than appended to: read it all.
      fromLine = 0;
      parsed = parseTranscript(content, 0);
    }
    result.marks[file.path] = { mtimeMs: file.mtimeMs, lines: parsed.totalLines, dreamtAt: options.nowIso };

    const cwd = parsed.cwd;
    if (cwd !== undefined && homes.some((home) => isInside(cwd, home))) {
      result.skipped.push({ path: file.path, reason: "self", detail: "a dreaming agent session; never dreamt over" });
      continue;
    }
    if (parsed.messages.length === 0) {
      const malformed = parsed.malformedLines.length;
      result.skipped.push({
        path: file.path,
        reason: "empty",
        detail:
          malformed > 0
            ? `no readable messages; ${malformed} malformed lines`
            : "no user or assistant messages in the new lines",
      });
      continue;
    }
    const ref = `S${result.digests.length + 1}`;
    result.digests.push(
      buildDigest(ref, { ...file, fromLine }, parsed, { maxChars: options.maxChars, redact: options.redact }),
    );
  }
  return result;
}
