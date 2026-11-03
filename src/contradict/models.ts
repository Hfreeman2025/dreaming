import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DreamingError, errorCode, errorMessage } from "../errors.js";

/**
 * The local NLI model behind the contradiction check, pinned to one immutable
 * revision. File list, sizes, SHA-256 values and URLs are copied from the
 * shared model manifest this machine already holds, so a copy downloaded here
 * is byte-identical to it. Layout on disk: `<dir>/<model-id>/<revision>/<file>`.
 */

export interface ModelFile {
  /** Path inside the revision folder, e.g. `onnx/model_quantized.onnx`. */
  file: string;
  bytes: number;
  sha256: string;
  url: string;
}

export interface ModelSpec {
  id: string;
  revision: string;
  /** The model the ONNX conversion was made from, and where its licence is declared. */
  upstream: string;
  licence: string;
  licenceSource: string;
  conversionSource: string;
  /** Quantisation of the ONNX weights. */
  dtype: string;
  /** The ONNX file the engine loads. */
  weight: string;
  files: readonly ModelFile[];
}

const REVISION = "2a4f614a701367a02d51389039afc998faeda637";
const resolve = (file: string) => `https://huggingface.co/Xenova/nli-deberta-v3-xsmall/resolve/${REVISION}/${file}`;

export const NLI_MODEL: ModelSpec = {
  id: "Xenova/nli-deberta-v3-xsmall",
  revision: REVISION,
  upstream: "cross-encoder/nli-deberta-v3-xsmall",
  licence: "Apache-2.0",
  licenceSource: "https://huggingface.co/cross-encoder/nli-deberta-v3-xsmall",
  conversionSource: "https://huggingface.co/Xenova/nli-deberta-v3-xsmall",
  dtype: "q8",
  weight: "onnx/model_quantized.onnx",
  files: [
    {
      file: "README.md",
      bytes: 1170,
      sha256: "1112e16f917777ce720f99ac42ba97f45d4e1bbbfa0dc1ed62313c33e9e0170b",
      url: resolve("README.md"),
    },
    {
      file: "added_tokens.json",
      bytes: 23,
      sha256: "dc046d04c9b0ada7ae6f1dc89c465801799acdf0c9a6aab8c15a1b2d5ca4e91f",
      url: resolve("added_tokens.json"),
    },
    {
      file: "config.json",
      bytes: 1038,
      sha256: "ec0bd14cc28640326474399cd61d38ccd52b64900228799d0f81debda8c4bc53",
      url: resolve("config.json"),
    },
    {
      file: "onnx/model_quantized.onnx",
      bytes: 87246587,
      sha256: "3fac2500c45c75af42c7711de0d1b93d59577456100208be0dc1f9e8811946b6",
      url: resolve("onnx/model_quantized.onnx"),
    },
    {
      file: "special_tokens_map.json",
      bytes: 173,
      sha256: "311de3f4eed9d76a43bf0d71f10e62e086ca65ccce9f15d5da0d2098bf519ecc",
      url: resolve("special_tokens_map.json"),
    },
    {
      file: "tokenizer.json",
      bytes: 8656551,
      sha256: "a86f883318afa11c8c10466f1bf4efaeb6ded28a52cbe57217a8fa0d0a2a87df",
      url: resolve("tokenizer.json"),
    },
    {
      file: "tokenizer_config.json",
      bytes: 384,
      sha256: "d8d3bb123b99317634d5ee3d1d2d8b2ddb01510a0654687fc2639a5347a7291f",
      url: resolve("tokenizer_config.json"),
    },
  ],
};

/** Total download size, stated before a download starts. */
export const modelBytes = (spec: ModelSpec): number => spec.files.reduce((sum, file) => sum + file.bytes, 0);

/** Where one model revision lives inside a models directory. */
export const modelPath = (dir: string, spec: ModelSpec = NLI_MODEL): string => join(dir, spec.id, spec.revision);

/**
 * The directories searched for the model, in order: `$DREAMING_MODELS` if set,
 * otherwise `<dreaming home>/models`, then any extra directories (a shared
 * models folder, for instance). The first one is where a download goes.
 */
export function modelDirs(env: { DREAMING_MODELS?: string | undefined }, home: string, extra: readonly string[] = []) {
  const first =
    env.DREAMING_MODELS !== undefined && env.DREAMING_MODELS !== "" ? env.DREAMING_MODELS : join(home, "models");
  return [...new Set([first, ...extra])];
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const stats = await stat(path);
    return stats.isFile() ? stats.size : null;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null;
    throw error;
  }
}

/**
 * The first directory holding every file of the model at its expected size.
 * Only sizes are checked here, so starting a review stays fast; hashes are
 * checked when a file is downloaded (before it is renamed into place) and by
 * {@link verifyModel} on demand.
 */
