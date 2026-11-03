import { z } from "zod";
import { parseJson } from "../fsx.js";
import { stripControl } from "../text.js";

/**
 * Parser for Claude Code session transcripts (`~/.claude/projects/<project>/<session>.jsonl`).
 * Each line is one JSON entry. Only user and assistant messages matter here;
 * every other entry type is ignored. A line that is not JSON, or a message
 * entry with an unexpected shape, is counted as malformed rather than dropped
 * silently, so the run report can say how much of a transcript was unreadable.
 */

export interface TranscriptMessage {
  /** 1-based line number in the transcript file. */
  line: number;
  role: "user" | "assistant";
  timestamp: string | undefined;
  text: string;
}

export interface ParsedTranscript {
  /** Working directory of the session, if any entry recorded it. */
  cwd: string | undefined;
  messages: TranscriptMessage[];
  /** Number of complete lines (a line still being written is not counted). */
  totalLines: number;
  /** 1-based numbers of lines that could not be parsed. */
  malformedLines: number[];
}

const EntryHeader = z.looseObject({
  type: z.string(),
  cwd: z.string().optional(),
});

const MessageEntry = z.looseObject({
  type: z.enum(["user", "assistant"]),
  timestamp: z.string().optional(),
  isMeta: z.boolean().optional(),
  isSidechain: z.boolean().optional(),
  message: z.looseObject({
    content: z.union([z.string(), z.array(z.unknown())]),
  }),
});

const TextBlock = z.looseObject({ type: z.literal("text"), text: z.string() });
const ToolUseBlock = z.looseObject({
  type: z.literal("tool_use"),
  name: z.string(),
  input: z.unknown(),
});
const ToolInputSummary = z.looseObject({
  command: z.string().optional(),
  file_path: z.string().optional(),
  path: z.string().optional(),
  pattern: z.string().optional(),
  url: z.string().optional(),
  description: z.string().optional(),
});

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * Text the harness injected into a user turn (memory, reminders) is not
 * something the person said. Quoting it as evidence would let memory cite
 * itself, so it is removed before the agent sees the session.
 */
function cleanText(text: string): string {
  return stripControl(text.replace(SYSTEM_REMINDER, "")).trim();
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function summarizeToolUse(name: string, input: unknown): string {
  const parsed = ToolInputSummary.safeParse(input);
  const fields = parsed.success ? parsed.data : {};
  const detail =
    fields.command ?? fields.file_path ?? fields.path ?? fields.pattern ?? fields.url ?? fields.description;
  const safeName = oneLine(stripControl(name), 60);
  return detail === undefined ? `[tool: ${safeName}]` : `[tool: ${safeName}] ${oneLine(stripControl(detail), 160)}`;
}

function contentToText(content: string | unknown[]): string {
  if (typeof content === "string") return cleanText(content);
  const parts: string[] = [];
  for (const block of content) {
    const text = TextBlock.safeParse(block);
    if (text.success) {
      const cleaned = cleanText(text.data.text);
      if (cleaned !== "") parts.push(cleaned);
      continue;
    }
    const toolUse = ToolUseBlock.safeParse(block);
    if (toolUse.success) {
      parts.push(summarizeToolUse(toolUse.data.name, toolUse.data.input));
    }
    // tool_result, thinking, image and future block types carry no
    // conversational text worth quoting; they are intentionally left out.
  }
  return parts.join("\n");
}

/**
 * Split into complete lines. Claude Code ends every entry with a newline, so
 * text after the last newline is either a complete entry written without one
 * (it parses) or an entry still being written (it does not). The latter is
 * left out entirely: counting it as read would lose it once it is finished.
 */
function completeLines(content: string): string[] {
  const lines = content.split("\n");
  const tail = lines.pop() ?? "";
  if (tail.trim() !== "" && parseJson(tail).ok) lines.push(tail);
  return lines;
}

/**
 * Parse a transcript. Lines before `fromLine` (0-based count of lines already
 * reviewed) are skipped, except that their cwd still counts.
 */
export function parseTranscript(content: string, fromLine = 0): ParsedTranscript {
  const lines = completeLines(content);
  const result: ParsedTranscript = {
    cwd: undefined,
    messages: [],
    totalLines: lines.length,
    malformedLines: [],
  };

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const isNew = index >= fromLine;
    if (raw.trim() === "") return;

    const json = parseJson(raw);
    const header = json.ok ? EntryHeader.safeParse(json.value) : null;
    if (!header?.success) {
      if (isNew) result.malformedLines.push(lineNumber);
      return;
    }
    if (header.data.cwd !== undefined) result.cwd = header.data.cwd;
    if (!isNew || (header.data.type !== "user" && header.data.type !== "assistant")) return;

    const entry = MessageEntry.safeParse(json.ok ? json.value : undefined);
    if (!entry.success) {
      result.malformedLines.push(lineNumber);
      return;
    }
    // Meta entries are harness bookkeeping; sidechains are subagent chatter.
    if (entry.data.isMeta === true || entry.data.isSidechain === true) return;

    const text = contentToText(entry.data.message.content);
    if (text === "") return;
    result.messages.push({ line: lineNumber, role: entry.data.type, timestamp: entry.data.timestamp, text });
  });

  return result;
}
