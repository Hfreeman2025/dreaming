// The repository's style check: two-space indentation, no tabs, in every package's source and tests.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith(".js")) files.push(path);
  }
};
walk(join(root, "packages"));

const problems = [];
for (const file of files) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const indent = /^[ \t]*/.exec(line)[0];
      if (indent.includes("\t")) problems.push(`${relative(root, file)}:${i + 1}: indent with spaces, not tabs`);
      else if (indent.length % 2 !== 0)
        problems.push(`${relative(root, file)}:${i + 1}: indent by a multiple of 2 spaces`);
    });
}
for (const problem of problems) console.error(problem);
console.log(problems.length === 0 ? `lint: ${files.length} files ok` : `lint: ${problems.length} problems`);
process.exit(problems.length === 0 ? 0 : 1);