export async function findModel(
  dirs: readonly string[],
  spec: ModelSpec = NLI_MODEL,
): Promise<{ dir: string; path: string } | null> {
  for (const dir of dirs) {
    const path = modelPath(dir, spec);
    let complete = true;
    for (const file of spec.files) {
      if ((await sizeOf(join(path, file.file))) !== file.bytes) {
        complete = false;
        break;
      }
    }
    if (complete) return { dir, path };
  }
  return null;
}

/** Stream chunks are untyped; every one is checked to be bytes before it is hashed or written. */
function bytesOf(chunk: unknown): Uint8Array {
  if (!(chunk instanceof Uint8Array)) throw new Error("a stream produced something other than bytes");
  return chunk;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(bytesOf(chunk));
  return hash.digest("hex");
}

/** Re-hash every file of a model folder; returns the files whose hash differs (empty when intact). */
export async function verifyModel(path: string, spec: ModelSpec = NLI_MODEL): Promise<string[]> {
  const bad: string[] = [];
  for (const file of spec.files) {
    const size = await sizeOf(join(path, file.file));
    if (size !== file.bytes || (await hashFile(join(path, file.file))) !== file.sha256) bad.push(file.file);
  }
  return bad;
}

export type DownloadProgress =
  | { kind: "start"; totalBytes: number; files: number }
  | { kind: "file"; file: string; bytes: number }
  | { kind: "bytes"; file: string; received: number; totalReceived: number; totalBytes: number }
  | { kind: "done"; totalBytes: number; path: string };

export interface DownloadOptions {
  spec?: ModelSpec;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  /** Free bytes on the target volume; injectable so tests can simulate a full disk. */
  freeBytes?: (dir: string) => Promise<number>;
}

/** Room left on the disk after a download, so the model never fills it. */
const DISK_MARGIN = 512 * 1024 * 1024;

async function volumeFreeBytes(dir: string): Promise<number> {
  const stats = await statfs(dir);
  return stats.bavail * stats.bsize;
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;

/**
 * Download the model into `<dir>/<id>/<revision>/`, one file at a time.
 * Each file is written to `<file>.part`, its size and SHA-256 checked, and
 * only then renamed into place, so a reader never sees a partial or wrong
 * file. Files already present with the right hash are kept. Cancelling (the
 * signal) or any failure removes the partial file and throws; files already
 * completed stay, and the next attempt resumes after them.
 */
export async function downloadModel(dir: string, options: DownloadOptions = {}): Promise<string> {
  const spec = options.spec ?? NLI_MODEL;
  const fetchFile = options.fetch ?? globalThis.fetch;
  const path = modelPath(dir, spec);
  const totalBytes = modelBytes(spec);
  await mkdir(path, { recursive: true });

  const free = await (options.freeBytes ?? volumeFreeBytes)(path);
  if (free < totalBytes + DISK_MARGIN) {
    throw new DreamingError(
      `not enough disk space for the model: it needs ${mb(totalBytes)}, and ${mb(free)} is free`,
      {
        hint: `Free some space, or point DREAMING_MODELS at a folder on another disk. Dreaming keeps ${mb(DISK_MARGIN)} spare.`,
      },
    );
  }

  options.onProgress?.({ kind: "start", totalBytes, files: spec.files.length });
  let totalReceived = 0;
  for (const file of spec.files) {
    const target = join(path, file.file);
    if ((await sizeOf(target)) === file.bytes && (await hashFile(target)) === file.sha256) {
      totalReceived += file.bytes;
      continue;
    }
    options.onProgress?.({ kind: "file", file: file.file, bytes: file.bytes });
    await mkdir(dirname(target), { recursive: true });
    const part = `${target}.part`;
    try {
      const response = await fetchFile(file.url, { signal: options.signal, redirect: "follow" });
      if (!response.ok || response.body === null) {
        throw new Error(`the server answered ${response.status} for ${file.file}`);
      }
      const hash = createHash("sha256");
      const handle = await open(part, "w", 0o644);
      let received = 0;
      try {
        for await (const piece of response.body) {
          const chunk = bytesOf(piece);
          received += chunk.byteLength;
          if (received > file.bytes) throw new Error(`${file.file} is larger than the ${file.bytes} bytes expected`);
          hash.update(chunk);
          await handle.write(chunk);
          totalReceived += chunk.byteLength;
          options.onProgress?.({ kind: "bytes", file: file.file, received, totalReceived, totalBytes });
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (received !== file.bytes) throw new Error(`${file.file} ended at ${received} of ${file.bytes} bytes`);
      if (hash.digest("hex") !== file.sha256) throw new Error(`${file.file} does not match its published SHA-256`);
      await rename(part, target);
    } catch (error) {
      await rm(part, { force: true });
      if (options.signal?.aborted === true) {
        throw new DreamingError("model download cancelled", {
          hint: "No partial file was kept. Files already complete stay, and the next download carries on after them.",
          cause: error,
        });
      }
      throw new DreamingError(`model download failed: ${errorMessage(error)}`, {
        hint: "No partial file was kept. Check the connection and run it again; the review works without the model.",
        cause: error,
      });
    }
  }
  options.onProgress?.({ kind: "done", totalBytes, path });
  return path;
}
