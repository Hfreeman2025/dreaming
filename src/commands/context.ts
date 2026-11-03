import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  dreamingPaths,
  homeFromEnv,
  loadConfig,
  parseEnv,
  type Config,
  type DreamingEnv,
  type DreamingPaths,
} from "../config.js";
import { DreamingError, ExitCode } from "../errors.js";
import type { CommandRunner } from "../schedule/install.js";
import { stripControl } from "../text.js";

/** Everything a command touches in the outside world, injected so tests can run commands in-process. */
export interface CliContext {
  env: NodeJS.ProcessEnv;
  homedir: string;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream & { isTTY?: boolean; columns?: number; rows?: number };
  stderr: NodeJS.WritableStream & { isTTY?: boolean; columns?: number };
  now: () => Date;
  platform: NodeJS.Platform;
  uid: number;
  runner: CommandRunner;
  /** Absolute path of the CLI entry script, for scheduled jobs. */
  cliPath: string;
  nodePath: string;
}

export interface Setup {
  env: DreamingEnv;
  paths: DreamingPaths;
  config: Config;
}

export function resolvePaths(ctx: CliContext): { env: DreamingEnv; paths: DreamingPaths } {
  const env = parseEnv(ctx.env);
  return { env, paths: dreamingPaths(homeFromEnv(env, ctx.homedir)) };
}

export async function loadSetup(ctx: CliContext): Promise<Setup> {
  const { env, paths } = resolvePaths(ctx);
  return { env, paths, config: await loadConfig(paths, ctx.homedir) };
}

/**
 * Print a line. Output can carry text from transcripts, the filesystem or the
 * agent, so control characters and escape sequences are stripped first.
 */
export function out(ctx: CliContext, text = ""): void {
  ctx.stdout.write(`${stripControl(text)}\n`);
}

/** Strict argument parsing: unknown flags and stray positionals are usage errors. */
export function parseFlags<T extends NonNullable<ParseArgsConfig["options"]>>(
  args: readonly string[],
  options: T,
  maxPositionals = 0,
) {
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new DreamingError(error instanceof Error ? error.message : String(error), { exitCode: ExitCode.usage });
  }
  if (parsed.positionals.length > maxPositionals) {
    throw new DreamingError(`unexpected argument: ${parsed.positionals[maxPositionals] ?? ""}`, {
      exitCode: ExitCode.usage,
    });
  }
  return parsed;
}
