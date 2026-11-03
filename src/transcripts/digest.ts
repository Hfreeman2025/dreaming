import type { Redactor } from "../redact.js";
import type { SelectedTranscript } from "./discover.js";
import type { ParsedTranscript, TranscriptMessage } from "./parse.js";

/**
 * A session digest is the text the agent reads instead of the raw JSONL: one
 * block per message, redacted, with long messages truncated and long sessions
 * trimmed from the middle. Evidence quotes are verified against exactly these
 * message texts, so what the agent saw and what is checked are the same.
 */

export const MAX_MESSAGE_CHARS = 4000;
/** Claude Code's Read tool truncates lines longer than 2000 characters. */
const WRAP_WIDTH = 1000;
/** Share of the budget kept from the start of a session; the rest comes from the end. */
const HEAD_SHARE = 0.3;

export interface DigestMessage {
  /** 1-based position among the session's messages; gaps mark omitted messages. */
  index: number;
  line: number;
  role: "user" | "assistant";
  timestamp: string | undefined;
  text: string;
}

export interface SessionDigest {
  ref: string;
  sessionId: string;
  path: string;
  project: string;
  cwd: string | undefined;
  /** 1-based line range of the transcript this digest covers. */
  firstLine: number;
  lastLine: number;
  messages: DigestMessage[];
  omittedMessages: number;
  malformedLines: number[];
  redactions: number;
  continued: boolean;
  firstTimestamp: string | undefined;
  lastTimestamp: string | undefined;
}

export function truncateMessage(text: string, max = MAX_MESSAGE_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... ${text.length - max} more characters truncated]`;
}

/**
 * Keep whole messages within `budget` characters: the first ones up to 30% of
 * the budget, then as many of the most recent as fit. Returns the kept
 * messages in order and how many were dropped from the middle.
 */
export function fitToBudget<T extends { text: string }>(
  messages: readonly T[],
  budget: number,
): { kept: T[]; omitted: number } {
  const total = messages.reduce((sum, message) => sum + message.text.length, 0);
  if (total <= budget) return { kept: [...messages], omitted: 0 };

  const head: T[] = [];
  let used = 0;
  for (const message of messages) {
    if (used + message.text.length > budget * HEAD_SHARE) break;
    head.push(message);
    used += message.text.length;
  }
  const tail: T[] = [];
  for (let i = messages.length - 1; i >= head.length; i -= 1) {
    const message = messages[i];
    if (message === undefined || used + message.text.length > budget) break;
    tail.unshift(message);
    used += message.text.length;
  }
  return { kept: [...head, ...tail], omitted: messages.length - head.length - tail.length };
}

export function buildDigest(
  ref: string,
  file: SelectedTranscript,
  parsed: ParsedTranscript,
  options: { maxChars: number; redact: Redactor },
): SessionDigest {
  let redactions = 0;
  const prepared = parsed.messages.map((message: TranscriptMessage, i) => {
    const redacted = options.redact(truncateMessage(message.text));
    redactions += redacted.count;
    return { ...message, index: i + 1, text: redacted.text };
  });
  const { kept, omitted } = fitToBudget(prepared, options.maxChars);
  return {
    ref,
    sessionId: file.sessionId,
    path: file.path,
    project: file.project,
    cwd: parsed.cwd,
    firstLine: file.fromLine + 1,
    lastLine: parsed.totalLines,
    messages: kept.map((message) => ({
      index: message.index,
      line: message.line,
      role: message.role,
      timestamp: message.timestamp,
      text: message.text,
    })),
    omittedMessages: omitted,
    malformedLines: parsed.malformedLines,
    redactions,
    continued: file.fromLine > 0,
    firstTimestamp: parsed.messages[0]?.timestamp,
    lastTimestamp: parsed.messages.at(-1)?.timestamp,
  };
}

/**
 * Break lines longer than `width` at spaces so a file-reading tool shows all
 * of them. Only a space is ever replaced (by a newline), and quote matching
 * treats all whitespace alike, so wrapping cannot change what verifies.
 */
export function softWrap(text: string, width = WRAP_WIDTH): string {
  return text
    .split("\n")
    .map((line) => {
      const pieces: string[] = [];
      let rest = line;
      while (rest.length > width) {
        const at = rest.lastIndexOf(" ", width);
        if (at <= 0) break; // one unbroken word longer than the width: leave it
        pieces.push(rest.slice(0, at));
        rest = rest.slice(at + 1);
      }
      pieces.push(rest);
      return pieces.join("\n");
    })
    .join("\n");
}

export function renderDigest(digest: SessionDigest): string {
  const lines = [
    `# Session ${digest.ref}`,
    "",
    `- Project: ${digest.cwd ?? digest.project}`,
    `- Session id: ${digest.sessionId}`,
    `- Transcript lines: ${digest.firstLine}-${digest.lastLine}`,
    `- Messages shown: ${digest.messages.length}` +
      (digest.omittedMessages > 0 ? ` (${digest.omittedMessages} omitted from the middle to fit the budget)` : ""),
  ];
  if (digest.malformedLines.length > 0) {
    lines.push(`- Unreadable transcript lines skipped: ${digest.malformedLines.join(", ")}`);
  }
  if (digest.continued) {
    lines.push("- This session was dreamt over before; only the messages added since then are shown.");
  }
  lines.push("", "---", "");
  let previousIndex = 0;
  for (const message of digest.messages) {
    if (message.index !== previousIndex + 1) {
      lines.push(`[... ${message.index - previousIndex - 1} messages omitted ...]`, "");
    }
    previousIndex = message.index;
    lines.push(`## [${message.index}] ${message.role}${message.timestamp ? ` · ${message.timestamp}` : ""}`);
    lines.push("", softWrap(message.text), "");
  }
  return lines.join("\n");
}
