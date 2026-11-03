import { readdir, readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../src/apply/execute.js";
import { sha256 } from "../src/fsx.js";
import { planApply } from "../src/apply/plan.js";
import type { StoredProposal } from "../src/inbox/schema.js";
import { loadRuns, saveRun } from "../src/inbox/store.js";
import { review, type ReviewSummary } from "../src/review/session.js";
import {
  ADD,
  DELETE_UNVERIFIED,
  DEPLOY,
  INDEX,
  RUN_ID,
  UPDATE,
  runRecord,
  scriptedIO,
  verified,
} from "./helpers/review-fixtures.js";
import { NOW, makeSandbox, readMemory, writeMemory, type Sandbox } from "./helpers/sandbox.js";

describe("dreaming review --plain (line by line)", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
    await writeMemory(sandbox, "deploy-window.md", DEPLOY);
    await writeMemory(sandbox, "MEMORY.md", INDEX);
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  async function reviewWith(
    proposals: StoredProposal[],
    io: ReturnType<typeof scriptedIO>,
    options: { dryRun?: boolean; allowUnverified?: boolean; memoryDir?: string } = {},
  ): Promise<ReviewSummary> {
    await saveRun(sandbox.paths.inbox, runRecord(proposals, options.memoryDir ?? sandbox.memoryDir));
    return review(
      {
        paths: sandbox.paths,
        memoryDir: sandbox.memoryDir,
        now: () => NOW,
        dryRun: options.dryRun ?? false,
        allowUnverified: options.allowUnverified ?? false,
      },
      { kind: "plain", io },
    );
  }

  const statuses = async () =>
    (await loadRuns(sandbox.paths.inbox))[0]?.proposals.map((p) => [p.id.slice(-1), p.status]);
  const auditLines = async () =>
    readFile(sandbox.paths.auditLog, "utf8").then(
      (text) => text.trim().split("\n").length,
      () => 0,
    );

  it("decides each proposal, then applies only on submit", async () => {
    const io = scriptedIO(["a", "r", "s", "y"]);
    const summary = await reviewWith([ADD, UPDATE, DELETE_UNVERIFIED], io);
    expect(summary).toMatchObject({ approved: 1, rejected: 1, skipped: 1, outcome: "applied" });
    expect(await readMemory(sandbox, "prefer-pnpm.md")).toContain("description: Use pnpm, not npm");
    expect(await readMemory(sandbox, "deploy-window.md")).toBe(DEPLOY);
    expect(await statuses()).toEqual([
      ["1", "applied"],
      ["2", "rejected"],
      ["3", "pending"],
    ]);
    expect(await auditLines()).toBe(1);
    expect(io.output).toContain("Submit: apply 1 approved and record 1 rejected? [y/N] y");
    expect(io.output).toMatch(
      /Applied 1 change to \S+\n {2}✓ added {5}prefer-pnpm\.md\n {2}✗ rejected {2}deploy-window\.md\n {2}– skipped {3}deploy-window\.md {2}still in the inbox/,
    );
    expect(io.output).toContain("Provenance dreaming why prefer-pnpm");
  });

  it("shows the transcript's own text for each piece of evidence, with its line", async () => {
    const elided = {
      ...ADD,
      evidence: [
        {
          session: "S1",
          quote: "we deploy ... Thursdays now",
          source: "we deploy on Tuesdays and Thursdays now",
          status: "verified" as const,
          line: 7,
        },
      ],
    };
    const io = scriptedIO(["s", null]);
    await reviewWith([elided], io);
    expect(io.output).toContain("  ┃ ✓ verified · S1 · /work/tidepool · session 11111111 · line 7");
    expect(io.output).toContain("  ┃ we deploy on Tuesdays and Thursdays now");
    expect(io.output).toContain('  ┃ quoted with omissions as: "we deploy ... Thursdays now"');
  });

  it("shows the change as a line-numbered diff with the index pointer", async () => {
    const io = scriptedIO(["s", null]);
    await reviewWith([UPDATE], io);
    expect(io.output).toContain("deploy-window.md  modified  +2 −2");
    expect(io.output).toContain("   3 − description: Deploys happen on Tuesdays\n");
    expect(io.output).toContain("   3 + description: Deploys happen on Tuesdays and Thursdays\n");
    expect(io.output).toContain("MEMORY.md  modified  +1 −1");
  });

  it("blocks approval when evidence could not be verified, unless overridden", async () => {
    const blocked = scriptedIO(["a", "r", "n"]);
    await reviewWith([DELETE_UNVERIFIED], blocked);
    expect(blocked.output).toContain("✗ Can't approve: 1 evidence quote could not be found in the cited session");
    expect(blocked.output).toContain("--allow-unverified");
    expect(await readMemory(sandbox, "deploy-window.md")).toBe(DEPLOY);
  });

  it("allows an unverified proposal with --allow-unverified, noting it", async () => {
    const io = scriptedIO(["a", "y"]);
    await reviewWith([DELETE_UNVERIFIED], io, { allowUnverified: true });
    expect(io.output).toContain("! 1 evidence quote was not found; approval allowed by --allow-unverified");
    expect(await readdir(sandbox.memoryDir)).toEqual(["MEMORY.md"]);
  });

  it("warns when approving would save a redaction marker instead of a secret", async () => {
    const io = scriptedIO(["s", "n"]);
    await reviewWith([{ ...ADD, body: "Smoke tests use the staging key [REDACTED:anthropic-key]." }], io);
    expect(io.output.replaceAll("\n  ", " ")).toContain(
      "! this would save [REDACTED:anthropic-key] into memory, not the secret: it was redacted before the agent saw it. Edit it out, or reject.",
    );
  });

  it("does not warn about a marker that memory already holds", async () => {
    const before = DEPLOY.replace(
      "Deploys go out on Tuesdays.",
      "Deploys go out on Tuesdays; token [REDACTED:bearer].",
    );
    expect(before).not.toBe(DEPLOY);
    await writeMemory(sandbox, "deploy-window.md", before);
    const io = scriptedIO(["s", "n"]);
    await reviewWith(
      [{ ...UPDATE, baseHash: sha256(before), body: "Tuesdays and Thursdays; token [REDACTED:bearer]." }],
      io,
    );
    expect(io.output).not.toContain("would save");
  });

  it("blocks a proposal whose target was edited by hand since the dream", async () => {
    await writeMemory(sandbox, "deploy-window.md", DEPLOY.replace("Tuesdays.", "Tuesdays only."));
    const io = scriptedIO(["a", "s", null]);
    await reviewWith([UPDATE], io);
    expect(io.output).toContain("Can't approve: deploy-window.md has changed since this proposal was made");
    expect(await readMemory(sandbox, "deploy-window.md")).toContain("Tuesdays only.");
  });

  it("blocks proposals made for a different memory directory", async () => {
    const io = scriptedIO(["a", "s", null]);
    await reviewWith([ADD], io, { memoryDir: "/somewhere/else/memory" });
    expect(io.output).toContain("Can't approve: this proposal was made for /somewhere/else/memory");
    expect(await readdir(sandbox.memoryDir)).toEqual(["MEMORY.md", "deploy-window.md"]);
  });

  it("--dry-run shows the submission and writes nothing, decisions included", async () => {
    const io = scriptedIO(["a", "r"]);
    const summary = await reviewWith([ADD, UPDATE], io, { dryRun: true });
    expect(summary.outcome).toBe("dry-run");
    expect(io.output).toContain("Submit review (dry run: nothing will be written)");
    expect(io.output).toContain("prefer-pnpm.md  new file  +8");
    expect(io.output).toContain("Dry run: nothing was written.");
    expect(await readdir(sandbox.memoryDir)).toEqual(["MEMORY.md", "deploy-window.md"]);
    expect(await statuses()).toEqual([
      ["1", "pending"],
      ["2", "pending"],
    ]);
  });

  it("writes nothing, not even rejections, when the submission is declined", async () => {
    const io = scriptedIO(["a", "r", "n"]);
    const summary = await reviewWith([ADD, UPDATE], io);
    expect(summary.outcome).toBe("abandoned");
    expect(io.output).toContain("Not submitted; nothing was written.");
    expect(await readdir(sandbox.memoryDir)).toEqual(["MEMORY.md", "deploy-window.md"]);
    expect(await statuses()).toEqual([
      ["1", "pending"],
      ["2", "pending"],
    ]);
  });

  it("q stops early and goes to the submit step", async () => {
    const io = scriptedIO(["a", "q", "y"]);
    const summary = await reviewWith([ADD, UPDATE], io);
    expect(summary).toMatchObject({ approved: 1, skipped: 0, outcome: "applied" });
    expect(await statuses()).toEqual([
      ["1", "applied"],
      ["2", "pending"],
    ]);
  });

  it("stops cleanly when input ends, writing nothing", async () => {
    const io = scriptedIO(["a", null]);
    const summary = await reviewWith([ADD, UPDATE], io);
    expect(summary.outcome).toBe("abandoned");
    expect(io.output).toContain("Input ended; nothing was written.");
    expect(await readdir(sandbox.memoryDir)).toEqual(["MEMORY.md", "deploy-window.md"]);
  });

  it("reports a conflict, and applies nothing, when memory changes before submitting", async () => {
    const io = scriptedIO([
      "a",
      async () => {
        await writeMemory(sandbox, "deploy-window.md", DEPLOY.replace("Tuesdays.", "Tuesdays (edited meanwhile)."));
        return "a";
      },
    ]);
    const summary = await reviewWith([ADD, UPDATE], io);
    expect(summary.outcome).toBe("conflict");
    expect(io.output).toContain("These approvals cannot be applied together:");
    expect(await readdir(sandbox.memoryDir)).toEqual(["MEMORY.md", "deploy-window.md"]);
  });

  it("refuses to write when memory changes after the diff is shown", async () => {
    const io = scriptedIO([
      "a",
      async () => {
        await writeMemory(sandbox, "MEMORY.md", `${INDEX}- [hand](hand.md) — added meanwhile\n`);
        return "y";
      },
    ]);
    await expect(reviewWith([ADD], io)).rejects.toThrow(
      "MEMORY.md changed after the diff was shown; nothing was written",
    );
    expect(await readdir(sandbox.memoryDir)).toEqual(["MEMORY.md", "deploy-window.md"]);
  });

  it("lets a person edit a proposal before approving it", async () => {
    const io = scriptedIO(
      ["e", "a", "y"],
      [(initial) => initial.replace("Use pnpm, not npm", "Always pnpm in tidepool")],
    );
    await reviewWith([ADD], io);
    expect(io.output).toContain("ADD  prefer-pnpm.md  edited");
    expect(await readMemory(sandbox, "prefer-pnpm.md")).toContain("description: Always pnpm in tidepool");
    expect(await readMemory(sandbox, "MEMORY.md")).toContain("— Always pnpm in tidepool");
    const audit = await readFile(sandbox.paths.auditLog, "utf8");
    expect(audit).toContain(`"proposalId":"${ADD.id}"`);
    expect(audit).toContain('"edited":true');
    expect(audit).toContain('"description":"Always pnpm in tidepool"');
  });

  it("rejects an invalid edit with reasons and keeps the draft for the next attempt", async () => {
    let secondInitial = "";
    const io = scriptedIO(
      ["e", "e", "a", "y"],
      [
        (initial) => initial.replace("type: feedback", "type: opinion"),
        (initial) => {
          secondInitial = initial;
          return initial.replace("type: opinion", "type: user");
        },
      ],
    );
    await reviewWith([ADD], io);
    expect(io.output).toContain(
      "The edited file is not valid; press e to fix it:\n  - type: must be one of user, feedback, project, reference",
    );
    expect(secondInitial).toContain("type: opinion");
    expect(await readMemory(sandbox, "prefer-pnpm.md")).toContain("type: user");
  });

  it("does not offer to edit a delete", async () => {
    const io = scriptedIO(["e", "s", null]);
    await reviewWith([{ ...DELETE_UNVERIFIED, evidence: verified, problems: [] }], io);
    expect(io.output).toContain("A delete has nothing to edit.");
  });

  it("strips terminal escape sequences from proposal text", async () => {
    const hostile = { ...ADD, reason: "innocent\u001b[2J\u001b[1;1Hreplaced screen\u0007" };
    const io = scriptedIO(["s", null]);
    await reviewWith([hostile], io);
    expect(io.output).not.toContain("\u001b");
    expect(io.output).not.toContain("\u0007");
    expect(io.output).toContain("innocentreplaced screen");
  });

  it("recovers when memory was applied but the inbox was never updated", async () => {
    // Simulate a crash between applying and recording the decision.
    const plan = await planApply(sandbox.memoryDir, [{ runId: RUN_ID, proposal: ADD }]);
    if (!plan.ok) throw new Error("plan failed");
    await executePlan(plan.plan, {
      applyId: "x",
      backupDir: `${sandbox.root}/b`,
      auditLog: `${sandbox.root}/audit`,
      now: NOW,
    });
    const io = scriptedIO(["a", "y"]);
    await reviewWith([ADD], io);
    expect(io.output).toContain("! memory already matches this proposal; approving records it as applied");
    expect(io.output).toContain("Applied 0 changes (1 already in place)");
    expect(await statuses()).toEqual([["1", "applied"]]);
  });

  it("says so when there is nothing to review", async () => {
    const io = scriptedIO([]);
    const summary = await review(
      { paths: sandbox.paths, memoryDir: sandbox.memoryDir, now: () => NOW, dryRun: false, allowUnverified: false },
      { kind: "plain", io },
    );
    expect(summary.outcome).toBe("nothing-pending");
    expect(io.output).toBe(
      "No proposals are waiting for review.\n\nNext  dreaming run  file new proposals from recent sessions\n",
    );
  });

  it("records rejections alone when nothing is approved", async () => {
    const io = scriptedIO(["r", "y"]);
    await reviewWith([ADD], io);
    expect(io.output).toContain("Submit: record 1 rejected? [y/N] y");
    expect(io.output).toContain("Recorded the decisions; no memory files changed.");
    expect(await statuses()).toEqual([["1", "rejected"]]);
  });
});
