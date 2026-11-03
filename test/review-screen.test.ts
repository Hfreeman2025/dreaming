import { readdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredProposal } from "../src/inbox/schema.js";
import { loadRuns, saveRun } from "../src/inbox/store.js";
import { review, type ReviewSummary } from "../src/review/session.js";
import { textWidth } from "../src/ui/text.js";
import {
  ADD,
  DELETE_UNVERIFIED,
  DEPLOY,
  INDEX,
  UPDATE,
  runRecord,
  scriptedScreen,
  type Press,
} from "./helpers/review-fixtures.js";
import { NOW, makeSandbox, readMemory, writeMemory, type Sandbox } from "./helpers/sandbox.js";

describe("dreaming review (full screen)", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
    await writeMemory(sandbox, "deploy-window.md", DEPLOY);
    await writeMemory(sandbox, "MEMORY.md", INDEX);
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  async function run(
    proposals: StoredProposal[],
    presses: Press[],
    options: { size?: { columns: number; rows: number }; dryRun?: boolean; edits?: ((s: string) => string)[] } = {},
  ): Promise<{ summary: ReviewSummary; screen: ReturnType<typeof scriptedScreen> }> {
    await saveRun(sandbox.paths.inbox, runRecord(proposals, sandbox.memoryDir));
    const screen = scriptedScreen(presses, options.size, options.edits);
    const summary = await review(
      {
        paths: sandbox.paths,
        memoryDir: sandbox.memoryDir,
        now: () => NOW,
        dryRun: options.dryRun ?? false,
        allowUnverified: false,
      },
      { kind: "screen", terminal: screen },
    );
    return { summary, screen };
  }

  it("opens on the first proposal: the list, its evidence and its diff, with the keys", async () => {
    const { screen } = await run([ADD, UPDATE], []);
    const first = screen.frames[0] ?? [];
    expect(first).toHaveLength(30);
    expect(first[0]).toMatch(/^dreaming review {2}2 proposals from 1 dream +0 ✓ {2}0 ✗ {2}2 to go$/);
    // Columns: decision, action, file, type, confidence, evidence, then the line counts beside them.
    expect(first[2]).toMatch(/^› ○ add {4}prefer-pnpm\.md +feedback {3}high {4}1\/1 ✓ {3}\+9 *$/);
    expect(first[3]).toMatch(/^ {2}○ update {1}deploy-window\.md +project {4}high {4}1\/1 ✓ {3}\+3 −3 *$/);
    const text = first.join("\n");
    expect(text).toContain("ADD  prefer-pnpm.md");
    expect(text).toContain("feedback · high confidence · 1 of 2");
    expect(text).toContain("  ┃ ✓ verified · S1 · /work/tidepool · session 11111111 · line 7");
    expect(text).toContain("prefer-pnpm.md  new file  +8");
    expect(first.at(-1)).toContain("a approve  r reject  e edit  s skip");
  });

  it("approves, moves to the next undecided proposal, and counts", async () => {
    const { screen } = await run([ADD, UPDATE], ["a"]);
    const after = screen.frames[1] ?? [];
    expect(after[0]).toContain("1 ✓  0 ✗  1 to go");
    expect(after[2]).toMatch(/^ {2}✓ add/);
    expect(after[3]).toMatch(/^› ○ update/);
    expect(after.join("\n")).toContain("UPDATE  deploy-window.md");
  });

  it("refuses to approve unverified evidence and says why on the status line", async () => {
    const { screen } = await run([DELETE_UNVERIFIED], ["a"]);
    const after = screen.frames[1] ?? [];
    expect(after.at(-2)).toMatch(/^Can't approve this one \(the reason is above\)\. r rejects it, s skips it\./);
    expect(after[2]).toMatch(/^› ○ delete/);
  });

  it("says the same in fewer words on a narrow screen, rather than cutting it off", async () => {
    const { screen } = await run([DELETE_UNVERIFIED], ["a"], { size: { columns: 50, rows: 20 } });
    expect((screen.frames[1] ?? []).at(-2)?.trimEnd()).toBe("Can't approve this one; r rejects, s skips.");
  });

  it("toggles a help overlay listing every key", async () => {
    const { screen } = await run([ADD], ["?", "?"]);
    const help = (screen.frames[1] ?? []).join("\n");
    expect(help).toContain("Keys");
    expect(help).toContain("u         undo the decision");
    expect(help).toContain("Nothing is written until you submit and confirm the combined diff.");
    expect((screen.frames[2] ?? []).join("\n")).toContain("ADD  prefer-pnpm.md");
  });

  it("scrolls long content and shows where you are", async () => {
    const long = { ...ADD, body: Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long memory.`).join("\n") };
    const { screen } = await run([long], ["down", "down", "space"], { size: { columns: 100, rows: 24 } });
    const first = screen.frames[0] ?? [];
    expect(first.some((line) => /1–\d+ of \d+ ↓$/.test(line))).toBe(true);
    const scrolled = screen.frames[3] ?? [];
    expect(scrolled.some((line) => /\d+–\d+ of \d+/.test(line) && !line.includes(" 1–"))).toBe(true);
  });

  it("goes to the submit view when everything is decided, then applies on y", async () => {
    const { summary, screen } = await run([ADD, UPDATE], ["a", "r", "y"]);
    const submit = (screen.frames[2] ?? []).join("\n");
    expect(submit).toContain("Submit review");
    expect(submit).toContain("✓ approve   add    prefer-pnpm.md");
    expect(submit).toContain("✗ reject    update deploy-window.md");
    expect(submit).toContain(`Changes to ${sandbox.memoryDir}`);
    expect(summary.outcome).toBe("applied");
    expect(await readMemory(sandbox, "prefer-pnpm.md")).toContain("name: prefer-pnpm");
    expect(screen.output).toContain("Applied 1 change to");
    const [run1] = await loadRuns(sandbox.paths.inbox);
    expect(run1?.proposals.map((p) => p.status)).toEqual(["applied", "rejected"]);
  });

  it("lets you change your mind before submitting (undo, then back from submit)", async () => {
    const { summary } = await run([ADD], ["a", "n", "u", "r", "y"]);
    expect(summary).toMatchObject({ approved: 0, rejected: 1, outcome: "applied" });
    expect(await readdir(sandbox.memoryDir)).toEqual(["MEMORY.md", "deploy-window.md"]);
  });

  it("asks before discarding decisions on quit, and writes nothing", async () => {
    const { summary, screen } = await run([ADD, UPDATE], ["a", "q", "y"]);
    expect((screen.frames[2] ?? []).at(-1)).toContain("Quit and discard 1 decision? y quit  n stay");
    expect(summary.outcome).toBe("abandoned");
    expect(screen.output).toBe("Quit without submitting; nothing was written.\n");
    expect(await readdir(sandbox.memoryDir)).toEqual(["MEMORY.md", "deploy-window.md"]);
  });

  it("stops at once on Ctrl-C, writing nothing", async () => {
    const { summary, screen } = await run([ADD], ["a", { name: "c", ctrl: true, shift: false }]);
    expect(summary.outcome).toBe("abandoned");
    expect(screen.output).toBe("Review interrupted; nothing was written.\n");
  });

  it("edits in $EDITOR and shows the edited version", async () => {
    const { screen } = await run([ADD], ["e", "a", "y"], {
      edits: [(text) => text.replace("Use pnpm, not npm", "Always pnpm")],
    });
    const edited = (screen.frames[1] ?? []).join("\n");
    expect(edited).toContain("ADD  prefer-pnpm.md  edited");
    expect(edited).toContain("Edited. The diff now shows your version.");
    expect(await readMemory(sandbox, "prefer-pnpm.md")).toContain("description: Always pnpm");
  });

  it("shows conflicting approvals in the submit view and refuses to submit them", async () => {
    const { summary, screen } = await run(
      [ADD, UPDATE],
      [
        "a",
        async () => {
          await writeMemory(sandbox, "deploy-window.md", DEPLOY.replace("Tuesdays.", "Tuesdays (by hand)."));
          return "a";
        },
        "y",
        "q",
        "y",
      ],
    );
    expect((screen.frames[2] ?? []).join("\n")).toContain("These approvals cannot be applied together:");
    expect((screen.frames[3] ?? []).at(-2)).toContain("These approvals conflict; go back (n) and change one.");
    expect(summary.outcome).toBe("abandoned");
    expect(await readdir(sandbox.memoryDir)).toEqual(["MEMORY.md", "deploy-window.md"]);
  });

  it("dry run: y finishes without writing", async () => {
    const { summary, screen } = await run([ADD], ["a", "y"], { dryRun: true });
    expect((screen.frames[1] ?? []).join("\n")).toContain("Submit review (dry run: nothing will be written)");
    expect(summary.outcome).toBe("dry-run");
    expect(await readdir(sandbox.memoryDir)).toEqual(["MEMORY.md", "deploy-window.md"]);
  });

  it("fits a narrow terminal: every line within 60 columns, columns dropped from the list", async () => {
    const { screen } = await run([ADD, UPDATE, DELETE_UNVERIFIED], ["right", "?"], { size: { columns: 60, rows: 24 } });
    for (const frame of screen.frames) {
      expect(frame).toHaveLength(24);
      for (const line of frame) expect(textWidth(line)).toBeLessThanOrEqual(60);
    }
    expect((screen.frames[0] ?? [])[2]).not.toContain("feedback");
  });

  it("explains, rather than garbles, a terminal that is too small", async () => {
    const { screen } = await run([ADD], ["q"], { size: { columns: 40, rows: 10 } });
    expect((screen.frames[0] ?? []).join(" ")).toContain(
      "The review needs a terminal of at least 50×14; this one is 40×10.",
    );
  });
});
