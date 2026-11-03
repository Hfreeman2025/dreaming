import { existsSync } from "node:fs";
import { ExitCode } from "../errors.js";
import { fileKind } from "../fsx.js";
import { loadRuns, pendingProposals } from "../inbox/store.js";
import { snapshotMemory } from "../memory/snapshot.js";
import { useColor } from "../review/terminal.js";
import { detectBackend, scheduleStatus } from "../schedule/install.js";
import { loadState } from "../state.js";
import { stripControl } from "../text.js";
import { span, tildify, toAnsi, wrap, type Line } from "../ui/text.js";
import { findModel, modelBytes, modelDirs, NLI_MODEL } from "../contradict/models.js";
import { loadEvals } from "../eval/record.js";
import { loadSetup, parseFlags, resolvePaths, type CliContext } from "./context.js";
import { when } from "./why.js";

/**
 * `dreaming` with no arguments, and `dreaming status`: what is waiting, what
 * happened last, and the one thing to do next. Read-only; every check that
 * fails is an error, not a blank line.
 */

/**
 * On a terminal, lines wrap to its width under `indent` (commands stay whole);
 * piped output is never wrapped or cut.
 */
function print(ctx: CliContext, lines: readonly Line[], indent: Line = []): void {
  const color = useColor(ctx.stdout, ctx.env);
  const width = ctx.stdout.isTTY === true ? Math.max(40, ctx.stdout.columns ?? 100) : Number.POSITIVE_INFINITY;
  ctx.stdout.write(
    lines
      .flatMap((line) => wrap(line, width, indent))
      .map((line) => `${toAnsi(line, color)}\n`)
      .join(""),
  );
}

const NOT_SET_UP: Line[] = [
  [
    span("dreaming", "heading"),
    span(" proposes changes to your coding agent's memory each night; you review them like a pull request."),
  ],
  [],
  [span("Not set up yet. Point it at the memory directory to curate:")],
  [span("  dreaming init --memory-dir ~/.claude/projects/<project>/memory", "key")],
  [span("Or watch the whole loop first, on synthetic data, from a clone of the repo: "), span("npm run demo", "key")],
  [span("Every command: "), span("dreaming --help", "key")],
];

/** `dreaming` on its own: the overview, or how to start if there is no config yet. */
export async function homeCommand(_args: readonly string[], ctx: CliContext): Promise<number> {
  if ((await fileKind(resolvePaths(ctx).paths.config)) === "missing") {
    print(ctx, NOT_SET_UP);
    return ExitCode.ok;
  }
  return statusCommand([], ctx);
}

export async function statusCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  parseFlags(args, {});
  const { env, paths, config } = await loadSetup(ctx);
  const snapshot = await snapshotMemory(config.memoryDir);
  const state = await loadState(paths.state);
  const runs = await loadRuns(paths.inbox);
  const pending = pendingProposals(runs);
  const backend = detectBackend(ctx.platform, existsSync("/run/systemd/system"));
  const schedule =
    backend === null
      ? null
      : await scheduleStatus(backend, config.schedule.label, {
          homedir: ctx.homedir,
          uid: ctx.uid,
          xdgConfigHome: ctx.env.XDG_CONFIG_HOME,
          runner: ctx.runner,
        });

  const row = (label: string, value: Line): Line => [span(label.padEnd(12), "dim"), ...value];
  const show = (path: string) => stripControl(tildify(path, ctx.homedir));
  const lines: Line[] = [
    [span("dreaming", "heading"), span(`  ${show(config.memoryDir)} · ${snapshot.entries.size} memories`, "dim")],
    [],
  ];

  const waitingRuns = new Set(pending.map((p) => p.run.runId)).size;
  lines.push(
    row(
      "Waiting",
      pending.length > 0
        ? [
            span(`${pending.length} proposal${pending.length === 1 ? "" : "s"}`, "bold"),
            span(` from ${waitingRuns} dream${waitingRuns === 1 ? "" : "s"}`),
          ]
        : [span("nothing to review", "dim")],
    ),
  );
  if (state?.lastRun) {
    const { at, ok, message } = state.lastRun;
    lines.push(
      row("Last dream", [
        span(when(at)),
        span(ok ? "  ok  " : "  failed  ", ok ? "ok" : "bad"),
        span(stripControl(message.split("\n")[0] ?? ""), "dim"),
      ]),
    );
  } else {
    lines.push(
      row("Last dream", [span(`never; the first one reads the last ${config.transcripts.lookbackDays} days`, "dim")]),
    );
  }
  const tracked =
    state === null
      ? "not started"
      : `${Object.keys(state.sessions).length} session${Object.keys(state.sessions).length === 1 ? "" : "s"} tracked since ${new Date(state.floorMs).toISOString().slice(0, 10)}`;
  lines.push(row("Watermark", [span(tracked, "dim")]));
  let scheduled = false;
  if (backend === null || schedule === null) {
    lines.push(row("Schedule", [span(`not supported on ${ctx.platform}`, "dim")]));
  } else {
    scheduled = schedule.installed;
    const loaded = schedule.active === null ? "" : schedule.active ? ", loaded" : ", not loaded";
    lines.push(
      row("Schedule", [
        schedule.installed
          ? span(`${backend}, nightly at ${config.schedule.time}${loaded}`)
          : span("not scheduled", "dim"),
      ]),
    );
  }
  const evals = await loadEvals(paths.evals);
  const model = await findModel(
    modelDirs({ DREAMING_MODELS: env.DREAMING_MODELS }, paths.home, config.contradictions.modelDirs),
  );
  lines.push(
    row("Evals", [
      span(
        evals.length === 0
          ? "none yet · dreaming eval measures a proposal"
          : `${evals.length} recorded · latest ${evals.at(-1)?.createdAt.slice(0, 10) ?? ""}`,
        "dim",
      ),
    ]),
    row("Checks", [
      model === null
        ? span(
            `NLI model not installed · dreaming models install (${(modelBytes(NLI_MODEL) / 1e6).toFixed(0)} MB)`,
            "dim",
          )
        : span(`NLI model in ${show(model.dir)}`, "dim"),
    ]),
    row("Transcripts", [span(show(config.transcripts.root), "dim")]),
    row("Config", [span(show(paths.config), "dim")]),
    [],
  );

  const next: [string, string] =
    pending.length > 0
      ? ["dreaming review", "decide on what is waiting"]
      : state === null
        ? ["dreaming run --dry-run", "see what the first dream would read"]
        : !scheduled && backend !== null
          ? ["dreaming schedule install", "dream every night"]
          : ["dreaming run", "dream now instead of waiting for tonight"];
  lines.push([span("Next  ", "dim"), span(next[0], "key"), span(`  ${next[1]}`, "dim")]);
  print(ctx, lines, [span(" ".repeat(12))]);
  return ExitCode.ok;
}
