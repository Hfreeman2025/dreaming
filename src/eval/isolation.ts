import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentCommand } from "../agent/adapter.js";
import { runProcess } from "../agent/process.js";
import { errorCode } from "../errors.js";
import { parseStream } from "./stream.js";

/**
 * How an eval run is kept away from the person's own Claude Code setup, and
 * how that is proved rather than assumed.
 *
 * Every run gets:
 *   --safe-mode               installed plugins, hooks, CLAUDE.md, skills and MCP servers off
 *   --setting-sources project no user or local settings (the temporary repo has no project settings)
 *   --settings <file>         disableAllHooks, plus a canary hook on every event that would
 *                             touch a file if any hook ran at all
 *   --strict-mcp-config       no MCP servers
 *   --no-session-persistence  no transcript is written, so no dream ever reads an eval
 *   --include-hook-events     Claude Code reports every hook that starts in its own output
 * and an environment built from an allowlist (PATH with the suite's shims first, the login's
 * HOME and USER, a private TMPDIR), in a working directory outside the home directory.
 *
 * The proof has three parts. Before the runs, a positive control starts Claude Code with
 * the same canary hook enabled in an empty, separate config directory (no login, no
 * plugins, no model call): the canary must fire and the hook events must appear, which
 * shows the detector works. Every run then must show zero hook events, no canary file,
 * and (where the debug log says) zero registered hooks. A run that fails any of these
 * stops the eval.
 */

export const CANARY_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "Notification",
  "PreCompact",
  "SessionEnd",
] as const;

export const EVAL_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] as const;

/** Settings with a canary hook on every event; `hooksOff` adds disableAllHooks. */
export function canarySettings(canaryDir: string, hooksOff: boolean): string {
  const hooks = Object.fromEntries(
    CANARY_EVENTS.map((event) => [
      event,
      [{ hooks: [{ type: "command", command: `/usr/bin/touch '${join(canaryDir, event)}'` }] }],
    ]),
  );
  return `${JSON.stringify(hooksOff ? { disableAllHooks: true, hooks } : { hooks }, null, 2)}\n`;
}

export interface EvalInvocation {
  bin: string;
  cwd: string;
  prompt: string;
  settingsPath: string;
  debugFile: string;
  maxTurns: number;
  model: string | undefined;
  /** The arm's memory, in a file readable only by the user; undefined for no memory at all. */
  memoryFile: string | undefined;
}

/** The exact argv of an eval run. The prompt goes in on stdin. */
export function evalArgs(o: EvalInvocation): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-hook-events",
    "--safe-mode",
    "--setting-sources",
    "project",
    "--settings",
    o.settingsPath,
    "--strict-mcp-config",
    "--no-session-persistence",
    "--tools",
    EVAL_TOOLS.join(","),
    "--allowedTools",
    EVAL_TOOLS.join(","),
    "--permission-mode",
    "dontAsk",
    "--max-turns",
    String(o.maxTurns),
    "--debug-file",
    o.debugFile,
    ...(o.model === undefined ? [] : ["--model", o.model]),
    // From a file, not argv: memory text in an argument would be in every process listing.
    ...(o.memoryFile === undefined ? [] : ["--append-system-prompt-file", o.memoryFile]),
  ];
}

export function evalCommand(o: EvalInvocation): AgentCommand {
  return { bin: o.bin, args: evalArgs(o), cwd: o.cwd, stdin: o.prompt };
}

export interface EnvInput {
  binDir: string;
  home: string;
  user: string;
  tmpDir: string;
  extra?: Record<string, string>;
}

/**
 * The agent's whole environment. Nothing is inherited: no CLAUDE* or ANTHROPIC*
 * variables, no terminal-multiplexer integrations, no version managers, no
 * DREAMING_* settings. HOME and USER stay real because Claude Code's login lives
 * in the user's keychain and config directory; everything else is the sandbox's.
 */
export function evalEnv(input: EnvInput): NodeJS.ProcessEnv {
  return {
    PATH: `${input.binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: input.home,
    USER: input.user,
    LOGNAME: input.user,
    TMPDIR: input.tmpDir,
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    SHELL: "/bin/bash",
    ...input.extra,
  };
}

/** Canary files that exist (hooks that ran). */
export async function firedCanaries(canaryDir: string): Promise<string[]> {
  try {
    return (await readdir(canaryDir)).sort();
  } catch (error) {
    // A hook creates its file inside this directory, never the directory itself.
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

export interface ControlResult {
  ok: boolean;
  hookEvents: number;
  canaries: string[];
  durationMs: number;
  detail: string;
}

/**
 * The positive control: the canary hook, enabled, in an empty config directory
 * that has no login and no plugins, so nothing of the person's can load and no
 * model is called. It must fire.
 */
export async function runControl(
  bin: string,
  dir: string,
  who: { home: string; user: string },
  nodePath = process.execPath,
): Promise<ControlResult> {
  const canaryDir = join(dir, "canary");
  const configDir = join(dir, "config");
  const work = join(dir, "work");
  const binDir = join(dir, "bin");
  await Promise.all([
    mkdir(canaryDir, { recursive: true }),
    mkdir(configDir, { recursive: true }),
    mkdir(work, { recursive: true }),
    mkdir(binDir, { recursive: true }),
  ]);
  // The same PATH shape as a run: a `node` for agents that are scripts, then the system directories.
  await symlink(nodePath, join(binDir, "node"));
  const settingsPath = join(dir, "settings.json");
  await writeFile(settingsPath, canarySettings(canaryDir, false));
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-hook-events",
    "--setting-sources",
    "project",
    "--settings",
    settingsPath,
    "--strict-mcp-config",
    "--no-session-persistence",
    "--tools",
    "",
    "--max-turns",
    "1",
  ];
  const env = {
    ...evalEnv({ binDir, home: who.home, user: who.user, tmpDir: dir }),
    CLAUDE_CONFIG_DIR: configDir,
  };
  const result = await runProcess({ bin, args, cwd: work, stdin: "Reply with the word ok." }, env, {
    timeoutMs: 60_000,
    maxOutputBytes: 2_000_000,
  });
  const telemetry = parseStream(result.stdout);
  const canaries = await firedCanaries(canaryDir);
  const ok = telemetry.hookEvents.length > 0 && canaries.length > 0;
  return {
    ok,
    hookEvents: telemetry.hookEvents.length,
    canaries,
    durationMs: result.durationMs,
    detail: ok
      ? `canary fired on ${canaries.join(", ")}; ${telemetry.hookEvents.length} hook events reported`
      : `the canary did not fire (${canaries.length} files, ${telemetry.hookEvents.length} hook events)`,
  };
}
