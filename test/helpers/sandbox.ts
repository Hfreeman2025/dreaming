import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dreamingPaths, parseConfig, type Config, type DreamingPaths } from "../../src/config.js";

export const FAKE_AGENT = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));
chmodSync(FAKE_AGENT, 0o755);

/** A fixed clock: 1 Nov 2026, 07:00 UTC. Transcripts are dated relative to it. */
export const NOW = new Date("2026-11-01T07:00:00.000Z");
export const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);
export const hoursAgo = (hours: number): Date => minutesAgo(hours * 60);

export interface Sandbox {
  root: string;
  homedir: string;
  paths: DreamingPaths;
  memoryDir: string;
  projectsDir: string;
  cleanup(): Promise<void>;
}

/** A throwaway directory tree: a fake home, a memory directory and a transcripts root. */
export async function makeSandbox(): Promise<Sandbox> {
  // realpath: on macOS the temp dir is behind a symlink, and paths are compared as strings.
  const root = await realpath(await mkdtemp(join(tmpdir(), "dreaming-test-")));
  const homedir = join(root, "home");
  const memoryDir = join(root, "memory");
  const projectsDir = join(root, "projects");
  await Promise.all([mkdir(homedir), mkdir(memoryDir), mkdir(projectsDir)]);
  return {
    root,
    homedir,
    paths: dreamingPaths(join(homedir, ".dreaming")),
    memoryDir,
    projectsDir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function testConfig(sandbox: Sandbox, overrides: Record<string, unknown> = {}): Config {
  return parseConfig(
    {
      memoryDir: sandbox.memoryDir,
      transcripts: { root: sandbox.projectsDir },
      agent: { bin: FAKE_AGENT, timeoutSeconds: 20 },
      ...overrides,
    },
    sandbox.homedir,
    "test",
  );
}

export async function writeConfigFile(sandbox: Sandbox, value: unknown): Promise<void> {
  await mkdir(sandbox.paths.home, { recursive: true });
  await writeFile(sandbox.paths.config, JSON.stringify(value, null, 2));
}

// --- synthetic transcripts -----------------------------------------------------

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String((counter += 1)).padStart(12, "0")}`;

export function userEntry(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "user",
    uuid: uuid(),
    sessionId: "s",
    cwd: "/work/tidepool",
    timestamp: "2026-10-31T10:00:00.000Z",
    message: { role: "user", content: text },
    ...extra,
  };
}

export function assistantEntry(blocks: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "assistant",
    uuid: uuid(),
    sessionId: "s",
    cwd: "/work/tidepool",
    timestamp: "2026-10-31T10:01:00.000Z",
    message: { role: "assistant", content: blocks },
    ...extra,
  };
}

export const text = (value: string) => ({ type: "text", text: value });

export function jsonl(entries: readonly (Record<string, unknown> | string)[]): string {
  return entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n") + "\n";
}

export async function writeTranscript(
  sandbox: Sandbox,
  project: string,
  sessionId: string,
  entries: readonly (Record<string, unknown> | string)[],
  modified: Date,
): Promise<string> {
  const path = join(sandbox.projectsDir, project, `${sessionId}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, jsonl(entries));
  await utimes(path, modified, modified);
  return path;
}

export async function touch(path: string, modified: Date): Promise<void> {
  await utimes(path, modified, modified);
}

export async function writeMemory(sandbox: Sandbox, file: string, content: string): Promise<string> {
  const path = join(sandbox.memoryDir, file);
  await writeFile(path, content);
  return path;
}

export const readMemory = (sandbox: Sandbox, file: string) => readFile(join(sandbox.memoryDir, file), "utf8");

export function memoryFile(name: string, description: string, type: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;
}
