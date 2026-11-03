#!/usr/bin/env node
// Measure the contradiction check's real accuracy on the hand-labelled
// synthetic pairs in test/fixtures/contradictions.json, with the real local
// model, and write docs/contradiction-accuracy.json. Nothing is downloaded:
// the model must already be on disk.
//
// Usage (after npm run build):
//   DREAMING_NLI_MODEL_DIR=<models dir> node scripts/contradiction-accuracy.mjs
// Optional: DREAMING_NLI_RUNTIME_FROM=<project dir> resolves onnxruntime-web and
// @huggingface/tokenizers from another project's node_modules.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CONTRADICTION_THRESHOLD, contentWords, MIN_SHARED_WORDS } from "../dist/contradict/check.js";
import { findModel, NLI_MODEL } from "../dist/contradict/models.js";
import { loadNliEngine } from "../dist/contradict/nli.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dir = process.env.DREAMING_NLI_MODEL_DIR;
if (!dir) {
  console.error("Set DREAMING_NLI_MODEL_DIR to a folder holding the model (<dir>/<model-id>/<revision>/...).");
  process.exit(2);
}

const fixture = JSON.parse(await readFile(`${ROOT}test/fixtures/contradictions.json`, "utf8"));
const found = await findModel([dir]);
if (!found) {
  console.error(`No complete copy of ${NLI_MODEL.id}@${NLI_MODEL.revision} in ${dir}; this script never downloads.`);
  process.exit(1);
}
const loaded = await loadNliEngine(found.path, { runtimeFrom: process.env.DREAMING_NLI_RUNTIME_FROM || undefined });
if (!loaded.ok) {
  console.error(loaded.reason);
  process.exit(1);
}
const { engine, loadMs } = loaded;

// One call per pair (both directions together), so the latency is what one pair costs.
const rows = [];
const pairMs = [];
for (const pair of fixture.pairs) {
  const started = performance.now();
  const [ab, ba] = await engine.classify([
    [pair.a, pair.b],
    [pair.b, pair.a],
  ]);
  pairMs.push(performance.now() - started);
  const score = Math.max(ab.contradiction, ba.contradiction);
  const shared = [...contentWords(pair.a)].filter((word) => contentWords(pair.b).has(word));
  rows.push({ ...pair, score, ab, ba, flagged: score >= CONTRADICTION_THRESHOLD, sharedWords: shared });
}

// Scoring several pairs in one call must give exactly the scores they got alone.
const together = await engine.classify(fixture.pairs.slice(0, 8).map((pair) => [pair.a, pair.b]));
const batchDrift = Math.max(...together.map((scores, i) => Math.abs(scores.contradiction - rows[i].ab.contradiction)));
await engine.close();

const positive = (row) => row.label === "contradiction";
const count = (predicate) => rows.filter(predicate).length;
const tp = count((r) => positive(r) && r.flagged);
const fp = count((r) => !positive(r) && r.flagged);
const tn = count((r) => !positive(r) && !r.flagged);
const fn = count((r) => positive(r) && !r.flagged);
const precision = tp + fp === 0 ? null : tp / (tp + fp);
const recall = tp + fn === 0 ? null : tp / (tp + fn);
const f1 =
  precision === null || recall === null || precision + recall === 0
    ? null
    : (2 * precision * recall) / (precision + recall);

// AUROC as the Mann-Whitney statistic: the chance a random contradiction outscores a random non-contradiction.
const pos = rows.filter(positive).map((r) => r.score);
const neg = rows.filter((r) => !positive(r)).map((r) => r.score);
let wins = 0;
for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
const auroc = wins / (pos.length * neg.length);

const sorted = [...pairMs].sort((x, y) => x - y);
const quantile = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const byKind = {};
for (const row of rows) {
  const entry = (byKind[`${row.label}/${row.kind}`] ??= { n: 0, flagged: 0 });
  entry.n += 1;
  if (row.flagged) entry.flagged += 1;
}
const round = (value) => (value === null ? null : Number(value.toFixed(4)));

