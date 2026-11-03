import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { errorCode, errorMessage } from "../errors.js";
import { parseJson } from "../fsx.js";
import { NLI_MODEL, type ModelSpec } from "./models.js";

/**
 * A natural-language-inference cross-encoder run on this machine: given a
 * premise and a hypothesis it returns how likely the second contradicts,
 * follows from, or is unrelated to the first. The model runs in
 * onnxruntime-web's WebAssembly build inside Node, and its tokenizer is the
 * pure-JS Tokenizers.js, so nothing native is installed and nothing leaves the
 * machine. Both libraries are optional dependencies: they are imported only
 * here, on first use, and dreaming starts and reviews without them.
 */

export interface NliScores {
  contradiction: number;
  entailment: number;
  neutral: number;
}

export interface NliEngine {
  readonly model: { id: string; revision: string };
  /** Scores for each [premise, hypothesis] pair, in order. */
  classify(pairs: readonly (readonly [string, string])[]): Promise<NliScores[]>;
  close(): Promise<void>;
}

export type LoadResult = { ok: true; engine: NliEngine; loadMs: number } | { ok: false; reason: string };

export interface LoadOptions {
  spec?: ModelSpec;
  /**
   * A project directory to resolve the two runtime packages from, instead of
   * dreaming's own node_modules (for measuring with a copy installed elsewhere).
   */
  runtimeFrom?: string;
}

// ---------------------------------------------------------------------------
// The two optional modules arrive as `unknown`; these guards check the parts
// dreaming calls before anything is called.

interface OrtTensor {
  readonly data: unknown;
}
interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor | undefined>>;
  release?: () => Promise<void>;
}
interface OrtModule {
  InferenceSession: { create(model: Uint8Array, options: { executionProviders: string[] }): Promise<OrtSession> };
  Tensor: new (type: "int64", data: BigInt64Array, dims: readonly number[]) => OrtTensor;
  env: { wasm: { numThreads?: number } };
}
interface TokenizerInstance {
  encode(text: string, options: { text_pair: string; add_special_tokens: boolean }): unknown;
}
interface TokenizersModule {
  Tokenizer: new (tokenizerJson: object, config: object) => TokenizerInstance;
}

/** A property of an object or a function (classes carry static methods such as `create`). */
const field = (value: unknown, key: string): unknown =>
  (typeof value === "object" && value !== null) || typeof value === "function" ? Reflect.get(value, key) : undefined;

function isOrtModule(value: unknown): value is OrtModule {
  return (
    typeof field(field(value, "InferenceSession"), "create") === "function" &&
    typeof field(value, "Tensor") === "function" &&
    typeof field(field(value, "env"), "wasm") === "object"
  );
}

function isTokenizersModule(value: unknown): value is TokenizersModule {
  return typeof field(value, "Tokenizer") === "function";
}

/** A module namespace, or the CommonJS exports behind its default export, whichever has the shape. */
function pick<T>(namespace: unknown, guard: (value: unknown) => value is T): T | undefined {
  if (guard(namespace)) return namespace;
  const fallback = field(namespace, "default");
  return guard(fallback) ? fallback : undefined;
}

async function importOptional(name: string, from: string | undefined): Promise<unknown> {
  if (from === undefined) return import(name);
  const resolved = createRequire(join(from, "package.json")).resolve(name);
  return import(pathToFileURL(resolved).href);
}

const MISSING =
  "the contradiction check needs the optional packages onnxruntime-web and @huggingface/tokenizers, which are not installed";

const ModelConfig = z.object({ id2label: z.record(z.string(), z.string()) });
const TokenizerConfig = z.looseObject({ pad_token: z.string().optional(), model_max_length: z.number().optional() });
const TokenizerJson = z.looseObject({ model: z.looseObject({}) });
const Encoding = z.object({ ids: z.array(z.number().int().nonnegative()) });
const LABELS = ["contradiction", "entailment", "neutral"] as const;

async function readJson(path: string): Promise<unknown> {
  const parsed = parseJson(await readFile(path, "utf8"));
  if (!parsed.ok) throw new Error(`${path} is not JSON: ${parsed.error}`);
  return parsed.value;
}

/** Index of each label in the model's logits, read from its config rather than assumed. */
function labelIndexes(config: z.infer<typeof ModelConfig>): Record<(typeof LABELS)[number], number> {
  const byName = new Map(Object.entries(config.id2label).map(([index, label]) => [label.toLowerCase(), Number(index)]));
  const indexes = { contradiction: -1, entailment: -1, neutral: -1 };
  for (const label of LABELS) {
    const index = byName.get(label);
    if (index === undefined || !Number.isInteger(index)) throw new Error(`the model's config has no "${label}" label`);
    indexes[label] = index;
  }
  return indexes;
}

