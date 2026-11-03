import { randomInt } from "node:crypto";
import { userInfo } from "node:os";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { DreamingError, ExitCode } from "../errors.js";
import { MAX_RUNS, runEval, type EvalEvent } from "../eval/engine.js";
import { evalArgs } from "../eval/isolation.js";
import { evalFile, latestByProposal, loadEval, loadEvals, saveEval, type EvalRecord } from "../eval/record.js";
import { summarise } from "../eval/summary.js";
import { loadSuite } from "../eval/suite.js";
import { loadRuns, pendingProposals, type PendingProposal } from "../inbox/store.js";
import { useColor } from "../review/terminal.js";
import { stripControl } from "../text.js";
import { span, tildify, toAnsi, truncate, wrap, type Line } from "../ui/text.js";
import { loadSetup, out, parseFlags, type CliContext } from "./context.js";
import { evalSummaryLine, renderEval, renderVerdict, type EvalView } from "./eval-view.js";
import { commandLines } from "./run-view.js";
import { resolveExecutable } from "./schedule.js";

const Count = (min: number, max: number, what: string) =>
  z.coerce.number().int().min(min, `${what} must be at least ${min}`).max(max, `${what} must be at most ${max}`);

function parse<T>(schema: z.ZodType<T>, value: string | undefined, fallback: T): T {
  if (value === undefined) return fallback;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DreamingError(parsed.error.issues[0]?.message ?? "invalid value", { exitCode: ExitCode.usage });
  }
  return parsed.data;
}

/** Find the proposal a person means: its id, its id's last part, or its target file (with or without .md). */
export function resolveProposal(pending: readonly PendingProposal[], query: string): PendingProposal {
  const file = query.endsWith(".md") ? query : `${query}.md`;
  const matches = pending.filter(
    (p) => p.proposal.id === query || p.proposal.file === file || p.proposal.file === query,
  );
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length > 1) {
    throw new DreamingError(`${query} matches ${matches.length} pending proposals`, {
      hint: `Use the proposal id: ${matches.map((m) => m.proposal.id).join(", ")}`,
      exitCode: ExitCode.usage,
    });
  }
  throw new DreamingError(`no pending proposal called ${query}`, {
    hint:
      pending.length === 0
        ? "Nothing is waiting; run dreaming run first."
        : "Run dreaming eval with no arguments to list them.",
    exitCode: ExitCode.usage,
  });
}

