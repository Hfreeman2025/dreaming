import { memoryFields, parseMemoryDocument } from "../memory/frontmatter.js";
import type { NliEngine, NliScores } from "./nli.js";

/**
 * Contradiction check across a memory set. Every memory is split into
 * sentences; sentences from different files that share a salient word become
 * candidate pairs (so the model is not run on every pair of sentences); each
 * candidate is scored by the local NLI model in both directions, and a pair is
 * a contradiction when either direction puts at least `threshold` of its
 * probability on "contradiction". The result is inferred, not proven: it is
 * shown with both sentences and both scores so a person can judge it.
 */

export interface MemoryText {
  /** The memory file the text is (or would be) in. */
  file: string;
  source: "memory" | "proposal";
  proposalId?: string;
  /** Description and body, frontmatter removed. */
  text: string;
}

export interface SentenceRef {
  file: string;
  source: "memory" | "proposal";
  proposalId?: string;
  sentence: string;
}

export interface Contradiction {
  a: SentenceRef;
  b: SentenceRef;
  /** The larger of the two directions' contradiction probabilities. */
  score: number;
  /** Scores with `a` as premise and `b` as hypothesis, and the other way round. */
  ab: NliScores;
  ba: NliScores;
}

export interface CheckResult {
  model: { id: string; revision: string };
  /** Sentence pairs scored (each in both directions). */
  pairs: number;
  /** Cross-file sentence pairs not scored: no salient word in common, or past the cap. */
  skipped: number;
  /** Of those, the ones dropped only because of the cap. */
  skippedOverCap: number;
  ms: number;
  threshold: number;
  contradictions: Contradiction[];
}

export interface CheckOptions {
  threshold?: number;
  /** Most sentence pairs scored per check; the pairs with most words in common go first. */
  maxPairs?: number;
}

/**
 * Chosen before measuring, not tuned on the labelled set. 0.5 would flag any
 * pair the model thinks is more likely a contradiction than not; candidates
 * are picked for sharing words, which is exactly where MNLI-trained models
 * over-call contradiction, and memory notes are far from MNLI's domain, where
 * these models' confidence is least reliable. A warning a reviewer reads should
 * be right most of the time, so the model must put four fifths of its
 * probability on "contradiction".
 */
export const CONTRADICTION_THRESHOLD = 0.8;

/**
 * Two sentences can only contradict each other if they are about the same
 * thing (de Marneffe et al. 2008, "Finding Contradictions in Text"). Sharing
 * two content words is the cheap stand-in for that used here. With one, the
 * model called "Staging key for the tidepool smoke test" a contradiction of
 * "the v1 compatibility tests were removed" (0.99), on the word "test" alone.
 * This rule was set after seeing that; see docs/contradiction-accuracy.json
 * for what it costs in recall on the labelled set.
 */
export const MIN_SHARED_WORDS = 2;
export const MAX_PAIRS = 400;

// --- text -------------------------------------------------------------------

/** Description and body of a memory file, markdown markers removed; the raw text if it has no frontmatter. */
export function memoryText(
  file: string,
  raw: string,
  source: MemoryText["source"] = "memory",
  proposalId?: string,
): MemoryText {
  const parsed = parseMemoryDocument(raw);
  const description = parsed.ok ? (memoryFields(parsed.doc.frontmatter).description ?? "") : "";
  const body = parsed.ok ? parsed.doc.body : raw;
  const text = [description, body].filter((part) => part.trim() !== "").join("\n");
  return { file, source, ...(proposalId === undefined ? {} : { proposalId }), text };
}