/** The longest input the model takes; longer pairs keep their start and end tokens. */
const MAX_TOKENS = 512;

/**
 * Load the model from a revision folder (see `findModel`). Returns a reason
 * instead of throwing when the optional runtime packages are not installed,
 * so the review can say so and carry on.
 */
export async function loadNliEngine(modelPath: string, options: LoadOptions = {}): Promise<LoadResult> {
  const started = performance.now();
  const spec = options.spec ?? NLI_MODEL;
  let ort: OrtModule | undefined;
  let textCodec: TokenizersModule | undefined;
  try {
    ort = pick(await importOptional("onnxruntime-web", options.runtimeFrom), isOrtModule);
    textCodec = pick(await importOptional("@huggingface/tokenizers", options.runtimeFrom), isTokenizersModule);
  } catch (error) {
    if (errorCode(error) === "ERR_MODULE_NOT_FOUND" || errorCode(error) === "MODULE_NOT_FOUND") {
      return { ok: false, reason: MISSING };
    }
    return { ok: false, reason: `the NLI runtime could not be loaded: ${errorMessage(error)}` };
  }
  if (ort === undefined || textCodec === undefined) {
    return {
      ok: false,
      reason: "the installed onnxruntime-web or @huggingface/tokenizers is not a version dreaming can use",
    };
  }

  try {
    const config = ModelConfig.parse(await readJson(join(modelPath, "config.json")));
    const indexes = labelIndexes(config);
    const vocabConfig = TokenizerConfig.parse(await readJson(join(modelPath, "tokenizer_config.json")));
    const vocabJson = TokenizerJson.parse(await readJson(join(modelPath, "tokenizer.json")));
    const encoder = new textCodec.Tokenizer(vocabJson, vocabConfig);
    // One thread: a CLI exits cleanly with no worker threads to tear down, results
    // are deterministic, and a pair takes tens of milliseconds, which is enough.
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(await readFile(join(modelPath, spec.weight)), {
      executionProviders: ["wasm"],
    });
    const output = session.outputNames[0];
    if (output === undefined) throw new Error("the model has no outputs");
    for (const name of session.inputNames) {
      if (name !== "input_ids" && name !== "attention_mask" && name !== "token_type_ids") {
        throw new Error(`the model expects an input dreaming does not provide: ${name}`);
      }
    }
    const Tensor = ort.Tensor;

    const encode = (premise: string, hypothesis: string): number[] => {
      const { ids } = Encoding.parse(encoder.encode(premise, { text_pair: hypothesis, add_special_tokens: true }));
      // Keep the [CLS] start and the final [SEP]; drop from the middle of an over-long pair.
      return ids.length <= MAX_TOKENS ? ids : [...ids.slice(0, MAX_TOKENS - 1), ...ids.slice(-1)];
    };

    const engine: NliEngine = {
      model: { id: spec.id, revision: spec.revision },
      async classify(pairs) {
        // One input per call. The q8 weights quantise activations per tensor at run
        // time, so batching (padded or not) shifts the scale used for every row and
        // a pair's score would depend on what it was batched with (measured: up to
        // 0.017). Scores must not depend on their neighbours, so there is no batching.
        const classes = Object.keys(config.id2label).length;
        const scores: NliScores[] = [];
        for (const [premise, hypothesis] of pairs) {
          const row = encode(premise, hypothesis);
          const dims = [1, row.length];
          const ids = BigInt64Array.from(row, (id) => BigInt(id));
          const feeds: Record<string, OrtTensor> = {};
          for (const name of session.inputNames) {
            if (name === "input_ids") feeds[name] = new Tensor("int64", ids, dims);
            else if (name === "attention_mask")
              feeds[name] = new Tensor("int64", new BigInt64Array(row.length).fill(1n), dims);
            else feeds[name] = new Tensor("int64", new BigInt64Array(row.length), dims);
          }
          const result = await session.run(feeds);
          const logits = result[output]?.data;
          if (!(logits instanceof Float32Array) || logits.length !== classes) {
            throw new Error("the model returned logits of an unexpected shape");
          }
          const values = Array.from(logits);
          const max = Math.max(...values);
          const exps = values.map((value) => Math.exp(value - max));
          const total = exps.reduce((sum, value) => sum + value, 0);
          const p = (index: number) => (exps[index] ?? 0) / total;
          scores.push({
            contradiction: p(indexes.contradiction),
            entailment: p(indexes.entailment),
            neutral: p(indexes.neutral),
          });
        }
        return scores;
      },
      async close() {
        await session.release?.();
      },
    };
    return { ok: true, engine, loadMs: performance.now() - started };
  } catch (error) {
    return { ok: false, reason: `the NLI model at ${modelPath} could not be loaded: ${errorMessage(error)}` };
  }
}
