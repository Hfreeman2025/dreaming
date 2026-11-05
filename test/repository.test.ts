import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRedactor } from "../src/redact.js";

/**
 * Checks on the repository itself. Every text file that ships or is committed
 * must pass the project's own redactor (no credential-shaped strings, which
 * would also trip secret scanning on push) and contain no invisible or control
 * characters (which can hide code from a reviewer).
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Not committed (all ignored); .cache may hold a scratch clone or a temporary directory.
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", ".claude", ".cache"]);
const TEXT_FILE = /\.(ts|mjs|js|json|md|yml|yaml)$|^(LICENSE|\.gitignore)$/;
// Generated, and full of integrity hashes that look random by design.
const SKIP_FILES = new Set(["package-lock.json"]);

async function textFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...(await textFiles(join(dir, entry.name))));
    } else if (entry.isFile() && TEXT_FILE.test(entry.name) && !SKIP_FILES.has(entry.name)) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

// eslint-disable-next-line no-control-regex -- the point is to find control characters.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\p{Co}\p{Cn}\u2028\u2029]/u;

describe("repository hygiene", () => {
  it("has no credential-shaped strings in any committed text file", async () => {
    const redact = createRedactor();
    const offenders: string[] = [];
    for (const file of await textFiles(ROOT)) {
      const result = redact(await readFile(file, "utf8"));
      if (result.count > 0) offenders.push(`${relative(ROOT, file)} (${result.count})`);
    }
    expect(offenders).toEqual([]);
  });

  it("has no local paths in the recorded screens", async () => {
    // The recordings are of a sandbox whose home is shown as ~; a real path means something leaked.
    const local = [/\/Users\//, /\/var\/folders\//, /\/private\/tmp\//, /\/tmp\/dreaming-record-/, homedir(), ROOT];
    const offenders: string[] = [];
    for (const dir of [join(ROOT, "shots"), join(ROOT, "demo", "recorded")]) {
      const files = (await readdir(dir, { recursive: true }).catch(() => [])).filter((f) =>
        /\.(svg|cast|json)$/.test(f),
      );
      for (const file of files) {
        const text = await readFile(join(dir, file), "utf8");
        for (const pattern of local) {
          if (typeof pattern === "string" ? text.includes(pattern) : pattern.test(text))
            offenders.push(`${file}: ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has no invisible or control characters in any committed text file", async () => {
    const offenders: string[] = [];
    for (const file of await textFiles(ROOT)) {
      const text = await readFile(file, "utf8");
      const match = HIDDEN.exec(text);
      if (match) offenders.push(`${relative(ROOT, file)} at offset ${match.index}`);
    }
    expect(offenders).toEqual([]);
  });
});
