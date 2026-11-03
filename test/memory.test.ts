import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  memoryFields,
  parseMemoryDocument,
  renderNewMemory,
  renderWithRawFrontmatter,
  scalarText,
  updateMemoryText,
} from "../src/memory/frontmatter.js";
import { indexLinksTo, removePointers, upsertPointer } from "../src/memory/index-file.js";
import { snapshotMemory } from "../src/memory/snapshot.js";
import { makeSandbox, memoryFile, writeMemory, type Sandbox } from "./helpers/sandbox.js";

describe("frontmatter", () => {
  it("renders a new memory in the exact Claude Code format", () => {
    expect(
      renderNewMemory({
        name: "prefer-pnpm",
        description: "Use pnpm in tidepool",
        type: "feedback",
        body: "Use pnpm.\n\n**Why:** npm breaks links.\n",
      }),
    ).toBe(
      "---\nname: prefer-pnpm\ndescription: Use pnpm in tidepool\nmetadata:\n  type: feedback\n---\n\nUse pnpm.\n\n**Why:** npm breaks links.\n",
    );
  });

  it("quotes YAML-significant descriptions and never folds long ones", () => {
    const description = `Deadline: "v2" ships #soon - ${"long ".repeat(30).trim()}`;
    const text = renderNewMemory({ name: "x", description, type: "project", body: "b" });
    const descriptionLine = text.split("\n").find((line: string) => line.startsWith("description:"));
    expect(descriptionLine?.length).toBeGreaterThan(150);
    const parsed = parseMemoryDocument(text);
    expect(parsed.ok && memoryFields(parsed.doc.frontmatter).description).toBe(description);
  });

  it("keeps a person's frontmatter text exactly as written", () => {
    const original = memoryFile("deploy-window", "Deploys only on Tuesdays", "project", "Body line.");
    const parsed = parseMemoryDocument(original);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(renderWithRawFrontmatter(parsed.doc.rawFrontmatter, parsed.doc.body)).toBe(original);
  });

  it("reads type from metadata or, in older files, from the top level", () => {
    expect(memoryFields({ name: "a", metadata: { type: "user" } }).type).toBe("user");
    expect(memoryFields({ name: "a", type: "reference" }).type).toBe("reference");
  });

  it("explains files it cannot parse", () => {
    expect(parseMemoryDocument("no frontmatter here")).toEqual({
      ok: false,
      error: "missing YAML frontmatter (the file must start with ---)",
    });
    const bad = parseMemoryDocument("---\nname: [unclosed\n---\nbody");
    expect(!bad.ok && bad.error).toMatch(/not valid YAML/);
    expect(parseMemoryDocument("---\n- a list\n---\nbody")).toEqual({
      ok: false,
      error: "frontmatter must be a YAML mapping",
    });
  });
});

