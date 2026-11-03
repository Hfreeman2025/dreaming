// Shared by the package-manager shims in the eval sandbox. Every call is
// recorded (the checks read the log); nothing touches the network.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const repo = process.env.EVAL_REPO ?? process.cwd();

export function record(tool, args) {
  const entry = { tool, args, cwd: relative(repo, process.cwd()) || ".", at: Date.now() };
  appendFileSync(new URL("../shims.jsonl", import.meta.url), `${JSON.stringify(entry)}\n`);
}

/** The workspace's packages: { name, dir } for every packages/* with a package.json. */
export function packages() {
  const dir = join(repo, "packages");
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => existsSync(join(path, "package.json")))
    .map((path) => ({ name: JSON.parse(readFileSync(join(path, "package.json"), "utf8")).name, dir: path }));
}

/** Link every workspace package into node_modules, the way pnpm does. */
export function linkWorkspace() {
  rmSync(join(repo, "node_modules"), { recursive: true, force: true });
  for (const pkg of packages()) {
    const target = join(repo, "node_modules", pkg.name);
    mkdirSync(resolve(target, ".."), { recursive: true });
    symlinkSync(relative(resolve(target, ".."), pkg.dir), target);
  }
}

/** The package a filter or the current directory points at, or null for the whole workspace. */
export function pick(filter) {
  const all = packages();
  if (filter) {
    const want = filter.replace(/^\.\//, "").replace(/\/$/, "");
    return all.find((p) => p.name === want || p.name.endsWith(`/${want}`) || relative(repo, p.dir) === want) ?? "none";
  }
  return all.find((p) => process.cwd().startsWith(p.dir)) ?? null;
}

/** Run a package's tests (or every package's) with Node's test runner. */
export function runTests(target) {
  const globs = (target ? [target] : packages())
    .filter((p) => existsSync(join(p.dir, "test")))
    .map((p) => `${relative(repo, p.dir)}/test/**/*.test.js`);
  if (globs.length === 0) return 0;
  const result = spawnSync(process.execPath, ["--test", ...globs], { cwd: repo, stdio: "inherit" });
  return result.status ?? 1;
}

export function runLint() {
  return spawnSync(process.execPath, [join(repo, "scripts", "lint.mjs")], { cwd: repo, stdio: "inherit" }).status ?? 1;
}

export function offline(tool, args) {
  console.error(`${tool} ${args.join(" ")}: not available in this offline sandbox`);
  process.exit(1);
}
