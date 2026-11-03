import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  candidatePairs,
  checkMemorySet,
  checkProposal,
  contentWords,
  CONTRADICTION_THRESHOLD,
  memoryText,
  sentences,
  type MemoryText,
} from "../src/contradict/check.js";
import {
  downloadModel,
  findModel,
  modelBytes,
  modelDirs,
  modelPath,
  NLI_MODEL,
  verifyModel,
  type DownloadProgress,
  type ModelSpec,
} from "../src/contradict/models.js";
import { loadNliEngine, type NliEngine, type NliScores } from "../src/contradict/nli.js";
import { DreamingError } from "../src/errors.js";

const NEUTRAL: NliScores = { contradiction: 0.05, entailment: 0.05, neutral: 0.9 };

/** A stand-in for the model: scores looked up by "premise => hypothesis", neutral otherwise. Records every call. */
function stubEngine(table: Record<string, number>): NliEngine & { calls: [string, string][] } {
  const calls: [string, string][] = [];
  return {
    model: { id: "stub/nli", revision: "test" },
    calls,
    classify(pairs) {
      return Promise.resolve(
        pairs.map(([premise, hypothesis]) => {
          calls.push([premise, hypothesis]);
          const contradiction = table[`${premise} => ${hypothesis}`];
          return contradiction === undefined
            ? NEUTRAL
            : { contradiction, entailment: (1 - contradiction) / 2, neutral: (1 - contradiction) / 2 };
        }),
      );
    },
    close: () => Promise.resolve(),
  };
}

const memory = (file: string, text: string): MemoryText => ({ file, source: "memory", text });

describe("memory text", () => {
  it("keeps the description and body, without frontmatter or markdown markers", () => {
    const raw =
      "---\nname: prefer-pnpm\ndescription: Use pnpm, never npm, in the tidepool repo\nmetadata:\n  type: feedback\n---\n\n" +
      "Use pnpm for installs and scripts in tidepool.\n\n**Why:** npm install breaks the [workspace links](https://example.test/links).\n\n" +
      "- **How to apply:** run `pnpm install`, never `npm install`.\n";
    const text = memoryText("prefer-pnpm.md", raw);
    expect(text).toMatchObject({ file: "prefer-pnpm.md", source: "memory" });
    expect(sentences(text.text)).toEqual([
      "Use pnpm, never npm, in the tidepool repo",
      "Use pnpm for installs and scripts in tidepool.",
      "npm install breaks the workspace links.",
      "run pnpm install, never npm install.",
    ]);
  });

  it("uses the whole text when a file has no frontmatter, and tags proposals", () => {
    expect(memoryText("x.md", "Deploys go out on Tuesdays.", "proposal", "r-1")).toEqual({
      file: "x.md",
      source: "proposal",
      proposalId: "r-1",
      text: "Deploys go out on Tuesdays.",
    });
  });

  it("splits sentences at sentence ends only, and drops fragments", () => {
    expect(
      sentences(
        "The v2.1 API is live. It replaced /v1 on 30 October. Two partner apps still call it! OK.\n---\n# Notes",
      ),
    ).toEqual(["The v2.1 API is live.", "It replaced /v1 on 30 October.", "Two partner apps still call it!"]);
  });

  it("reduces a sentence to content words: no stopwords, plurals trimmed, digits kept", () => {
    expect([...contentWords("Deploys never happen on Tuesdays; the v1 tests are flaky.")].sort()).toEqual([
      "deploy",
      "flaky",
      "happen",
      "test",
      "tuesday",
      "v1",
    ]);
    expect(contentWords("Use it as a")).toEqual(new Set());
    expect(contentWords("Two dependencies")).toEqual(new Set(["dependency"]));
  });
});

