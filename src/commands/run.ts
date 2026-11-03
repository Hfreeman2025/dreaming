import { z } from "zod";
import { claudeAdapter } from "../agent/claude.js";
import { webhookTarget } from "../config.js";
import { DreamingError, ExitCode } from "../errors.js";
import { dream } from "../run/dream.js";
import { stripControl } from "../text.js";
import { useColor } from "../review/terminal.js";
import { span, toAnsi, wrap, type Line } from "../ui/text.js";
import { loadSetup, out, parseFlags, type CliContext, type Setup } from "./context.js";
import { checkPending, loadEngine, saveChecks } from "../contradict/store.js";
import { loadRuns, pendingProposals } from "../inbox/store.js";
import { createProgress, renderDream, renderDryRun, renderSkipped } from "./run-view.js";

const MaxSessionsFlag = z.coerce.number().int().min(1).max(200);

/**
 * After a dream, check its proposals for contradictions with the memory set,
 * if the local model is installed. A missing model is said once, with the
 * fix; it never fails the dream.
 */
async function contradictionCheck(ctx: CliContext, setup: Setup, width: number): Promise<Line[]> {
  const loaded = await loadEngine(setup.config, setup.env, setup.paths);
  if (!loaded.ok) {
    return wrap(
      [span("  · ", "dim"), span(`contradiction check skipped: ${loaded.reason} (${loaded.hint})`, "dim")],
      width,
      [span("    ")],
    );
  }
  try {
    const pending = pendingProposals(await loadRuns(setup.paths.inbox));
    const all = await checkPending(loaded.engine, setup.config.memoryDir, pending, {
      threshold: setup.config.contradictions.threshold,
      now: ctx.now,
    });
    for (const checks of all) await saveChecks(setup.paths.checks, checks);
    const found = all.flatMap((c) => c.proposals).filter((p) => p.contradictions.length > 0);
    const pairs = all.flatMap((c) => c.proposals).reduce((sum, p) => sum + p.pairs, 0);
    return wrap(
      [
        span(found.length > 0 ? "  ≠ " : "  ✓ ", found.length > 0 ? "bad" : "ok"),
        span(
          found.length > 0
            ? `${found.length} proposal${found.length === 1 ? "" : "s"} may contradict the memory set`
            : "no contradictions found",
        ),
        span(` · ${pairs} sentence pairs checked by a local NLI model`, "dim"),
      ],
      width,
      [span("    ")],
    );
  } finally {
    await loaded.engine.close();
  }
}

export async function runCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  const { values } = parseFlags(args, {
    "dry-run": { type: "boolean", default: false },
    "max-sessions": { type: "string" },
  });
  let maxSessions: number | undefined;
  if (values["max-sessions"] !== undefined) {
    const parsed = MaxSessionsFlag.safeParse(values["max-sessions"]);
    if (!parsed.success) {
      throw new DreamingError("--max-sessions must be a whole number from 1 to 200", { exitCode: ExitCode.usage });
    }
    maxSessions = parsed.data;
  }

  const setup = await loadSetup(ctx);
  const { env, paths, config } = setup;
  const color = useColor(ctx.stdout, ctx.env);
  const width = Math.max(40, Math.min(ctx.stdout.columns ?? 100, 110));
  const print = (lines: readonly Line[]) => {
    ctx.stdout.write(lines.map((line) => `${toAnsi(line, color)}\n`).join(""));
  };
  const progress = createProgress((text) => ctx.stdout.write(text), {
    color,
    live: ctx.stdout.isTTY === true,
    columns: () => ctx.stdout.columns,
  });
  let outcome;
  try {
    outcome = await dream(
      {
        paths,
        config,
        env: ctx.env,
        webhook: webhookTarget(config, env),
        adapter: claudeAdapter(config.agent.bin),
        now: ctx.now,
        onEvent: (event) => {
          progress.onEvent(event);
        },
      },
      { dryRun: values["dry-run"], maxSessions },
    );
  } finally {
    progress.stop();
  }

  switch (outcome.kind) {
    case "nothing-new":
      out(ctx, "No new sessions to dream over.");
      if (outcome.skipped.length > 0) print([[], ...renderSkipped(outcome.skipped, width, ctx.homedir)]);
      return ExitCode.ok;

    case "dry-run":
      print(renderDryRun(outcome, width, ctx.homedir));
      return ExitCode.ok;

    case "dreamt": {
      const { record, files, webhook } = outcome;
      print(renderDream(record, files.markdown, width, ctx.homedir));
      if (record.proposals.length > 0) print(await contradictionCheck(ctx, setup, width));
      if (record.skipped.length > 0) print([[], ...renderSkipped(record.skipped, width, ctx.homedir)]);
      if (webhook.kind === "failed") {
        ctx.stderr.write(`dreaming: warning: the dream was saved, but ${stripControl(webhook.message)}\n`);
        return ExitCode.notifyFailed;
      }
      if (webhook.kind === "sent") out(ctx, "Webhook summary sent.");
      return ExitCode.ok;
    }
  }
}
