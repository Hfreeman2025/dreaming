import { readFileSync } from "node:fs";
import { z } from "zod";
import { initCommand } from "./commands/init.js";
import { reviewCommand } from "./commands/review.js";
import { runCommand } from "./commands/run.js";
import { scheduleCommand } from "./commands/schedule.js";
import { homeCommand, statusCommand } from "./commands/status.js";
import { whyCommand } from "./commands/why.js";
import { checkCommand, modelsCommand } from "./commands/check.js";
import { evalCommand } from "./commands/eval.js";
import type { CliContext } from "./commands/context.js";
import { DreamingError, ExitCode } from "./errors.js";
import { parseJson } from "./fsx.js";
import { useColor } from "./review/terminal.js";
import { stripControl } from "./text.js";
import { span, toAnsi, toPlain, wrap } from "./ui/text.js";

export const HELP = `dreaming proposes changes to your coding agent's memory each night;
you review them like a pull request.

Usage: dreaming [command] [flags]

Commands
  (no command)          what is waiting, and what to do next
  init                  write ~/.dreaming/config.json
    --memory-dir <dir>  the memory directory to curate (required)
    --transcripts <dir> where session transcripts live (default ~/.claude/projects)
    --force             replace an existing config
  run                   read new sessions; file proposals with quoted evidence
    --dry-run           show the sessions and the exact agent command; start nothing
    --max-sessions <n>  read at most n sessions (1 to 200)
  review                approve, reject, edit or skip each proposal, then submit
    --plain             line by line, for pipes and screen readers
    --dry-run           show what would change; write nothing
    --allow-unverified  allow approving a proposal whose evidence did not verify
  why <memory>          where a memory came from, its evidence re-checked now
    --json              the same, as JSON
  eval <proposal>       measure a proposal: a task suite run with and without it
    --suite <dir>       the task suite (default: eval.suite in the config)
    --runs <n>          real claude -p runs, both arms together (2 to 30; default 30)
    --tasks <a,b>       only these tasks
    --model <name>      the model for the runs (default: eval.model, else the CLI's)
    --dry-run           show the plan and the exact command; call no model
    --replay <file|id>  replay a recorded eval at speed; call no model
  check                 check pending proposals for contradictions, with a local NLI model
  models                the local NLI model: where it is, or install to download it
    --verify            check every file's SHA-256
  status                config, watermark, last dream, inbox, schedule
  schedule <action>     install, uninstall or status of the nightly dream
    --at HH:MM          the time, 24-hour (default: the config's, 02:00 unless set)
    --backend <name>    launchd, systemd or cron (default: this system's)
    --print             show the files; install nothing

Environment
  DREAMING_HOME         where config, inbox, state and audit log live (default ~/.dreaming)
  DREAMING_WEBHOOK_URL  a webhook for a run summary (overrides the config file)
  DREAMING_MODELS       where the NLI model lives, instead of <home>/models
  NO_COLOR              no colour; every mark and word stays, only the highlighting goes

Exit codes: 0 ok, 1 failure, 2 usage or config error, 3 dream saved but webhook failed.
`;

/** Where every description in HELP starts. */
const HELP_COLUMN = 24;

/**
 * HELP laid out for a terminal: as written when it fits, and otherwise with
 * each description on its own lines under its label, wrapped at word breaks.
 */
export function helpFor(columns = 100): string {
  const width = Math.max(30, columns);
  const lines = HELP.split("\n");
  if (lines.every((line) => line.length <= width)) return HELP;
  return lines
    .flatMap((line) => {
      const label = line.slice(0, HELP_COLUMN).trimEnd();
      const described = /^ {2,4}\S/.test(line) && line.length > HELP_COLUMN && line[HELP_COLUMN - 1] === " ";
      if (!described) return wrap([span(line)], width).map(toPlain);
      const indent = " ".repeat(label.length - label.trimStart().length + 4);
      return [label, ...wrap([span(indent + line.slice(HELP_COLUMN))], width, [span(indent)]).map(toPlain)];
    })
    .join("\n");
}

function version(): string {
  const json = parseJson(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const parsed = z.object({ version: z.string() }).safeParse(json.ok ? json.value : undefined);
  if (!parsed.success) throw new DreamingError("package.json has no version; the installation is damaged");
  return parsed.data.version;
}

const COMMANDS: Record<string, (args: readonly string[], ctx: CliContext) => Promise<number>> = {
  init: initCommand,
  run: runCommand,
  review: reviewCommand,
  status: statusCommand,
  schedule: scheduleCommand,
  why: whyCommand,
  eval: evalCommand,
  check: checkCommand,
  models: modelsCommand,
};

/** Run the CLI and return the exit code. Errors are reported here, once. */
export async function main(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [name, ...args] = argv;
  if (name === "help" || name === "--help" || name === "-h") {
    ctx.stdout.write(ctx.stdout.isTTY === true ? helpFor(ctx.stdout.columns) : HELP);
    return ExitCode.ok;
  }
  if (name === "--version" || name === "-v") {
    ctx.stdout.write(`${version()}\n`);
    return ExitCode.ok;
  }
  // No command: show what is waiting and what to do next (or how to start).
  const command = name === undefined ? homeCommand : COMMANDS[name];
  if (command === undefined) {
    ctx.stderr.write(`dreaming: unknown command '${name ?? ""}'. Run 'dreaming --help' for usage.\n`);
    return ExitCode.usage;
  }
  try {
    return await command(args, ctx);
  } catch (error) {
    if (error instanceof DreamingError) {
      // Messages can quote agent stderr or file paths; keep them inert in a terminal,
      // show paths under the home directory as ~, and colour only on a terminal.
      const show = (text: string) => stripControl(text).replaceAll(`${ctx.homedir}/`, "~/");
      const color = useColor(ctx.stderr, ctx.env);
      // On a terminal, wrap at word breaks under an indent; in a log, one line each.
      const width = ctx.stderr.isTTY === true ? Math.max(40, ctx.stderr.columns ?? 100) : Number.POSITIVE_INFINITY;
      const lines = [
        ...wrap([span("dreaming: error: ", "bad"), span(show(error.message))], width, [span("  ")]),
        ...(error.hint === undefined ? [] : show(error.hint).split("\n")).flatMap((line) =>
          wrap([span(`  ${line}`, "dim")], width, [span("  ")]),
        ),
      ];
      ctx.stderr.write(lines.map((line) => `${toAnsi(line, color)}\n`).join(""));
      return error.exitCode;
    }
    throw error;
  }
}
