import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DreamingError } from "../errors.js";
import { fileKind, sha256 } from "../fsx.js";
import { memoryFields, parseMemoryDocument } from "./frontmatter.js";
import { INDEX_FILE } from "./index-file.js";

export interface MemoryEntry {
  file: string;
  name: string | undefined;
  description: string | undefined;
  type: string | undefined;
  hash: string;
  /** Set when the frontmatter could not be parsed; the file is still a valid target. */
  problem: string | undefined;
}

export interface MemorySnapshot {
  dir: string;
  entries: Map<string, MemoryEntry>;
}

/**
 * Read every memory file once at the start of a run. The hashes are what the
 * agent saw; an update or delete proposal is only applied if its target still
 * has the same hash, so later hand edits are never overwritten.
 */
export async function snapshotMemory(dir: string): Promise<MemorySnapshot> {
  const kind = await fileKind(dir);
  if (kind !== "directory") {
    throw new DreamingError(
      kind === "missing" ? `memory directory not found: ${dir}` : `memory directory is not a directory: ${dir}`,
      { hint: "Set memoryDir in the config to an existing directory (it may be empty)." },
    );
  }
  const entries = new Map<string, MemoryEntry>();
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    if (!dirent.isFile() || !dirent.name.endsWith(".md") || dirent.name === INDEX_FILE) continue;
    if (dirent.name.startsWith(".")) continue;
    const text = await readFile(join(dir, dirent.name), "utf8");
    const parsed = parseMemoryDocument(text);
    const fields = parsed.ok ? memoryFields(parsed.doc.frontmatter) : undefined;
    entries.set(dirent.name, {
      file: dirent.name,
      name: fields?.name,
      description: fields?.description,
      type: fields?.type,
      hash: sha256(text),
      problem: parsed.ok ? undefined : parsed.error,
    });
  }
  return { dir, entries };
}
