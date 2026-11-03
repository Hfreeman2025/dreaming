import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { planApply, type ApprovedChange } from "../apply/plan.js";
import { DreamingError } from "../errors.js";

/**
 * The two arms of an eval differ in exactly one thing: the proposal. The
 * baseline is the memory directory as it is now; the other arm is that same
 * directory with the proposal applied, worked out by the same planner the
 * real apply uses, so the agent sees what approving would write. Nothing is
 * written to the memory directory.
 */

export type Memory = ReadonlyMap<string, string>;

async function readMemory(memoryDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of (await readdir(memoryDir)).sort()) {
    if (!name.endsWith(".md") || name.startsWith(".")) continue;
    files.set(name, await readFile(join(memoryDir, name), "utf8"));
  }
  return files;
}

export async function memoryArms(
  memoryDir: string,
  change: ApprovedChange,
): Promise<{ without: Memory; with: Memory }> {
  const without = await readMemory(memoryDir);
  const planned = await planApply(memoryDir, [change]);
  if (!planned.ok) {
    throw new DreamingError(
      `this proposal cannot be applied to the memory as it is now: ${planned.conflicts[0]?.message ?? ""}`,
      {
        hint: "Evaluate it against the memory it was made for, or run a new dream.",
      },
    );
  }
  const withMemory = new Map(without);
  for (const file of planned.plan.files) {
    if (file.after === null) withMemory.delete(file.file);
    else withMemory.set(file.file, file.after);
  }
  return { without, with: withMemory };
}

/**
 * The memory as the agent sees it: appended to the system prompt, the index
 * first and then every memory file in full. (Claude Code itself puts the index
 * in context and reads files on demand; with a handful of small files, giving
 * all of them is the closest stand-in that does not depend on the agent
 * choosing to open one.)
 */
export function memoryPrompt(memory: Memory): string {
  if (memory.size === 0) return "";
  const names = [...memory.keys()].sort((a, b) =>
    a === "MEMORY.md" ? -1 : b === "MEMORY.md" ? 1 : a.localeCompare(b),
  );
  const parts = names.map(
    (name) => `<memory-file name="${name}">\n${(memory.get(name) ?? "").trimEnd()}\n</memory-file>`,
  );
  return [
    "# Memory",
    "",
    "These memory files were saved from your earlier sessions with this user. MEMORY.md is the index; each memory follows in full. Use them when they are relevant.",
    "",
    ...parts,
  ].join("\n");
}