describe("updating an existing memory", () => {
  const update = { name: "a", description: "New description", type: "feedback", body: "New body." };

  it("changes description, type and body and leaves everything else as written", () => {
    const current = [
      "---",
      "name: a",
      "# reviewed quarterly",
      "description: Old description",
      "version: 1.10",
      "ticket: 0123",
      "metadata:",
      "  type: project",
      "  created: 2026-03-01",
      "owner: sam",
      "---",
      "",
      "Old body.",
      "",
    ].join("\n");
    const result = updateMemoryText(current, update);
    expect(result).toEqual({
      ok: true,
      text: [
        "---",
        "name: a",
        "# reviewed quarterly",
        "description: New description",
        "version: 1.10",
        "ticket: 0123",
        "metadata:",
        "  type: feedback",
        "  created: 2026-03-01",
        "owner: sam",
        "---",
        "",
        "New body.",
        "",
      ].join("\n"),
    });
  });

  it("keeps every other byte: flow lists, indentation, trailing comments", () => {
    const current = [
      "---",
      "name: a",
      "description: Old one   # set by hand",
      "tags: [a,b]",
      "metadata:",
      "    type: project",
      "    created: 2026-03-01",
      "---",
      "",
      "Old.",
      "",
    ].join("\n");
    const result = updateMemoryText(current, update);
    expect(result.ok && result.text).toBe(
      [
        "---",
        "name: a",
        "description: New description   # set by hand",
        "tags: [a,b]",
        "metadata:",
        "    type: feedback",
        "    created: 2026-03-01",
        "---",
        "",
        "New body.",
        "",
      ].join("\n"),
    );
  });

  it("keeps CRLF line endings", () => {
    const current = "---\r\nname: a\r\ndescription: d\r\nmetadata:\r\n  type: user\r\n---\r\n\r\nb\r\n";
    expect(updateMemoryText(current, { ...update, body: "line one\nline two" })).toEqual({
      ok: true,
      text: "---\r\nname: a\r\ndescription: New description\r\nmetadata:\r\n  type: feedback\r\n---\r\n\r\nline one\r\nline two\r\n",
    });
  });

  it("replaces a folded block description with a single line", () => {
    const current = "---\nname: a\ndescription: >-\n  folded\n  text\nmetadata:\n  type: user\n---\n\nb\n";
    expect(updateMemoryText(current, update)).toEqual({
      ok: true,
      text: "---\nname: a\ndescription: New description\nmetadata:\n  type: feedback\n---\n\nNew body.\n",
    });
  });

  it("adds keys the file lacks without disturbing the rest", () => {
    const noType = "---\nname: a\ndescription: d\nmetadata:\n    created: x   # kept\n---\n\nb\n";
    expect(updateMemoryText(noType, update)).toEqual({
      ok: true,
      text: "---\nname: a\ndescription: New description\nmetadata:\n    created: x   # kept\n    type: feedback\n---\n\nNew body.\n",
    });
    expect(updateMemoryText("---\nname: a\n---\n\nb\n", update)).toEqual({
      ok: true,
      text: "---\nname: a\ndescription: New description\nmetadata:\n  type: feedback\n---\n\nNew body.\n",
    });
  });

  it.each(["@at start", "[bracketed]", "key: value", "true", "1.10", "- dash", "#hash", "&anchor x", "*alias"])(
    "quotes a value YAML would read differently: %s",
    (value) => {
      const text = scalarText(value);
      expect(text).toBe(JSON.stringify(value));
      const parsed = parseMemoryDocument(`---\ndescription: ${text}\n---\n\nb\n`);
      expect(parsed.ok && memoryFields(parsed.doc.frontmatter).description).toBe(value);
    },
  );

  it("does not print YAML warnings while checking how to quote a value", () => {
    const warn = vi.spyOn(process, "emitWarning");
    const consoleWarn = vi.spyOn(console, "warn");
    const result = updateMemoryText("---\nname: a\ndescription: d\ntype: user\n---\n\nb\n", {
      ...update,
      description: "!important %TAG note",
    });
    expect(result.ok && result.text).toContain('description: "!important %TAG note"\n');
    expect(warn).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    warn.mockRestore();
    consoleWarn.mockRestore();
  });

  it("keeps the type at the top level in older files that put it there", () => {
    const result = updateMemoryText("---\nname: a\ndescription: d\ntype: user\n---\n\nb\n", update);
    expect(result).toEqual({
      ok: true,
      text: "---\nname: a\ndescription: New description\ntype: feedback\n---\n\nNew body.\n",
    });
  });

  it("quotes values that would otherwise read back as something other than text", () => {
    const result = updateMemoryText("---\nname: a\ndescription: d\nmetadata:\n  type: user\n---\n\nb\n", {
      ...update,
      description: "true",
    });
    expect(result.ok && result.text).toContain('description: "true"\n');
  });

  it("gives a file without frontmatter a fresh one", () => {
    expect(updateMemoryText("just a body\n", update)).toEqual({
      ok: true,
      text: "---\nname: a\ndescription: New description\nmetadata:\n  type: feedback\n---\n\nNew body.\n",
    });
  });

  it("refuses frontmatter it cannot edit safely", () => {
    expect(updateMemoryText("---\nname: a\nmetadata: legacy\n---\n\nb\n", update)).toEqual({
      ok: false,
      error: "its frontmatter 'metadata' is not a block mapping; edit it by hand",
    });
    expect(updateMemoryText("---\nname: a\nmetadata: {type: user}\n---\n\nb\n", update).ok).toBe(false);
    expect(updateMemoryText("---\nname: [unclosed\n---\n\nb\n", update).ok).toBe(false);
  });
});

