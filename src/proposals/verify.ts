import type { SessionDigest } from "../transcripts/digest.js";

/**
 * Evidence verification. Every quote the agent cites must appear in the
 * message text of the session it names, starting and ending on word
 * boundaries. Matching tolerates the differences models introduce when
 * copying text (whitespace, typographic quotes and dashes, wrapping quotation
 * marks) and "..." elisions. An elision can drop words that matter ("we will
 * ... deploy" from "we will not deploy"), so a verified quote also carries
 * `source`: the transcript's own text for the whole matched span. That, not
 * the agent's rendering, is what the reviewer reads.
 */

export type QuoteStatus = "verified" | "not-found" | "unknown-session";

export interface QuoteCheck {
  status: QuoteStatus;
  /** Transcript line of the message the quote was found in. */
  line: number | undefined;
  /** The message text from the first matched fragment to the end of the last, verbatim. */
  source: string | undefined;
}

const ELLIPSIS = /\s*(?:\.\.\.|…)\s*/;
const MIN_FRAGMENT_CHARS = 4;
/** An elided quote may span at most this much of the original message. */
export const MAX_SOURCE_CHARS = 1000;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Letters, digits, combining marks (part of the letter they follow) and underscore. */
const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;

function normalizeGrapheme(segment: string): string {
  return segment
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-");
}

export interface NormalizedText {
  text: string;
  /**
   * For each UTF-16 code unit of `text`, the [start, end) range of the
   * original grapheme it came from. Units of one grapheme share a range.
   */
  starts: number[];
  ends: number[];
}

/**
 * Normalise for matching (NFKC per grapheme, typographic punctuation to
 * ASCII, whitespace runs to one space, trimmed) and keep a map back to the
 * original, so a match can be reported in the original's own words.
 */
export function normalizeWithMap(text: string): NormalizedText {
  const result: NormalizedText = { text: "", starts: [], ends: [] };
  let pendingSpaceAt = -1;
  for (const { segment, index } of graphemes.segment(text)) {
    for (const char of normalizeGrapheme(segment)) {
      if (/\s/.test(char)) {
        if (result.text !== "" && pendingSpaceAt === -1) pendingSpaceAt = index;
        continue;
      }
      if (pendingSpaceAt !== -1) {
        result.text += " ";
        result.starts.push(pendingSpaceAt);
        result.ends.push(index);
        pendingSpaceAt = -1;
      }
      result.text += char;
      // One entry per code unit, so map indexes line up with string indexes
      // even for characters outside the Basic Multilingual Plane (emoji).
      for (let unit = 0; unit < char.length; unit += 1) {
        result.starts.push(index);
        result.ends.push(index + segment.length);
      }
    }
  }
  return result;
}

export function normalizeForMatch(text: string): string {
  return normalizeWithMap(text).text;
}

/** Split a quote into the fragments that must appear, in order. */
export function quoteFragments(quote: string): string[] {
  let core = normalizeForMatch(quote);
  // Models often wrap quotes in quotation marks; those are not part of the text.
  const wrapped = /^(["'`])(.*)\1$/s.exec(core);
  if (wrapped?.[2] !== undefined) core = wrapped[2].trim();
  return core
    .split(ELLIPSIS)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment !== "");
}

const isWordChar = (char: string | undefined): boolean => char !== undefined && WORD_CHAR.test(char);

/**
 * True if `fragment` at `at` neither starts nor ends inside a word, and
 * neither starts nor ends inside a grapheme (a letter and its marks, an
 * emoji sequence, or one character that normalised to several).
 */
function onBoundaries(text: NormalizedText, fragment: string, at: number): boolean {
  const { text: haystack, starts } = text;
  const end = at + fragment.length;
  const midGrapheme =
    (at > 0 && starts[at] === starts[at - 1]) || (end < haystack.length && starts[end] === starts[end - 1]);
  if (midGrapheme) return false;
  const startOk = !isWordChar(fragment[0]) || !isWordChar(haystack[at - 1]);
  const endOk = !isWordChar(fragment[fragment.length - 1]) || !isWordChar(haystack[end]);
  return startOk && endOk;
}

function findFragment(text: NormalizedText, fragment: string, from: number): number {
  for (let at = text.text.indexOf(fragment, from); at !== -1; at = text.text.indexOf(fragment, at + 1)) {
    if (onBoundaries(text, fragment, at)) return at;
  }
  return -1;
}

/**
 * The shortest span in which the fragments appear in order on word
 * boundaries: every occurrence of the first fragment is tried, and the rest
 * are matched as early as possible after it.
 */
function findSpan(text: NormalizedText, fragments: readonly string[]): { start: number; end: number } | null {
  const [first, ...rest] = fragments;
  if (first === undefined) return null;
  let best: { start: number; end: number } | null = null;
  for (let start = findFragment(text, first, 0); start !== -1; start = findFragment(text, first, start + 1)) {
    let end = start + first.length;
    let complete = true;
    for (const fragment of rest) {
      const at = findFragment(text, fragment, end);
      if (at === -1) {
        complete = false;
        break;
      }
      end = at + fragment.length;
    }
    if (!complete) break; // a later start cannot find what an earlier one could not
    if (best === null || end - start < best.end - best.start) best = { start, end };
  }
  return best;
}

const NOT_FOUND: QuoteCheck = { status: "not-found", line: undefined, source: undefined };

export function verifyQuote(quote: string, digest: SessionDigest | undefined): QuoteCheck {
  if (digest === undefined) return { status: "unknown-session", line: undefined, source: undefined };
  const fragments = quoteFragments(quote);
  if (fragments.length === 0 || fragments.some((fragment) => fragment.length < MIN_FRAGMENT_CHARS)) {
    return NOT_FOUND;
  }
  for (const message of digest.messages) {
    const normalized = normalizeWithMap(message.text);
    const span = findSpan(normalized, fragments);
    if (span === null) continue;
    const from = normalized.starts[span.start];
    const to = normalized.ends[span.end - 1];
    if (from === undefined || to === undefined) continue;
    const source = message.text.slice(from, to);
    if (source.length > MAX_SOURCE_CHARS) continue;
    return { status: "verified", line: message.line, source };
  }
  return NOT_FOUND;
}

/** True when the quote is not just the source text: it elides or otherwise differs. */
export function quoteDiffersFromSource(quote: string, source: string): boolean {
  const fragments = quoteFragments(quote);
  return fragments.length !== 1 || fragments[0] !== normalizeForMatch(source);
}