/** Draw a block of lines in place on a terminal, redrawing over the previous one. */
function screen(ctx: CliContext, color: boolean) {
  let drawn = 0;
  const write = (text: string) => ctx.stdout.write(text);
  write("\u001b[?25l");
  const restore = () => write("\u001b[?25h");
  process.once("exit", restore);
  return {
    draw(lines: readonly Line[]) {
      const width = Math.max(40, (ctx.stdout.columns ?? 100) - 1);
      const rows = Math.max(10, (ctx.stdout.rows ?? 40) - 1);
      // Never taller than the terminal, or the cursor cannot get back to the top to redraw.
      const shown = lines.slice(-rows).map((line) => truncate(line, width));
      write(
        `${drawn > 0 ? `\u001b[${drawn}F` : ""}${shown.map((l) => `${toAnsi(l, color)}\u001b[K`).join("\n")}\n\u001b[J`,
      );
      drawn = shown.length;
    },
    close() {
      restore();
      process.off("exit", restore);
    },
  };
}

function initialView(
  record: Pick<EvalRecord, "proposal" | "suite" | "plan" | "agent" | "evalId" | "createdAt">,
): EvalView {
  return {
    record,
    control: null,
    planned: [],
    runs: [],
    running: new Map(),
    stopping: null,
    elapsedMs: 0,
    done: false,
    replay: null,
  };
}

function apply(view: EvalView, event: EvalEvent): void {
  if (event.kind === "control") view.control = event.control;
  else if (event.kind === "planned") view.planned = event.runs;
  else if (event.kind === "started") view.running.set(event.index, event.at);
  else if (event.kind === "finished") {
    view.running.delete(event.run.index);
    view.runs.push(event.run);
  } else view.stopping = { ended: event.ended, because: event.because };
}

/** One line per finished run, for logs and pipes. */
function plainEvent(event: EvalEvent, total: number): string | null {
  if (event.kind === "control") return `${event.control.ok ? "isolated" : "NOT ISOLATED"}: ${event.control.detail}`;
  if (event.kind === "stopping") return `stopping: ${event.because}`;
  if (event.kind !== "finished") return null;
  const r = event.run;
  const usage = r.agent.usage.input + r.agent.usage.cacheCreation + r.agent.usage.cacheRead + r.agent.usage.output;
  return `${String(r.index + 1).padStart(2)}/${total}  ${r.arm.padEnd(7)}  ${r.task}  ${r.outcome}  ${r.reason} (${r.agent.turns} turns, ${Math.round(r.wallMs / 1000)} s, ${usage} tokens)`;
}

async function confirm(ctx: CliContext, question: string): Promise<boolean> {
  const rl = createInterface({ input: ctx.stdin, output: ctx.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

function printLines(ctx: CliContext, lines: readonly Line[], color: boolean): void {
  ctx.stdout.write(lines.map((line) => `${toAnsi(line, color)}\n`).join(""));
}

/** `dreaming eval` with no proposal: what is waiting, and what has been measured. */
async function list(
  ctx: CliContext,
  pending: readonly PendingProposal[],
  evalsDir: string,
  color: boolean,
  width: number,
) {
  const latest = latestByProposal(await loadEvals(evalsDir));
  if (pending.length === 0) {
    out(ctx, "No proposals are waiting, so there is nothing to evaluate. Run dreaming run first.");
    return ExitCode.ok;
  }
  const lines: Line[] = [[span("Pending proposals", "heading")]];
  const fileWidth = Math.max(...pending.map((p) => p.proposal.file.length)) + 2;
  const wide = width >= 90;
  for (const p of pending) {
    const record = latest.get(`${p.run.runId}/${p.proposal.id}`);
    const result =
      record === undefined
        ? null
        : evalSummaryLine(
            summarise(
              record.runs,
              record.suite.tasks.map((t) => t.id),
              record.plan.seed,
            ),
          );
    const shown =
      result === null
        ? span("not measured", "dim")
        : span(
            `${result.text} · ${record?.runs.length ?? 0} runs, ${record?.createdAt.slice(0, 10) ?? ""}`,
            result.style,
          );
    const name = [
      span(`  ${stripControl(p.proposal.file).padEnd(fileWidth)}`),
      span(p.proposal.action.padEnd(8), "dim"),
    ];
    // On a narrow terminal the result gets a line of its own rather than being cut.
    if (wide) lines.push(...wrap([...name, shown], width, [span(" ".repeat(fileWidth + 10))]));
    else lines.push(name, ...wrap([span("    "), shown], width, [span("    ")]));
  }
  lines.push([], [span("Measure one  ", "dim"), span("dreaming eval <file> --suite <dir>", "key")]);
  printLines(ctx, lines, color);
  return ExitCode.ok;
}

async function replay(ctx: CliContext, source: string, speedFlag: string | undefined, color: boolean): Promise<number> {
  const path =
    source.endsWith(".json") || source.includes("/")
      ? resolve(source)
      : evalFile((await loadSetup(ctx)).paths.evals, source);
  const record = await loadEval(path);
  const width = Math.max(40, (ctx.stdout.columns ?? 100) - 1);
  const duration = Math.max(...record.runs.map((r) => r.startedMs + r.wallMs), 1);
  const speed = parse(z.coerce.number().min(1).max(1000), speedFlag, Math.max(1, Math.round(duration / 40_000)));
  const view: EvalView = { ...initialView(record), replay: { speed } };
  view.control = { ...record.isolation.control, durationMs: 0 };
  view.planned = [...record.runs]
    .sort((a, b) => a.index - b.index)
    .map((r) => ({ index: r.index, arm: r.arm, task: r.task, rep: r.rep }));
  type Timed = { at: number; event: EvalEvent };
  const timeline: Timed[] = record.runs.flatMap((r) => [
    { at: r.startedMs, event: { kind: "started" as const, index: r.index, slot: 0, at: r.startedMs } },
    { at: r.startedMs + r.wallMs, event: { kind: "finished" as const, run: r } },
  ]);
  timeline.sort((a, b) => a.at - b.at);
  const live = ctx.stdout.isTTY === true;
  if (!live) {
    // Pacing is for a screen; piped, the replay is the finished report.
    for (const item of timeline) apply(view, item.event);
    view.done = true;
    view.elapsedMs = duration;
    printLines(ctx, [...renderEval(view, width), [], ...renderVerdict(view, width)], color);
    return ExitCode.ok;
  }
  const draw = screen(ctx, color);
  const started = Date.now();
  let next = 0;
  await new Promise<void>((done) => {
    // Redraw when a run starts or finishes, and otherwise once a second for the clock: the
    // same rhythm as a live eval, whatever the speed.
    let drawnAt = 0;
    const tick = () => {
      view.elapsedMs = Math.min(duration, (Date.now() - started) * speed);
      let changed = false;
      while (next < timeline.length && (timeline[next]?.at ?? Infinity) <= view.elapsedMs) {
        const item = timeline[next];
        if (item !== undefined) apply(view, item.event);
        next += 1;
        changed = true;
      }
      if (next >= timeline.length) {
        clearInterval(timer);
        done();
        return;
      }
      if (changed || Date.now() - drawnAt >= 1000) {
        draw.draw(renderEval(view, width));
        drawnAt = Date.now();
      }
    };
    const timer = setInterval(tick, 100);
    tick();
  });
  view.done = true;
  view.elapsedMs = duration;
  draw.draw([...renderEval(view, width), [], ...renderVerdict(view, width)]);
  draw.close();
  return ExitCode.ok;
}

export async function evalCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseFlags(
    args,
    {
      suite: { type: "string" },
      runs: { type: "string" },
      tasks: { type: "string" },
      model: { type: "string" },
      parallel: { type: "string" },
      seed: { type: "string" },
      yes: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      replay: { type: "string" },
      speed: { type: "string" },
    },
    1,
  );
  const color = useColor(ctx.stdout, ctx.env);
  const width = Math.max(40, (ctx.stdout.columns ?? 100) - 1);
  if (values.replay !== undefined) return replay(ctx, values.replay, values.speed, color);

  const { paths, config } = await loadSetup(ctx);
  const pending = pendingProposals(await loadRuns(paths.inbox));
  const query = positionals[0];
  if (query === undefined) return list(ctx, pending, paths.evals, color, width);
  const proposal = resolveProposal(pending, query);

  const suiteDir = values.suite ?? config.eval.suite;
  if (suiteDir === undefined) {
    throw new DreamingError("dreaming eval needs a task suite to run", {
      hint: "Pass --suite <dir>, or set eval.suite in the config. demo/suites/tidepool is an example.",
      exitCode: ExitCode.usage,
    });
  }
  const suite = await loadSuite(isAbsolute(suiteDir) ? suiteDir : resolve(suiteDir));
  const runs = parse(Count(2, MAX_RUNS, "--runs"), values.runs, MAX_RUNS);
  const parallel = parse(Count(1, 6, "--parallel"), values.parallel, config.eval.parallel);
  const seed = parse(Count(0, 2 ** 31 - 1, "--seed"), values.seed, randomInt(2 ** 31 - 1));
  const tasks = values.tasks
    ?.split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const model = values.model ?? config.eval.model;
  const bin = await resolveExecutable(config.agent.bin, ctx.env.PATH);
  if (bin === null) {
    throw new DreamingError(`cannot find the agent binary '${config.agent.bin}'`, {
      hint: "Install Claude Code, or set agent.bin in the config to its absolute path.",
    });
  }
  const chosen = tasks ?? suite.tasks.map((t) => t.id);
  const reps = Math.floor(runs / (2 * chosen.length));
  const planned = reps * 2 * chosen.length;
  const plan: Line[] = [
    [
      span("dreaming eval", "heading"),
      span(`  ${stripControl(proposal.proposal.file)}`, "bold"),
      span(`  ${proposal.proposal.action}`, "dim"),
    ],
    ...wrap(
      [
        span(
          `${planned} ${basename(bin) === "claude" ? "real claude -p" : `${basename(bin)} -p`} runs${model === undefined ? "" : ` (${model})`}: `,
        ),
        span(
          `${chosen.length} task${chosen.length === 1 ? "" : "s"} × ${reps} × 2 arms, ${parallel} at a time, plus a free check that the hook detector works.`,
        ),
      ],
      width,
      [span("  ")],
    ),
    ...wrap([span(`Suite ${suite.name}: `, "dim"), span(stripControl(suite.about), "dim")], width, [span("  ")]),
    ...wrap(
      [
        span(
          "Uses your Claude Code login. Each run is isolated: safe mode, no user settings, all hooks off, no transcript, in a fresh copy of the suite's repo outside your home directory.",
          "dim",
        ),
      ],
      width,
      [span("  ")],
    ),
  ];

  if (existsSync(join(ctx.homedir, ".bashrc"))) {
    plan.push(
      ...wrap(
        [
          span("! ", "warn"),
          span(
            "Claude Code sources ~/.bashrc into the agent's shell, so what it sets (PATH included) applies to these runs.",
            "warn",
          ),
        ],
        width,
        [span("  ")],
      ),
    );
  }

  if (values["dry-run"]) {
    printLines(ctx, plan, color);
    const argv = evalArgs({
      bin,
      cwd: "<slot>/repo",
      prompt: "",
      settingsPath: "<slot>/settings.json",
      debugFile: "<slot>/debug.log",
      maxTurns: suite.tasks[0]?.maxTurns ?? 20,
      model,
      memoryFile: "<slot>/memory.md",
    });
    printLines(ctx, [[], [span("Each run (the task prompt goes in on stdin)", "heading")]], color);
    for (const text of commandLines([bin, ...argv], ctx.homedir)) out(ctx, `  ${text}`);
    out(ctx);
    out(ctx, "Dry run: no model was called.");
    return ExitCode.ok;
  }

  const interactive = ctx.stdin.isTTY === true && ctx.stdout.isTTY === true;
  if (!values.yes) {
    if (!interactive) {
      throw new DreamingError(`dreaming eval makes ${planned} model calls; pass --yes to start it without a terminal`, {
        exitCode: ExitCode.usage,
      });
    }
    printLines(ctx, plan, color);
    if (!(await confirm(ctx, "Start? [y/N] "))) {
      out(ctx, "Not started; no model was called.");
      return ExitCode.ok;
    }
    out(ctx);
  }

  const startedAt = ctx.now();
  const view = initialView({
    proposal: {
      runId: proposal.run.runId,
      id: proposal.proposal.id,
      action: proposal.proposal.action,
      file: proposal.proposal.file,
      description: "",
    },
    suite: {
      name: suite.name,
      about: suite.about,
      tasks: suite.tasks
        .filter((t) => chosen.includes(t.id))
        .map((t) => ({ id: t.id, prompt: t.prompt, passMeans: t.passMeans })),
    },
    plan: { runs: planned, reps, seed, parallel },
    agent: { bin, version: null, model: model ?? null, argv: [] },
    evalId: "",
    createdAt: startedAt.toISOString(),
  });
  const live = ctx.stdout.isTTY === true && !values.json;
  const draw = live ? screen(ctx, color) : null;
  const redraw = () => {
    view.elapsedMs = Date.now() - startedAt.getTime();
    draw?.draw(renderEval(view, width));
  };
  const timer = live ? setInterval(redraw, 1000) : null;
  timer?.unref();
  let record: EvalRecord;
  try {
    redraw();
    record = await runEval(
      {
        proposal,
        suite,
        memoryDir: config.memoryDir,
        runs,
        tasks,
        model,
        parallel,
        seed,
        bin,
        home: ctx.homedir,
        user: ctx.env.USER ?? userInfo().username,
        keep: values.keep,
      },
      {
        now: ctx.now,
        onEvent: (event) => {
          apply(view, event);
          if (live) redraw();
          else if (!values.json) {
            const line = plainEvent(event, planned);
            if (line !== null) out(ctx, line);
          }
        },
      },
    );
  } catch (error) {
    draw?.close();
    throw error;
  } finally {
    if (timer) clearInterval(timer);
  }
  const saved = await saveEval(paths.evals, record);
  if (values.json) {
    const summary = summarise(
      record.runs,
      record.suite.tasks.map((t) => t.id),
      record.plan.seed,
    );
    ctx.stdout.write(`${JSON.stringify({ record, summary }, null, 2)}\n`);
  } else {
    view.record = record;
    view.done = true;
    view.elapsedMs = Date.now() - startedAt.getTime();
    // Only a completed eval says anything about the memory, so only it reaches the review.
    const runs = record.runs.length;
    const outcome: Line[] =
      record.ended === "completed"
        ? [
            ...renderVerdict(view, width),
            [],
            [span("Saved  ", "dim"), span(tildify(saved, ctx.homedir), "dim")],
            [span("Shown in dreaming review next to the proposal.", "dim")],
          ]
        : wrap(
            [
              span("No verdict. ", "bold"),
              span(
                `The ${runs} finished run${runs === 1 ? " is" : "s are"} saved in ${tildify(saved, ctx.homedir)}, but not used: the review shows only completed evals.`,
                "dim",
              ),
            ],
            width,
            [span("  ")],
          );
    const final = [...renderEval(view, width), [], ...outcome];
    if (draw) draw.draw(final);
    else printLines(ctx, final, color);
  }
  draw?.close();
  if (record.ended === "completed") return ExitCode.ok;
  if (record.ended === "interrupted") return ExitCode.failure;
  throw new DreamingError(record.endedBecause ?? "the eval stopped");
}