describe("candidate pairs", () => {
  const split = (texts: MemoryText[]) =>
    texts.flatMap((t) => sentences(t.text).map((sentence) => ({ ...t, sentence, words: contentWords(sentence) })));

  it("pairs sentences from different files that share a content word, most overlap first", () => {
    const left = split([memory("a.md", "Production deploys happen on Tuesdays only. Sam likes tea a lot.")]);
    const right = split([
      memory("b.md", "Deploys go out on Tuesdays and Thursdays. Tide readings are in metres."),
      memory("a.md", "Production deploys are on Tuesdays."),
    ]);
    const found = candidatePairs(left, right, 10);
    expect(found.pairs.map(([a, b]) => [a.sentence, b.sentence])).toEqual([
      ["Production deploys happen on Tuesdays only.", "Deploys go out on Tuesdays and Thursdays."],
    ]);
    // Considered: 2 left x 2 cross-file right; 3 share no content word.
    expect(found.skipped).toBe(3);
    expect(found.skippedOverCap).toBe(0);
  });

  it("needs two shared content words: one shared topic word is not the same subject", () => {
    const left = split([memory("a.md", "Staging key for the tidepool smoke test.")]);
    const right = split([memory("b.md", "The v1 compatibility tests were removed.")]);
    expect(candidatePairs(left, right, 10).pairs).toHaveLength(0);
    const v1 = split([memory("c.md", "Before every release, run the v1 compatibility tests.")]);
    expect(candidatePairs(v1, right, 10).pairs).toHaveLength(1);
  });

  it("counts pairs dropped by the cap separately", () => {
    const left = split([
      memory("a.md", "Deploys happen on Tuesdays. Deploys happen at noon. Deploys happen after approval."),
    ]);
    const right = split([memory("b.md", "Deploys happen on Thursdays.")]);
    const found = candidatePairs(left, right, 1);
    expect(found.pairs).toHaveLength(1);
    expect(found.pairs[0]?.[0].sentence).toBe("Deploys happen on Tuesdays.");
    expect(found.skippedOverCap).toBe(2);
    expect(found.skipped).toBe(2);
  });
});

describe("the contradiction check", () => {
  const ONLY = "Production deploys happen on Tuesdays only.";
  const AND = "Deploys go out on Tuesdays and Thursdays.";

  it("scores both directions and keeps the larger contradiction probability", async () => {
    const engine = stubEngine({ [`${AND} => ${ONLY}`]: 0.4, [`${ONLY} => ${AND}`]: 0.97 });
    const result = await checkProposal(
      engine,
      { file: "deploy-window.md", source: "proposal", proposalId: "r-2", text: AND },
      [memory("release.md", ONLY)],
    );
    expect(engine.calls).toEqual([
      [AND, ONLY],
      [ONLY, AND],
    ]);
    expect(result).toMatchObject({ model: { id: "stub/nli" }, pairs: 1, threshold: CONTRADICTION_THRESHOLD });
    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0]).toMatchObject({
      score: 0.97,
      a: { file: "deploy-window.md", source: "proposal", proposalId: "r-2", sentence: AND },
      b: { file: "release.md", source: "memory", sentence: ONLY },
    });
    expect(result.contradictions[0]?.ab.contradiction).toBe(0.4);
    expect(result.contradictions[0]?.ba.contradiction).toBe(0.97);
  });

  it("flags at the threshold and not below it", async () => {
    const engine = stubEngine({
      [`${AND} => ${ONLY}`]: CONTRADICTION_THRESHOLD,
      "Deploys need two approvals. => Production deploys need one approval.": CONTRADICTION_THRESHOLD - 0.001,
    });
    const result = await checkProposal(
      engine,
      { file: "p.md", source: "proposal", proposalId: "r-1", text: `${AND}\nDeploys need two approvals.` },
      [memory("m.md", `${ONLY}\nProduction deploys need one approval.`)],
    );
    expect(result.contradictions.map((c) => c.a.sentence)).toEqual([AND]);
  });

  it("does not compare a proposal with the file it replaces, or with itself", async () => {
    const engine = stubEngine({ [`${AND} => ${ONLY}`]: 0.99 });
    const result = await checkProposal(
      engine,
      { file: "deploy-window.md", source: "proposal", proposalId: "r-2", text: AND },
      [
        memory("deploy-window.md", ONLY),
        { file: "other.md", source: "proposal", proposalId: "r-2", text: ONLY },
        { file: "staging.md", source: "proposal", proposalId: "r-3", text: ONLY },
      ],
    );
    expect(result.pairs).toBe(1);
    expect(result.contradictions.map((c) => c.b)).toEqual([
      { file: "staging.md", source: "proposal", proposalId: "r-3", sentence: ONLY },
    ]);
  });

  it("finds contradictions already inside a memory set, sorted by score", async () => {
    const engine = stubEngine({
      "Run the v1 compatibility tests before every release. => The v1 compatibility tests were removed.": 0.9,
      [`${ONLY} => ${AND}`]: 0.95,
    });
    const result = await checkMemorySet(engine, [
      memory("release.md", `Run the v1 compatibility tests before every release.\n${ONLY}`),
      memory("api.md", "The v1 compatibility tests were removed."),
      memory("deploy.md", AND),
    ]);
    expect(result.contradictions.map((c) => [c.a.file, c.b.file, c.score])).toEqual([
      ["release.md", "deploy.md", 0.95],
      ["release.md", "api.md", 0.9],
    ]);
  });

  it("does not call the model when nothing shares a word", async () => {
    const engine = stubEngine({});
    const result = await checkMemorySet(engine, [
      memory("a.md", "Sam prefers tea to coffee."),
      memory("b.md", "High tide is above 2.5 metres."),
    ]);
    expect(engine.calls).toEqual([]);
    expect(result).toMatchObject({ pairs: 0, skipped: 1, contradictions: [] });
  });
});