/** Markdown removed from one line: headings, list markers, bold labels, emphasis, links and code ticks. */
function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/\*\*[^*\n]{1,40}:\*\*\s*/g, "")
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/[*_]{1,2}([^*_\n]+)[*_]{1,2}/g, "$1")
    .replace(/`([^`\n]*)`/g, "$1")
    .trim();
}

/** Sentences of a memory text: split at line breaks and at sentence ends; fragments under three words are dropped. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const plain = plainLine(line);
    if (plain === "" || /^-{3,}$/.test(plain)) continue;
    // A sentence ends at . ! or ? followed by space and a capital, a digit or a quote;
    // "v2.1", "e.g. this" and "/v1 returns" stay whole.
    for (const part of plain.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)) {
      const sentence = part.trim();
      if (sentence.split(/\s+/).length >= 3) out.push(sentence);
    }
  }
  return out;
}

const STOPWORDS = new Set(
  (
    "the a an and or but if then than that this these those there here of to in on at by for from with without " +
    "into onto over under about after before during while is are was were be been being am do does did done " +
    "has have had having it its it's they them their he she his her we our you your i me my not no nor so as " +
    "can could should would will shall may might must just also only always never every any all some each " +
    "use uses used using run runs make makes made get gets got set sets put via per new now still yet very " +
    "what which who whom whose when where why how one two first last more most less least other others same " +
    "ok okay yes thing things way ways like need needs want wants see say says said know"
  ).split(" "),
);

/** Lower-cased content words, plurals trimmed; a word must be three letters or carry a digit ("v1"). */
export function contentWords(sentence: string): Set<string> {
  const words = new Set<string>();
  for (const raw of sentence.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (STOPWORDS.has(raw)) continue;
    if (raw.length < 3 && !/\p{N}/u.test(raw)) continue;
    let word = raw;
    if (word.length > 4 && word.endsWith("ies")) word = `${word.slice(0, -3)}y`;
    else if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) word = word.slice(0, -1);
    if (!STOPWORDS.has(word)) words.add(word);
  }
  return words;
}

interface Sentence extends SentenceRef {
  words: Set<string>;
}

function split(texts: readonly MemoryText[]): Sentence[] {
  return texts.flatMap((text) =>
    sentences(text.text).map((sentence) => ({
      file: text.file,
      source: text.source,
      ...(text.proposalId === undefined ? {} : { proposalId: text.proposalId }),
      sentence,
      words: contentWords(sentence),
    })),
  );
}

const origin = (s: SentenceRef) => `${s.source}:${s.proposalId ?? ""}:${s.file}`;

/**
 * Candidate pairs from `left` x `right` (or within `left` when `right` is
 * null), across different files only, sharing at least one content word.
 * The most overlapping pairs go first; past `maxPairs` they are counted, not scored.
 */
export function candidatePairs(
  left: readonly Sentence[],
  right: readonly Sentence[] | null,
  maxPairs: number,
): { pairs: [Sentence, Sentence][]; skipped: number; skippedOverCap: number } {
  const scored: { pair: [Sentence, Sentence]; overlap: number }[] = [];
  let considered = 0;
  const seen = new Set<string>();
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    if (a === undefined) continue;
    const others = right ?? left.slice(i + 1);
    for (const b of others) {
      if (origin(a) === origin(b)) continue;
      const key = [a.sentence, b.sentence].sort().join("\n");
      if (seen.has(key)) continue;
      seen.add(key);
      considered += 1;
      let shared = 0;
      for (const word of a.words) if (b.words.has(word)) shared += 1;
      if (shared < MIN_SHARED_WORDS) continue;
      const union = a.words.size + b.words.size - shared;
      scored.push({ pair: [a, b], overlap: shared / union });
    }
  }
  scored.sort((x, y) => y.overlap - x.overlap);
  const kept = scored.slice(0, maxPairs).map((entry) => entry.pair);
  const skippedOverCap = scored.length - kept.length;
  return { pairs: kept, skipped: considered - kept.length, skippedOverCap };
}

const ref = (s: Sentence): SentenceRef => ({
  file: s.file,
  source: s.source,
  ...(s.proposalId === undefined ? {} : { proposalId: s.proposalId }),
  sentence: s.sentence,
});

async function score(
  engine: NliEngine,
  found: { pairs: [Sentence, Sentence][]; skipped: number; skippedOverCap: number },
  threshold: number,
): Promise<CheckResult> {
  const started = performance.now();
  // Both directions in one call: NLI is not symmetric, and a contradiction may show in only one.
  const inputs = found.pairs.flatMap(([a, b]): [string, string][] => [
    [a.sentence, b.sentence],
    [b.sentence, a.sentence],
  ]);
  const results = inputs.length === 0 ? [] : await engine.classify(inputs);
  const contradictions: Contradiction[] = [];
  found.pairs.forEach(([a, b], index) => {
    const ab = results[index * 2];
    const ba = results[index * 2 + 1];
    if (ab === undefined || ba === undefined) throw new Error("the NLI engine returned fewer scores than pairs");
    const value = Math.max(ab.contradiction, ba.contradiction);
    if (value >= threshold) contradictions.push({ a: ref(a), b: ref(b), score: value, ab, ba });
  });
  contradictions.sort((x, y) => y.score - x.score);
  return {
    model: engine.model,
    pairs: found.pairs.length,
    skipped: found.skipped,
    skippedOverCap: found.skippedOverCap,
    ms: performance.now() - started,
    threshold,
    contradictions,
  };
}

/**
 * Contradictions between one proposal's resulting memory text and the rest of
 * the set: existing memories other than the file the proposal replaces, and
 * other pending proposals. (A delete has no text, so it contradicts nothing.)
 */
export async function checkProposal(
  engine: NliEngine,
  proposal: MemoryText,
  others: readonly MemoryText[],
  options: CheckOptions = {},
): Promise<CheckResult> {
  const rest = others.filter((other) =>
    other.source === "memory"
      ? other.file !== proposal.file
      : other.proposalId === undefined || other.proposalId !== proposal.proposalId,
  );
  const found = candidatePairs(split([proposal]), split(rest), options.maxPairs ?? MAX_PAIRS);
  return score(engine, found, options.threshold ?? CONTRADICTION_THRESHOLD);
}

/** Contradictions already inside a memory set, between any two of its files. */
export async function checkMemorySet(
  engine: NliEngine,
  texts: readonly MemoryText[],
  options: CheckOptions = {},
): Promise<CheckResult> {
  const found = candidatePairs(split(texts), null, options.maxPairs ?? MAX_PAIRS);
  return score(engine, found, options.threshold ?? CONTRADICTION_THRESHOLD);
}
