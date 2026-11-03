// Shared by the checks. A check prints one line saying why, and exits 0 for a pass.
import { existsSync, readFileSync } from "node:fs";

export const repo = process.env.EVAL_REPO ?? process.cwd();

export function pass(why) {
  console.log(why);
  process.exit(0);
}

export function fail(why) {
  console.log(why);
  process.exit(1);
}

/** Every package-manager call the agent made, in order. */
export function calls() {
  const log = process.env.EVAL_LOG;
  if (!log || !existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** The agent's final answer, as it returned it. */
export function answer() {
  const file = process.env.EVAL_ANSWER;
  return file && existsSync(file) ? readFileSync(file, "utf8") : "";
}
