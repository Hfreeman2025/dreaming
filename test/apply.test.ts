import { appendFile, mkdir, readdir, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { planDiff } from "../src/apply/diff.js";
import { executePlan, realIo, type FileIo } from "../src/apply/execute.js";
import { readAudit } from "../src/audit.js";
import { planApply, type ApplyPlan, type ApprovedChange } from "../src/apply/plan.js";
import { DreamingError } from "../src/errors.js";
import { writeFileAtomic, sha256 } from "../src/fsx.js";
import type { StoredProposal } from "../src/inbox/schema.js";
import { NOW, makeSandbox, memoryFile, readMemory, writeMemory, type Sandbox } from "./helpers/sandbox.js";

const DEPLOY = memoryFile("deploy-window", "Deploys happen on Tuesdays", "project", "Deploys go out on Tuesdays.");
const INDEX = "# Memory index\n\n- [Deploy window](deploy-window.md) — Deploys happen on Tuesdays\n";

const evidence = [{ session: "S1", quote: "we deploy on Tuesdays and Thursdays now", status: "verified" as const }];
const base = { reason: "r", confidence: "high" as const, evidence, problems: [], status: "pending" as const };

function addProposal(overrides: { file?: string; name?: string } = {}): StoredProposal {
  return {
    action: "add",
    id: "20261101-070000-abcd-1",
    file: "prefer-pnpm.md",
    name: "prefer-pnpm",
    description: "Use pnpm, not npm",
    type: "feedback",
    body: "Use pnpm.\n\n**Why:** npm breaks workspace links.",
    baseHash: null,
    ...base,
    ...overrides,
  };
}

function updateProposal(): StoredProposal {
  return {
    action: "update",
    id: "20261101-070000-abcd-2",
    file: "deploy-window.md",
    name: "deploy-window",
    description: "Deploys happen on Tuesdays and Thursdays",
    type: "project",
    body: "Deploys go out on Tuesdays and Thursdays.",
    baseHash: sha256(DEPLOY),
    ...base,
  };
}

function deleteProposal(baseHash = sha256(DEPLOY)): StoredProposal {
  return {
    action: "delete",
    id: "20261101-070000-abcd-3",
    file: "deploy-window.md",
    name: "deploy-window",
    baseHash,
    ...base,
  };
}

const AuditLine = z.record(z.string(), z.unknown());

const change = (proposal: StoredProposal): ApprovedChange => ({ runId: "20261101-070000-abcd", proposal });

describe("apply engine", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
    await writeMemory(sandbox, "deploy-window.md", DEPLOY);
    await writeMemory(sandbox, "MEMORY.md", INDEX);
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  async function plan(changes: ApprovedChange[]): Promise<ApplyPlan> {
    const result = await planApply(sandbox.memoryDir, changes);
    if (!result.ok) throw new Error(result.conflicts.map((c) => c.message).join("; "));
    return result.plan;
  }

  async function execute(p: ApplyPlan, io?: FileIo) {
    const ctx = {
      applyId: "20261101-080000-ffff",
      backupDir: join(sandbox.paths.backups, "20261101-080000-ffff"),
      auditLog: sandbox.paths.auditLog,
      now: NOW,
    };
    await mkdir(sandbox.paths.home, { recursive: true });
    return executePlan(p, ctx, io);
  }

  const auditEntries = async () =>
    (await readFile(sandbox.paths.auditLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => AuditLine.parse(JSON.parse(line)));

  it("adds a new memory file with frontmatter and an index pointer", async () => {
    const p = await plan([change(addProposal())]);
    expect(p.files.map((f) => f.file)).toEqual(["prefer-pnpm.md", "MEMORY.md"]);
    await execute(p);
    expect(await readMemory(sandbox, "prefer-pnpm.md")).toBe(
      "---\nname: prefer-pnpm\ndescription: Use pnpm, not npm\nmetadata:\n  type: feedback\n---\n\nUse pnpm.\n\n**Why:** npm breaks workspace links.\n",
    );
    expect(await readMemory(sandbox, "MEMORY.md")).toBe(
      `${INDEX}- [prefer-pnpm](prefer-pnpm.md) — Use pnpm, not npm\n`,
    );
  });

  it("creates MEMORY.md when the directory has none", async () => {
    const { rm } = await import("node:fs/promises");
    await rm(join(sandbox.memoryDir, "MEMORY.md"));
    await execute(await plan([change(addProposal())]));
    expect(await readMemory(sandbox, "MEMORY.md")).toBe("- [prefer-pnpm](prefer-pnpm.md) — Use pnpm, not npm\n");
  });

  it("updates a memory, keeping unknown frontmatter keys and the index title", async () => {
    const withExtra = DEPLOY.replace(
      "metadata:\n  type: project",
      "metadata:\n  type: project\n  created: 2026-03-01\nowner: sam",
    );
    await writeMemory(sandbox, "deploy-window.md", withExtra);
    const proposal = { ...updateProposal(), baseHash: sha256(withExtra) };
    await execute(await plan([change(proposal)]));
    expect(await readMemory(sandbox, "deploy-window.md")).toBe(
      "---\nname: deploy-window\ndescription: Deploys happen on Tuesdays and Thursdays\nmetadata:\n  type: project\n  created: 2026-03-01\nowner: sam\n---\n\nDeploys go out on Tuesdays and Thursdays.\n",
    );
    expect(await readMemory(sandbox, "MEMORY.md")).toBe(
      "# Memory index\n\n- [Deploy window](deploy-window.md) — Deploys happen on Tuesdays and Thursdays\n",
    );
  });

  it("deletes a memory and its index pointer", async () => {
    await execute(await plan([change(deleteProposal())]));
    expect(await readdir(sandbox.memoryDir)).toEqual(["MEMORY.md"]);
    expect(await readMemory(sandbox, "MEMORY.md")).toBe("# Memory index\n\n");
  });

  it("shows the exact diff it will apply", async () => {
    const p = await plan([change(updateProposal())]);
    expect(planDiff(p.files)).toBe(
      [
        "--- a/deploy-window.md",
        "+++ b/deploy-window.md",
        "@@ -1,8 +1,8 @@",
        " ---",
        " name: deploy-window",
        "-description: Deploys happen on Tuesdays",
        "+description: Deploys happen on Tuesdays and Thursdays",
        " metadata:",
        "   type: project",
        " ---",
        " ",
        "-Deploys go out on Tuesdays.",
        "+Deploys go out on Tuesdays and Thursdays.",
        "--- a/MEMORY.md",
        "+++ b/MEMORY.md",
        "@@ -1,3 +1,3 @@",
        " # Memory index",
        " ",
        "-- [Deploy window](deploy-window.md) — Deploys happen on Tuesdays",
        "+- [Deploy window](deploy-window.md) — Deploys happen on Tuesdays and Thursdays",
        "",
      ].join("\n"),
    );
    const added = await plan([change(addProposal())]);
    expect(planDiff(added.files.slice(0, 1)).split("\n").slice(0, 3)).toEqual([
      "--- /dev/null",
      "+++ b/prefer-pnpm.md",
      "@@ -0,0 +1,10 @@",
    ]);
  });

  it("backs up the memory directory and writes one audit line per proposal", async () => {
    const result = await execute(await plan([change(addProposal()), change(updateProposal())]));
    const backupFiles = join(result.backupDir, "files");
    expect((await readdir(backupFiles)).sort()).toEqual(["MEMORY.md", "deploy-window.md"]);
    expect(await readFile(join(backupFiles, "deploy-window.md"), "utf8")).toBe(DEPLOY);
    const audit = await auditEntries();
    expect(audit).toHaveLength(2);
    expect(audit[1]).toEqual({
      at: NOW.toISOString(),
      applyId: "20261101-080000-ffff",
      runId: "20261101-070000-abcd",
      proposalId: "20261101-070000-abcd-2",
      action: "update",
      file: "deploy-window.md",
      memoryDir: sandbox.memoryDir,
      result: "change",
      edited: false,
      beforeHash: sha256(DEPLOY),
      afterHash: sha256(await readMemory(sandbox, "deploy-window.md")),
      description: "Deploys happen on Tuesdays and Thursdays",
      type: "project",
      reason: "r",
      confidence: "high",
      evidence,
      sessions: [],
      backupDir: result.backupDir,
    });
    // Every line the engine writes is a valid entry for `dreaming why` to read back.
    expect(await readAudit(sandbox.paths.auditLog)).toHaveLength(2);
  });

  it("is idempotent: re-applying the same proposals changes nothing", async () => {
    const changes = [change(addProposal()), change(updateProposal())];
    await execute(await plan(changes));
    const memoryAfterFirst = await readMemory(sandbox, "MEMORY.md");
    const again = await plan(changes);
    expect(again.files).toEqual([]);
    expect(again.outcomes.map((o) => o.result)).toEqual(["already-applied", "already-applied"]);
    await execute(again);
    expect(await readMemory(sandbox, "MEMORY.md")).toBe(memoryAfterFirst);
    expect((await auditEntries()).map((e) => e.result)).toEqual([
      "change",
      "change",
      "already-applied",
      "already-applied",
    ]);
  });

  it("treats a delete whose file is already gone as applied", async () => {
    await execute(await plan([change(deleteProposal())]));
    const again = await plan([change(deleteProposal())]);
    expect(again.outcomes.map((o) => o.result)).toEqual(["already-applied"]);
    expect(again.files).toEqual([]);
  });

  describe("conflicts: nothing is planned over a person's own changes", () => {
    it("refuses an update when the file changed since the dream", async () => {
      await writeMemory(sandbox, "deploy-window.md", DEPLOY.replace("Tuesdays.", "Tuesdays (edited by hand)."));
      const result = await planApply(sandbox.memoryDir, [change(updateProposal())]);
      expect(result).toEqual({
        ok: false,
        conflicts: [
          {
            proposalId: "20261101-070000-abcd-2",
            message:
              "deploy-window.md has changed since this proposal was made; re-run dreaming to get a fresh proposal",
          },
        ],
      });
    });

    it("refuses a delete when the file changed since the dream", async () => {
      const result = await planApply(sandbox.memoryDir, [change(deleteProposal("0".repeat(64)))]);
      expect(!result.ok && result.conflicts[0]?.message).toMatch(/has changed since/);
    });

    it("refuses an update whose target no longer exists", async () => {
      const proposal = { ...updateProposal(), file: "gone.md" };
      const result = await planApply(sandbox.memoryDir, [change(proposal)]);
      expect(!result.ok && result.conflicts[0]?.message).toBe("gone.md no longer exists");
    });

    it("refuses an add over an existing file with different content", async () => {
      const result = await planApply(sandbox.memoryDir, [
        change(addProposal({ file: "deploy-window.md", name: "deploy-window" })),
      ]);
      expect(!result.ok && result.conflicts[0]?.message).toBe("deploy-window.md already exists with different content");
    });

    it("refuses two proposals in one batch that change the same file", async () => {
      const second = { ...updateProposal(), id: "20261101-070000-abcd-9", body: "Something else." };
      const result = await planApply(sandbox.memoryDir, [change(updateProposal()), change(second)]);
      expect(!result.ok && result.conflicts.map((c) => c.proposalId)).toEqual(["20261101-070000-abcd-9"]);
    });

    it("refuses to follow a symlink in the memory directory", async () => {
      await writeFile(join(sandbox.root, "outside.md"), "outside");
      await symlink(join(sandbox.root, "outside.md"), join(sandbox.memoryDir, "prefer-pnpm.md"));
      await expect(planApply(sandbox.memoryDir, [change(addProposal())])).rejects.toThrow(/is a symlink/);
      expect(await readFile(join(sandbox.root, "outside.md"), "utf8")).toBe("outside");
    });

    it("refuses to execute when a file changed after the diff was shown", async () => {
      const p = await plan([change(addProposal()), change(updateProposal())]);
      await writeMemory(sandbox, "MEMORY.md", `${INDEX}- [hand](hand.md) — added meanwhile\n`);
      await expect(execute(p)).rejects.toThrow("MEMORY.md changed after the diff was shown; nothing was written");
      expect(await readdir(sandbox.memoryDir)).not.toContain("prefer-pnpm.md");
      expect(await readMemory(sandbox, "deploy-window.md")).toBe(DEPLOY);
    });
  });

  describe("failure handling", () => {
    const failingIo = (failOn: "second-write" | "audit" | "second-write-and-restore"): FileIo => {
      let writes = 0;
      return {
        write: async (path, content, mode) => {
          writes += 1;
          if (failOn !== "audit" && writes === 2) throw new Error("disk full");
          if (failOn === "second-write-and-restore" && writes > 2) throw new Error("still full");
          await writeFileAtomic(path, content, mode);
        },
        remove: async (path) => {
          const { unlink } = await import("node:fs/promises");
          await unlink(path);
        },
        appendAudit: async (path, lines) => {
          if (failOn !== "audit") return;
          // Simulate a write that gets partway before the disk fills up.
          await appendFile(path, lines.slice(0, 40));
          throw new Error("audit log is read-only");
        },
        truncateAudit: (path, size) => truncate(path, size),
      };
    };

    it("rolls back every written file when a later write fails", async () => {
      const p = await plan([change(addProposal()), change(updateProposal())]);
      await expect(execute(p, failingIo("second-write"))).rejects.toThrow(
        "applying failed and every change was rolled back: disk full",
      );
      expect((await readdir(sandbox.memoryDir)).sort()).toEqual(["MEMORY.md", "deploy-window.md"]);
      expect(await readMemory(sandbox, "deploy-window.md")).toBe(DEPLOY);
      expect(await readMemory(sandbox, "MEMORY.md")).toBe(INDEX);
    });

    it("rolls back when the audit log cannot be written, and removes any partial audit line", async () => {
      await mkdir(sandbox.paths.home, { recursive: true });
      await writeFile(sandbox.paths.auditLog, '{"earlier":"entry"}\n');
      const p = await plan([change(deleteProposal())]);
      await expect(execute(p, failingIo("audit"))).rejects.toThrow(/rolled back: audit log is read-only/);
      expect(await readMemory(sandbox, "deploy-window.md")).toBe(DEPLOY);
      expect(await readMemory(sandbox, "MEMORY.md")).toBe(INDEX);
      expect(await readFile(sandbox.paths.auditLog, "utf8")).toBe('{"earlier":"entry"}\n');
    });

    it("rolls back cleanly on a first apply whose audit append fails before writing anything", async () => {
      const io: FileIo = { ...realIo, appendAudit: () => Promise.reject(new Error("EACCES: permission denied")) };
      const p = await plan([change(addProposal())]);
      await expect(execute(p, io)).rejects.toThrow("applying failed and every change was rolled back: EACCES");
      expect(await readdir(sandbox.memoryDir)).toEqual(["MEMORY.md", "deploy-window.md"]);
      expect(await readdir(sandbox.paths.home)).not.toContain("applied.jsonl");
    });

    it("says so, and points at the backup, when restoring fails too", async () => {
      const p = await plan([change(addProposal()), change(updateProposal())]);
      const error = await execute(p, failingIo("second-write-and-restore")).then(
        () => null,
        (e: unknown) => e,
      );
      expect(String(error)).toMatch(
        /applying failed \(disk full\) and restoring also failed for deploy-window\.md: still full/,
      );
      expect(error instanceof DreamingError && error.hint).toMatch(
        /^Restore the memory directory by hand from the backup/,
      );
    });

    it("leaves no temporary files behind", async () => {
      await execute(await plan([change(addProposal()), change(updateProposal())]));
      expect((await readdir(sandbox.memoryDir)).filter((name) => name.includes(".tmp"))).toEqual([]);
    });
  });

  it("applies an edited proposal under its new name", async () => {
    const content = memoryFile("pnpm-only", "Only pnpm in tidepool", "feedback", "Edited body.");
    await execute(
      await plan([
        { ...change(addProposal()), edit: { file: "pnpm-only.md", content, description: "Only pnpm in tidepool" } },
      ]),
    );
    expect(await readMemory(sandbox, "pnpm-only.md")).toBe(content);
    expect(await readMemory(sandbox, "MEMORY.md")).toContain("- [pnpm-only](pnpm-only.md) — Only pnpm in tidepool\n");
    expect((await auditEntries())[0]).toMatchObject({ file: "pnpm-only.md", edited: true });
  });
});
