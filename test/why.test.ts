import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderWhy, when } from "../src/commands/why.js";
import type { StoredProposal } from "../src/inbox/schema.js";
import { saveRun } from "../src/inbox/store.js";
import { createRedactor } from "../src/redact.js";
import { review } from "../src/review/session.js";
import { toPlain } from "../src/ui/text.js";
import { provenance } from "../src/why.js";
import { ADD, DEPLOY, INDEX, UPDATE, runRecord, scriptedIO, sha256 } from "./helpers/review-fixtures.js";
import { NOW, jsonl, makeSandbox, userEntry, writeMemory, type Sandbox } from "./helpers/sandbox.js";

const QUOTE = "we deploy on Tuesdays and Thursdays now";

describe("dreaming why", () => {
  let sandbox: Sandbox;
  let transcript: string;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    await writeMemory(sandbox, "deploy-window.md", DEPLOY);
    await writeMemory(sandbox, "MEMORY.md", INDEX);
    transcript = join(sandbox.projectsDir, "s1.jsonl");
    await writeFile(
      transcript,
      jsonl([userEntry("Heads up: the release train changed, so we deploy on Tuesdays and Thursdays now.")]),
    );
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  /** Put proposals through a real review (approve all, submit) so the audit log is the real thing. */
  async function apply(proposals: StoredProposal[]): Promise<void> {
    const record = runRecord(
      proposals.map((p) => ({
        ...p,
        evidence: [{ session: "S1", quote: QUOTE, status: "verified", line: 1, source: QUOTE }],
      })),
      sandbox.memoryDir,
    );
    const session = record.sessions[0];
    if (session) record.sessions[0] = { ...session, path: transcript };
    await saveRun(sandbox.paths.inbox, record);
    await review(
      { paths: sandbox.paths, memoryDir: sandbox.memoryDir, now: () => NOW, dryRun: false, allowUnverified: false },
      { kind: "plain", io: scriptedIO([...proposals.map(() => "a"), "y"]) },
    );
  }
  const why = (query: string) => provenance(sandbox.memoryDir, sandbox.paths.auditLog, query, createRedactor());

  it("traces an applied memory to its dream, its reason and its evidence, still in the transcript", async () => {
    await apply([ADD]);
    const result = await why("prefer-pnpm");
    expect(result).toMatchObject({ file: "prefer-pnpm.md", exists: true, state: "matches", type: "feedback" });
    expect(result.history).toHaveLength(1);
    const [entry] = result.history;
    expect(entry?.entry).toMatchObject({
      action: "add",
      runId: "20261101-020000-abcd",
      confidence: "high",
      edited: false,
    });
    expect(entry?.evidence[0]?.recheck).toEqual({ kind: "still-there" });
    expect(entry?.evidence[0]?.session?.path).toBe(transcript);

    const text = renderWhy(result, 100).map(toPlain).join("\n");
    expect(text).toContain("✓ The file is exactly what dreaming last wrote.");
    expect(text).toContain(
      `${when(NOW.toISOString())}  added\n  dream 20261101-020000-abcd · proposal 1 · high confidence · approved as proposed`,
    );
    expect(text).toContain("  ┃ ✓ still in the transcript · S1 · /work/tidepool · session 11111111 · line 1");
    expect(text).toContain("✓ 1 of 1 evidence quote is still in its transcript");
    expect(text).toContain("  ┃ reopen it   claude --resume 11111111-aaaa-4aaa-8aaa-111111111111");
  });

  it("notices when the file has changed since dreaming wrote it", async () => {
    await apply([ADD]);
    await writeMemory(sandbox, "prefer-pnpm.md", "---\nname: prefer-pnpm\n---\n\nChanged by hand.\n");
    expect((await why("prefer-pnpm.md")).state).toBe("changed-since");
  });

  it("says when the transcript has gone, or no longer says what was quoted", async () => {
    await apply([ADD]);
    await writeFile(transcript, jsonl([userEntry("Something else entirely was said on this line.")]));
    expect((await why("prefer-pnpm")).history[0]?.evidence[0]?.recheck).toEqual({ kind: "changed" });
    await rm(transcript);
    expect((await why("prefer-pnpm")).history[0]?.evidence[0]?.recheck).toEqual({ kind: "transcript-gone" });
  });

  it("follows a memory through an update, oldest change first", async () => {
    await apply([UPDATE]);
    const result = await why("deploy-window");
    expect(result.state).toBe("matches");
    expect(result.history.map((h) => [h.entry.action, h.entry.beforeHash])).toEqual([["update", sha256(DEPLOY)]]);
    expect(result.description).toBe("Deploys happen on Tuesdays and Thursdays");
  });

  it("records a deletion", async () => {
    const del: StoredProposal = {
      action: "delete",
      id: `${ADD.id.slice(0, -2)}-3`,
      file: "deploy-window.md",
      name: "deploy-window",
      baseHash: sha256(DEPLOY),
      reason: "Obsolete.",
      confidence: "medium",
      evidence: [],
      problems: [],
      status: "pending",
    };
    await apply([del]);
    const result = await why("deploy-window");
    expect(result).toMatchObject({ exists: false, state: "deleted-by-dreaming" });
  });

  it("says plainly when a memory has no dreaming history", async () => {
    const result = await why("deploy-window");
    expect(result).toMatchObject({
      state: "no-history",
      history: [],
      description: "Deploys happen on Tuesdays",
      lastDescription: undefined,
    });
    expect(renderWhy(result, 100).map(toPlain).join("\n")).toContain("No dreaming history");
  });

  it("finds a memory by its frontmatter name too", async () => {
    await writeMemory(sandbox, "user_profile.md", "---\nname: user-profile\ndescription: d\n---\n\nb\n");
    expect((await why("user-profile")).file).toBe("user_profile.md");
  });

  it("refuses unknown memories and anything that looks like a path", async () => {
    await expect(why("nothing-like-this")).rejects.toThrow(/no memory named nothing-like-this/);
    await expect(why("../etc/passwd")).rejects.toThrow("not a memory name: ../etc/passwd");
  });
});