describe("MEMORY.md pointers", () => {
  const index = "# Memory\n\n- [Prefer pnpm](prefer-pnpm.md) — Use pnpm\n- [Deploys](./deploy.md) — Tuesdays only\n";

  it("appends a pointer for a new memory", () => {
    expect(upsertPointer(index, "new-fact.md", "new-fact", "A new fact")).toBe(
      `${index}- [new-fact](new-fact.md) — A new fact\n`,
    );
  });

  it("creates the index content from nothing", () => {
    expect(upsertPointer("", "a.md", "a", "hook")).toBe("- [a](a.md) — hook\n");
  });

  it("updates the hook of an existing pointer, keeping its title and position", () => {
    expect(upsertPointer(index, "deploy.md", "deploy", "Tuesdays and Thursdays")).toBe(
      "# Memory\n\n- [Prefer pnpm](prefer-pnpm.md) — Use pnpm\n- [Deploys](deploy.md) — Tuesdays and Thursdays\n",
    );
  });

  it("collapses duplicate pointers to one", () => {
    const duplicated = "- [a](a.md) — one\n- [a again](a.md) — two\n";
    expect(upsertPointer(duplicated, "a.md", "a", "hook")).toBe("- [a](a.md) — hook\n");
  });

  it("removes every pointer to a deleted memory and nothing else", () => {
    expect(removePointers(index, "prefer-pnpm.md")).toBe("# Memory\n\n- [Deploys](./deploy.md) — Tuesdays only\n");
    expect(indexLinksTo(index, "deploy.md")).toBe(true);
    expect(indexLinksTo(index, "deploy")).toBe(false);
  });

  it("keeps CRLF line endings and still finds pointers in them", () => {
    const crlf = "# Memory\r\n- [Deploys](deploy.md) — Tuesdays\r\n";
    expect(upsertPointer(crlf, "deploy.md", "deploy", "Thursdays")).toBe(
      "# Memory\r\n- [Deploys](deploy.md) — Thursdays\r\n",
    );
    expect(removePointers(crlf, "deploy.md")).toBe("# Memory\r\n");
    expect(indexLinksTo(crlf, "deploy.md")).toBe(true);
  });

  it("keeps each line's own ending in a file with mixed line endings", () => {
    const mixed = "# Memory\r\n- [a](a.md) — one\n- [b](b.md) — two\r\n";
    expect(upsertPointer(mixed, "a.md", "a", "uno")).toBe("# Memory\r\n- [a](a.md) — uno\n- [b](b.md) — two\r\n");
    expect(upsertPointer(mixed, "c.md", "c", "three")).toBe(`${mixed}- [c](c.md) — three\r\n`);
    expect(removePointers(mixed, "a.md")).toBe("# Memory\r\n- [b](b.md) — two\r\n");
  });

  it("ends the file with a line break when appending to one without", () => {
    expect(upsertPointer("# Memory", "a.md", "a", "hook")).toBe("# Memory\n- [a](a.md) — hook\n");
  });

  it("does not touch a line that merely mentions the file name", () => {
    const mentions = "See prefer-pnpm.md for details.\n";
    expect(removePointers(mentions, "prefer-pnpm.md")).toBe(mentions);
  });
});

describe("snapshotMemory", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("hashes each memory, skipping the index, hidden files and symlinks", async () => {
    await writeMemory(sandbox, "MEMORY.md", "- [a](a.md) — a\n");
    await writeMemory(sandbox, "a.md", memoryFile("a", "Fact A", "user", "A."));
    await writeMemory(sandbox, "broken.md", "no frontmatter");
    await writeMemory(sandbox, ".draft.md", memoryFile("d", "d", "user", "d"));
    await symlink(join(sandbox.root, "elsewhere.md"), join(sandbox.memoryDir, "link.md"));
    const snapshot = await snapshotMemory(sandbox.memoryDir);
    expect([...snapshot.entries.keys()].sort()).toEqual(["a.md", "broken.md"]);
    expect(snapshot.entries.get("a.md")).toMatchObject({
      name: "a",
      description: "Fact A",
      type: "user",
      problem: undefined,
    });
    expect(snapshot.entries.get("a.md")?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.entries.get("broken.md")?.problem).toMatch(/missing YAML frontmatter/);
  });

  it("refuses a missing memory directory", async () => {
    await expect(snapshotMemory(join(sandbox.root, "nope"))).rejects.toThrow(/memory directory not found/);
  });
});
