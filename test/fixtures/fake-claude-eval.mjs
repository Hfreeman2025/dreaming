#!/usr/bin/env node
// A stand-in for `claude -p --output-format stream-json` in eval tests. It does
// the tidepool tasks the way the memory it was given says to, through the
// suite's real shims, and reports itself in Claude Code's stream-json shape.
// Like the real CLI, it runs --settings hooks only when neither --safe-mode
// nor disableAllHooks is set. Test knobs come from $HOME/fake-claude.json:
//   { "hookEvent": true }   report a hook event in every run (an isolation breach)
//   { "canary": true }      run the settings' hook commands anyway (a breach the stream hides)
//   { "loggedOut": true }   fail like a CLI that is not logged in
//   { "sleepMs": 2000 }     take this long before answering
//   { "bypass": true }      report package-manager commands without running them (as if real npm were on PATH)
import { execSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const knobsFile = join(process.env.HOME ?? "/nonexistent", "fake-claude.json");
const knobs = existsSync(knobsFile) ? JSON.parse(readFileSync(knobsFile, "utf8")) : {};
const out = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
const prompt = readFileSync(0, "utf8");
const memoryFile = flag("--append-system-prompt-file");
const memory = memoryFile === undefined ? "" : readFileSync(memoryFile, "utf8");
const settingsPath = flag("--settings");
const settings = settingsPath ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
const debugFile = flag("--debug-file");
const hooksOn = !args.includes("--safe-mode") && settings.disableAllHooks !== true;

const runHooks = (event) => {
  for (const group of settings.hooks?.[event] ?? []) {
    for (const hook of group.hooks ?? []) {
      execSync(hook.command);
      out({ type: "system", subtype: "hook_started", hook_event: event, hook_name: event });
      out({ type: "system", subtype: "hook_response", hook_event: event, hook_name: event, exit_code: 0 });
    }
  }
};

if (debugFile) writeFileSync(debugFile, `[DEBUG] Hooks: Found ${hooksOn ? 1 : 0} total hooks in registry\n`);
out({
  type: "system",
  subtype: "init",
  model: "fake-model",
  tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
  plugins: [],
  mcp_servers: [],
});
if (hooksOn || knobs.canary) runHooks("SessionStart");
if (knobs.hookEvent) out({ type: "system", subtype: "hook_started", hook_event: "Stop", hook_name: "Stop" });

const finish = (answer, turns, extra = {}) => {
  if (hooksOn || knobs.canary) runHooks("Stop");
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: answer,
    num_turns: turns,
    duration_ms: 1200,
    total_cost_usd: 0.01 * turns,
    usage: {
      input_tokens: 100 * turns,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1000 * turns,
      output_tokens: 50 * turns,
    },
    ...extra,
  });
  process.exit(0);
};
const tool = (name, command) =>
  out({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input: command === undefined ? {} : { command } }] },
  });
const sh = (command) => (knobs.bypass ? 0 : spawnSync("/bin/sh", ["-c", command], { stdio: "ignore" }).status);

if (knobs.sleepMs) await new Promise((resolve) => setTimeout(resolve, knobs.sleepMs));
if (knobs.loggedOut || process.env.CLAUDE_CONFIG_DIR !== undefined) {
  out({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "Not logged in · Please run /login",
    num_turns: 1,
    duration_ms: 40,
    total_cost_usd: 0,
    usage: {},
  });
  process.exit(1);
}
if (/install/i.test(prompt) && /tests/i.test(prompt)) {
  if (!/pnpm/.test(memory)) {
    tool("Bash", "npm install");
    sh("npm install");
  }
  tool("Bash", "pnpm install");
  sh("pnpm install");
  tool("Bash", "pnpm --filter api test");
  sh("pnpm --filter api test");
  finish("The api tests pass.", /pnpm/.test(memory) ? 3 : 5);
} else if (/deploy schedule/i.test(prompt)) {
  finish(
    /Tuesdays and Thursdays/.test(memory)
      ? "YES\nDeploys go out on Tuesdays and Thursdays."
      : "NO\nDeploys are Tuesdays only.",
    1,
  );
} else if (/isHighTide/.test(prompt)) {
  const indent = /Indent with tabs/.test(memory) ? "\t" : "  ";
  tool("Write");
  writeFileSync(
    join(process.cwd(), "packages/api/src/high-tide.js"),
    `export function isHighTide(level) {\n${indent}return level > 2.5;\n}\n`,
  );
  tool("Edit");
  appendFileSync(join(process.cwd(), "packages/api/src/index.js"), 'export { isHighTide } from "./high-tide.js";\n');
  finish("Added isHighTide.", 4);
} else {
  finish("ok", 1);
}