describe("the model files", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "dreaming-models-")));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const FILES = { "config.json": '{"id2label":{}}', "onnx/model.onnx": "x".repeat(70_000) };

  function spec(base: string, overrides: Partial<Record<string, string>> = {}): ModelSpec {
    return {
      ...NLI_MODEL,
      id: "test/tiny",
      revision: "abc123",
      weight: "onnx/model.onnx",
      files: Object.entries(FILES).map(([file, body]) => ({
        file,
        bytes: Buffer.byteLength(body),
        sha256: overrides[file] ?? sha(body),
        url: `${base}/${file}`,
      })),
    };
  }

  async function place(dir: string, files: Record<string, string>) {
    for (const [file, body] of Object.entries(files)) {
      await mkdir(join(modelPath(dir, spec("")), file, ".."), { recursive: true });
      await writeFile(join(modelPath(dir, spec("")), file), body);
    }
  }

  it("pins the shared model's exact files, and states its size", () => {
    expect(NLI_MODEL.files.find((f) => f.file === NLI_MODEL.weight)).toMatchObject({
      bytes: 87246587,
      sha256: "3fac2500c45c75af42c7711de0d1b93d59577456100208be0dc1f9e8811946b6",
    });
    expect(modelBytes(NLI_MODEL)).toBe(95905926);
    for (const file of NLI_MODEL.files) expect(file.url).toContain(`/resolve/${NLI_MODEL.revision}/${file.file}`);
  });

  it("looks in DREAMING_MODELS or the dreaming home first, then the extra folders", () => {
    expect(modelDirs({}, "/h/.dreaming", ["/shared"])).toEqual(["/h/.dreaming/models", "/shared"]);
    expect(modelDirs({ DREAMING_MODELS: "/m" }, "/h/.dreaming", ["/shared", "/m"])).toEqual(["/m", "/shared"]);
  });

  it("finds the first folder with every file at its size, and re-hashes on demand", async () => {
    const partial = join(root, "partial");
    const full = join(root, "full");
    await place(partial, { "config.json": FILES["config.json"] });
    await place(full, FILES);
    expect(await findModel([join(root, "none"), partial, full], spec(""))).toEqual({
      dir: full,
      path: modelPath(full, spec("")),
    });
    expect(await findModel([partial], spec(""))).toBeNull();
    expect(await verifyModel(modelPath(full, spec("")), spec(""))).toEqual([]);
    await writeFile(join(modelPath(full, spec("")), "config.json"), '{"id2label":[]}');
    expect(await verifyModel(modelPath(full, spec("")), spec(""))).toEqual(["config.json"]);
  });

  describe("downloading", () => {
    let server: Server;
    let base: string;
    const hits: string[] = [];
    let stall = false;

    beforeEach(async () => {
      hits.length = 0;
      stall = false;
      server = createServer((req, res) => {
        const file = (req.url ?? "").slice(1);
        hits.push(file);
        const body = Object.entries(FILES).find(([name]) => name === file)?.[1];
        if (body === undefined) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        if (stall) {
          res.write(body.slice(0, 1000)); // then never finish, until the client gives up
          return;
        }
        res.end(body);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      base = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "";
    });
    afterEach(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    });

    const plenty = () => Promise.resolve(1e12);
    const leftovers = async (dir: string) =>
      (await readdir(dir, { recursive: true })).filter((name) => name.endsWith(".part"));

    it("states the size, reports progress, checks hashes and renames into place", async () => {
      const progress: DownloadProgress[] = [];
      const path = await downloadModel(root, {
        spec: spec(base),
        freeBytes: plenty,
        onProgress: (p) => progress.push(p),
      });
      expect(progress[0]).toEqual({ kind: "start", totalBytes: 70_015, files: 2 });
      expect(progress.at(-1)).toEqual({ kind: "done", totalBytes: 70_015, path });
      expect(progress.filter((p) => p.kind === "bytes").at(-1)).toMatchObject({ totalReceived: 70_015 });
      expect(await findModel([root], spec(base))).toMatchObject({ path });
      expect(await verifyModel(path, spec(base))).toEqual([]);
      expect(await leftovers(root)).toEqual([]);
    });

    it("keeps files that are already complete and fetches only the rest", async () => {
      await place(root, { "config.json": FILES["config.json"] });
      await downloadModel(root, { spec: spec(base), freeBytes: plenty });
      expect(hits).toEqual(["onnx/model.onnx"]);
    });

    it("refuses a file whose hash does not match, and keeps nothing partial", async () => {
      const bad = spec(base, { "onnx/model.onnx": "0".repeat(64) });
      await expect(downloadModel(root, { spec: bad, freeBytes: plenty })).rejects.toThrow(
        /model download failed: onnx\/model.onnx does not match its published SHA-256/,
      );
      expect(await leftovers(root)).toEqual([]);
      expect(await findModel([root], bad)).toBeNull();
    });

    it("cancels cleanly: no partial file, and says the download was cancelled", async () => {
      stall = true;
      const controller = new AbortController();
      const attempt = downloadModel(root, {
        spec: spec(base),
        freeBytes: plenty,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.kind === "bytes") controller.abort();
        },
      });
      await expect(attempt).rejects.toThrow(DreamingError);
      await expect(attempt).rejects.toThrow("model download cancelled");
      expect(await leftovers(root)).toEqual([]);
    });

    it("reports a server error plainly", async () => {
      const missing: ModelSpec = {
        ...spec(base),
        files: [{ file: "nope.bin", bytes: 3, sha256: sha("abc"), url: `${base}/nope.bin` }],
      };
      await expect(downloadModel(root, { spec: missing, freeBytes: plenty })).rejects.toThrow(
        "model download failed: the server answered 404 for nope.bin",
      );
      expect(await leftovers(root)).toEqual([]);
    });

    it("refuses to start when the disk is too full, before fetching anything", async () => {
      await expect(downloadModel(root, { spec: spec(base), freeBytes: () => Promise.resolve(1000) })).rejects.toThrow(
        /not enough disk space for the model: it needs 0.1 MB, and 0.0 MB is free/,
      );
      expect(hits).toEqual([]);
    });
  });
});