// The review's pipeline only scores pairs that share a content word, so it is measured as well:
// a pair counts as flagged only if it passes the prefilter and reaches the threshold.
const metrics = (flag) => {
  const c = {
    tp: count((r) => positive(r) && flag(r)),
    fp: count((r) => !positive(r) && flag(r)),
    tn: count((r) => !positive(r) && !flag(r)),
    fn: count((r) => positive(r) && !flag(r)),
  };
  const p = c.tp + c.fp === 0 ? null : c.tp / (c.tp + c.fp);
  const rc = c.tp + c.fn === 0 ? null : c.tp / (c.tp + c.fn);
  const f = p === null || rc === null || p + rc === 0 ? null : (2 * p * rc) / (p + rc);
  return { confusion: c, precision: round(p), recall: round(rc), f1: round(f) };
};
const pipeline = metrics((r) => r.flagged && r.sharedWords.length >= MIN_SHARED_WORDS);
const pipelineOneWord = metrics((r) => r.flagged && r.sharedWords.length > 0);

const report = {
  measuredAt: new Date().toISOString(),
  model: { id: NLI_MODEL.id, revision: NLI_MODEL.revision, dtype: NLI_MODEL.dtype },
  runtime: "onnxruntime-web (WebAssembly, 1 thread) in Node " + process.version,
  threshold: CONTRADICTION_THRESHOLD,
  thresholdChosen: "a priori, before this measurement (see CONTRADICTION_THRESHOLD in src/contradict/check.ts)",
  score: "max over both directions of P(contradiction)",
  n: rows.length,
  positives: pos.length,
  negatives: neg.length,
  confusion: { tp, fp, tn, fn },
  classifier: "the model alone, on every pair",
  precision: round(precision),
  recall: round(recall),
  f1: round(f1),
  accuracy: round((tp + tn) / rows.length),
  auroc: round(auroc),
  // The word-overlap prefilter only scores pairs sharing a content word; this is how many contradictions it would let through.
  prefilterRecall: round(count((r) => positive(r) && r.sharedWords.length >= MIN_SHARED_WORDS) / pos.length),
  pipeline: {
    description: `prefilter (at least ${MIN_SHARED_WORDS} shared content words) then the threshold, as the review runs it`,
    ...pipeline,
  },
  pipelineBefore: {
    description:
      "the first version: one shared content word, then the threshold. Replaced after it flagged unrelated sentences in the demo; this set was seen while choosing the replacement, so treat both as optimistic",
    ...pipelineOneWord,
  },
  byKind,
  timing: {
    loadMs: Math.round(loadMs),
    msPerPairMedian: Number(quantile(0.5).toFixed(1)),
    msPerPairP95: Number(quantile(0.95).toFixed(1)),
    note: "one pair = both directions in one call",
  },
  batchDrift: Number(batchDrift.toExponential(2)),
  pairs: rows.map((r) => ({
    id: r.id,
    label: r.label,
    kind: r.kind,
    score: round(r.score),
    flagged: r.flagged,
    ab: { contradiction: round(r.ab.contradiction), entailment: round(r.ab.entailment), neutral: round(r.ab.neutral) },
    ba: { contradiction: round(r.ba.contradiction), entailment: round(r.ba.entailment), neutral: round(r.ba.neutral) },
    sharedWords: r.sharedWords,
  })),
};
await writeFile(`${ROOT}docs/contradiction-accuracy.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `n=${report.n} threshold=${report.threshold} precision=${report.precision} recall=${report.recall} f1=${report.f1} auroc=${report.auroc} ` +
    `tp/fp/tn/fn=${tp}/${fp}/${tn}/${fn} prefilterRecall=${report.prefilterRecall} ` +
    `pipeline precision=${pipeline.precision} recall=${pipeline.recall} f1=${pipeline.f1} ` +
    `(${pipeline.confusion.tp}/${pipeline.confusion.fp}/${pipeline.confusion.tn}/${pipeline.confusion.fn}) load=${report.timing.loadMs}ms ` +
    `pair median=${report.timing.msPerPairMedian}ms p95=${report.timing.msPerPairP95}ms batchDrift=${report.batchDrift}`,
);
