import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { DreamingError, errorCode } from "../errors.js";
import { parseJson } from "../fsx.js";

/**
 * A task suite: a template repository, the tasks to run in a fresh copy of
 * it, and for each task a check that decides pass or fail afterwards. Checks
 * live outside the repository, so the agent never sees how it is graded.
 *
 *   suite.json   { name, about, repo, shims?, timeoutSeconds?, maxTurns?, tasks: [...] }
 *   repo/        copied fresh for every run
 *   shims/       optional: put first on the agent's PATH (stand-ins for tools such as npm)
 *   checks/      one script per task; exit 0 means pass, the first line of output says why
 */

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, "use lowercase letters, digits and dashes");
const Seconds = z.number().int().min(10).max(1800);
const Turns = z.number().int().min(1).max(100);

const TaskSchema = z.strictObject({
  id: Slug,
  prompt: z.string().min(1).max(4000),
  check: z.string().min(1),
  /** What a pass means, in a few words, for the report. */
  passMeans: z.string().min(1).max(200),
  timeoutSeconds: Seconds.optional(),
  maxTurns: Turns.optional(),
});

const SuiteSchema = z.strictObject({
  name: Slug,
  about: z.string().min(1).max(500),
  repo: z.string().min(1),
  shims: z.string().min(1).optional(),
  timeoutSeconds: Seconds.default(300),
  maxTurns: Turns.default(20),
  tasks: z.array(TaskSchema).min(1).max(10),
});

export interface Task {
  id: string;
  prompt: string;
  checkPath: string;
  passMeans: string;
  timeoutSeconds: number;
  maxTurns: number;
}

export interface Suite {
  name: string;
  about: string;
  dir: string;
  repoDir: string;
  shimsDir: string | undefined;
  tasks: Task[];
}

/** Resolve a path from suite.json, refusing anything that leaves the suite directory. */
function inside(dir: string, path: string, what: string): string {
  const full = resolve(dir, path);
  const rel = relative(dir, full);
  if (isAbsolute(path) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new DreamingError(`suite.json: ${what} must be a path inside the suite directory: ${path}`);
  }
  return full;
}

async function kind(path: string): Promise<"file" | "dir" | "missing"> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? "dir" : "file";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
}

export async function loadSuite(dirArg: string): Promise<Suite> {
  const dir = resolve(dirArg);
  const file = join(dir, "suite.json");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new DreamingError(`no suite.json in ${dir}`, {
        hint: "A suite is a directory with suite.json, a template repo/ and a check per task. See demo/suites/tidepool.",
      });
    }
    throw error;
  }
  const json = parseJson(text);
  if (!json.ok) throw new DreamingError(`suite.json is not valid JSON: ${json.error}`);
  const parsed = SuiteSchema.safeParse(json.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DreamingError(`suite.json: ${issue?.path.join(".") ?? ""} ${issue?.message ?? "is invalid"}`.trim());
  }
  const suite = parsed.data;
  const ids = new Set<string>();
  for (const task of suite.tasks) {
    if (ids.has(task.id)) throw new DreamingError(`suite.json: two tasks are called ${task.id}`);
    ids.add(task.id);
  }
  const repoDir = inside(dir, suite.repo, "repo");
  if ((await kind(repoDir)) !== "dir") throw new DreamingError(`suite repo is not a directory: ${repoDir}`);
  const shimsDir = suite.shims === undefined ? undefined : inside(dir, suite.shims, "shims");
  if (shimsDir !== undefined && (await kind(shimsDir)) !== "dir") {
    throw new DreamingError(`suite shims is not a directory: ${shimsDir}`);
  }
  const tasks: Task[] = [];
  for (const task of suite.tasks) {
    const checkPath = inside(dir, task.check, `the check for ${task.id}`);
    if ((await kind(checkPath)) !== "file") throw new DreamingError(`check for ${task.id} not found: ${checkPath}`);
    tasks.push({
      id: task.id,
      prompt: task.prompt,
      checkPath,
      passMeans: task.passMeans,
      timeoutSeconds: task.timeoutSeconds ?? suite.timeoutSeconds,
      maxTurns: task.maxTurns ?? suite.maxTurns,
    });
  }
  return { name: suite.name, about: suite.about, dir, repoDir, shimsDir, tasks };
}
