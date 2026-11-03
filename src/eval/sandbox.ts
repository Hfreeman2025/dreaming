import { chmod, cp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canarySettings } from "./isolation.js";
import type { Suite } from "./suite.js";

/**
 * One run's sandbox, in a slot directory that is wiped and rebuilt for every
 * run. Slots are reused (one per parallel worker) so Claude Code sees a few
 * stable working directories rather than a new one per run.
 *
 *   repo/          a fresh copy of the suite's template: the agent's working directory
 *   bin/           the suite's shims and a `node` link: the only things on the agent's PATH
 *                  besides the system directories
 *   tmp/           the agent's TMPDIR
 *   canary/        where the canary hook would leave a file if any hook ran
 *   settings.json  disableAllHooks, plus the canary hook on every event
 *   shims.jsonl    every shim call, for the check
 *   answer.txt     the agent's final answer, for the check
 *   stream.jsonl   Claude Code's stream-json output
 *   debug.log      Claude Code's debug log (read for the registered-hook count)
 *   memory.md      the arm's memory, appended to the system prompt (mode 0600)
 */

export interface Slot {
  dir: string;
  repo: string;
  bin: string;
  tmp: string;
  canary: string;
  settings: string;
  shimLog: string;
  answer: string;
  stream: string;
  debug: string;
  memory: string;
}

export function slotPaths(dir: string): Slot {
  return {
    dir,
    repo: join(dir, "repo"),
    bin: join(dir, "bin"),
    tmp: join(dir, "tmp"),
    canary: join(dir, "canary"),
    settings: join(dir, "settings.json"),
    shimLog: join(dir, "shims.jsonl"),
    answer: join(dir, "answer.txt"),
    stream: join(dir, "stream.jsonl"),
    debug: join(dir, "debug.log"),
    memory: join(dir, "memory.md"),
  };
}

export async function prepareSlot(dir: string, suite: Suite, nodePath: string): Promise<Slot> {
  const slot = slotPaths(dir);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await cp(suite.repoDir, slot.repo, { recursive: true });
  await mkdir(slot.bin);
  if (suite.shimsDir !== undefined) {
    await cp(suite.shimsDir, slot.bin, { recursive: true });
    for (const name of await readdir(slot.bin)) {
      if (!name.includes(".")) await chmod(join(slot.bin, name), 0o755);
    }
  }
  await symlink(nodePath, join(slot.bin, "node"));
  await mkdir(slot.tmp);
  await mkdir(slot.canary);
  await writeFile(slot.settings, canarySettings(slot.canary, true));
  await writeFile(slot.shimLog, "");
  return slot;
}