describe("loading the engine", () => {
  it("says what is missing, instead of failing, when the runtime packages are not installed", async () => {
    const empty = await realpath(await mkdtemp(join(tmpdir(), "dreaming-noruntime-")));
    try {
      const result = await loadNliEngine(join(empty, "model"), { runtimeFrom: empty });
      expect(result).toEqual({
        ok: false,
        reason:
          "the contradiction check needs the optional packages onnxruntime-web and @huggingface/tokenizers, which are not installed",
      });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  // Runs the real model only where its weights are on disk: DREAMING_NLI_MODEL_DIR=<models folder>
  // (and DREAMING_NLI_RUNTIME_FROM=<project> if the runtime packages are installed elsewhere).
  const modelDir = process.env.DREAMING_NLI_MODEL_DIR;
  it.skipIf(modelDir === undefined || modelDir === "")(
    "runs the real model: right labels, same scores every time",
    async () => {
      const found = await findModel([modelDir ?? ""]);
      expect(found).not.toBeNull();
      const loaded = await loadNliEngine(found?.path ?? "", { runtimeFrom: process.env.DREAMING_NLI_RUNTIME_FROM });
      if (!loaded.ok) throw new Error(loaded.reason);
      const { engine } = loaded;
      try {
        const [deploy, sam] = await engine.classify([
          ["Production deploys happen on Tuesdays only.", "Deploys go out on Tuesdays and Thursdays."],
          ["Sam is a backend engineer.", "Sam works on the backend."],
        ]);
        expect(deploy?.contradiction).toBeGreaterThan(0.9);
        expect(sam?.entailment).toBeGreaterThan(0.9);
        const again = await engine.classify([["Sam is a backend engineer.", "Sam works on the backend."]]);
        expect(again[0]).toEqual(sam);

        const result = await checkProposal(
          engine,
          memoryText(
            "api-v2-deadline.md",
            "---\nname: api-v2-deadline\ndescription: The v2 API is live (since 30 October 2026); /v1 returns 410\n---\n\nThe v1 compatibility tests were removed.\n",
            "proposal",
            "r-3",
          ),
          [
            memory("release-checklist.md", "Run the v1 compatibility tests before every release."),
            memory("user-role.md", "Sam is a backend engineer on tidepool."),
          ],
        );
        expect(result.contradictions[0]).toMatchObject({
          a: { sentence: "The v1 compatibility tests were removed." },
          b: { file: "release-checklist.md" },
        });
      } finally {
        await engine.close();
      }
    },
  );
});
