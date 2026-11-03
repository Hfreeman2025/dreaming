import { createInterface } from "node:readline/promises";
import { checkPending, loadEngine, saveChecks } from "../contradict/store.js";
import { downloadModel, findModel, modelBytes, modelDirs, NLI_MODEL, verifyModel } from "../contradict/models.js";
import { DreamingError, ExitCode } from "../errors.js";
import { loadRuns, pendingProposals } from "../inbox/store.js";
import { useColor } from "../review/terminal.js";
import { stripControl } from "../text.js";
import { span, tildify, toAnsi, wrap, type Line } from "../ui/text.js";
import { loadSetup, out, parseFlags, type CliContext } from "./context.js";

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const MODEL_LINE = `${NLI_MODEL.id} (revision ${NLI_MODEL.revision.slice(0, 7)}, int8, Apache-2.0)`;

function print(ctx: CliContext, lines: readonly Line[]): void {
  const color = useColor(ctx.stdout, ctx.env);
  ctx.stdout.write(lines.map((line) => `${toAnsi(line, color)}\n`).join(""));
}

/**
 * `dreaming check`: each pending proposal against the memory set and the
 * other pending proposals, with the local NLI model. Results are saved for
 * `dreaming review`.
 */
export async function checkCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  parseFlags(args, {});
  const { env, paths, config } = await loadSetup(ctx);
  const width = Math.max(40, (ctx.stdout.columns ?? 100) - 1);
  const pending = pendingProposals(await loadRuns(paths.inbox));
  if (pending.length === 0) {
    out(ctx, "No proposals are waiting, so there is nothing to check.");
    return ExitCode.ok;
  }
  const loaded = await loadEngine(config, env, paths);
  if (!loaded.ok) throw new DreamingError(`cannot check for contradictions: ${loaded.reason}`, { hint: loaded.hint });
  try {
    const started = Date.now();
    const all = await checkPending(loaded.engine, config.memoryDir, pending, {
      threshold: config.contradictions.threshold,
      now: ctx.now,
    });
    for (const checks of all) await saveChecks(paths.checks, checks);
    const results = all.flatMap((c) => c.proposals);
    const pairs = results.reduce((sum, r) => sum + r.pairs, 0);
    const lines: Line[] = [
      ...wrap(
        [
          span(`Checked ${pending.length} proposals`, "heading"),
          span(
            ` · ${pairs} sentence pairs, both ways, in ${((Date.now() - started) / 1000).toFixed(1)} s on this machine · model loaded in ${(loaded.loadMs / 1000).toFixed(1)} s`,
            "dim",
          ),
        ],
        width,
      ),
    ];
    const fileWidth = Math.max(...pending.map((p) => p.proposal.file.length)) + 2;
    for (const p of pending) {
      const result = results.find((r) => r.proposalId === p.proposal.id);
      const found = result?.contradictions ?? [];
      lines.push(
        ...wrap(
          [
            span(`  ${found.length > 0 ? "≠" : "·"} `, found.length > 0 ? "bad" : "dim"),
            span(stripControl(p.proposal.file).padEnd(fileWidth)),
            result === undefined
              ? span("nothing to check (a delete)", "dim")
              : found.length === 0
                ? span(
                    result.pairs === 0
                      ? "nothing to compare"
                      : `no contradiction found in ${result.pairs} sentence pairs`,
                    "dim",
                  )
                : span(
                    `contradicts ${[...new Set(found.map((c) => c.b.file))].map(stripControl).join(", ")} (${found[0]?.score.toFixed(2) ?? ""})`,
                    "bad",
                  ),
          ],
          width,
          [span(" ".repeat(fileWidth + 4))],
        ),
      );
    }
    lines.push(
      [],
      ...wrap(
        [
          span(
            "A contradiction here is inferred by a small local model (precision about 0.82 on the labelled set in docs/contradiction-accuracy.json): read both sentences before acting on it. The review shows them next to each proposal.",
            "dim",
          ),
        ],
        width,
      ),
    );
    print(ctx, lines);
    return ExitCode.ok;
  } finally {
    await loaded.engine.close();
  }
}

/** `dreaming models` and `dreaming models install`: the local NLI model the contradiction check uses. */
export async function modelsCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseFlags(
    args,
    { yes: { type: "boolean", default: false }, verify: { type: "boolean", default: false } },
    1,
  );
  const { env, paths, config } = await loadSetup(ctx);
  const dirs = modelDirs({ DREAMING_MODELS: env.DREAMING_MODELS }, paths.home, config.contradictions.modelDirs);
  const found = await findModel(dirs);
  const size = mb(modelBytes(NLI_MODEL));
  const action = positionals[0];
  if (action !== undefined && action !== "install") {
    throw new DreamingError(`usage: dreaming models [install] [--yes] [--verify]`, { exitCode: ExitCode.usage });
  }

  if (action === undefined) {
    const lines: Line[] = [[span("NLI model", "heading"), span(`  ${MODEL_LINE}`, "dim")]];
    if (found === null) {
      lines.push(
        [
          span("Not installed. ", "warn"),
          span(
            `dreaming models install downloads ${size} from huggingface.co to ${tildify(dirs[0] ?? "", ctx.homedir)}.`,
          ),
        ],
        [span("Without it, everything works except the contradiction check.", "dim")],
      );
    } else {
      lines.push([span("✓ ", "ok"), span(`installed in ${tildify(found.dir, ctx.homedir)} (${size})`)]);
      if (values.verify) {
        const bad = await verifyModel(found.path);
        lines.push(
          bad.length === 0
            ? [span("✓ ", "ok"), span("every file matches its SHA-256")]
            : [span("✗ ", "bad"), span(`these files do not match their SHA-256: ${bad.join(", ")}`, "bad")],
        );
        if (bad.length > 0) {
          print(ctx, lines);
          return ExitCode.failure;
        }
      }
    }
    lines.push([span("Searched  ", "dim"), span(dirs.map((d) => tildify(d, ctx.homedir)).join(", "), "dim")]);
    print(ctx, lines);
    return ExitCode.ok;
  }

  if (found !== null) {
    out(ctx, `Already installed in ${tildify(found.dir, ctx.homedir)}; nothing to download.`);
    return ExitCode.ok;
  }
  const target = dirs[0];
  if (target === undefined) throw new DreamingError("no directory to install the model into");
  const question = `Download ${MODEL_LINE}, ${size} from huggingface.co, into ${tildify(target, ctx.homedir)}? [y/N] `;
  if (!values.yes) {
    if (ctx.stdin.isTTY !== true || ctx.stdout.isTTY !== true) {
      throw new DreamingError(`the download is ${size}; pass --yes to start it without a terminal`, {
        exitCode: ExitCode.usage,
      });
    }
    const rl = createInterface({ input: ctx.stdin, output: ctx.stdout });
    const answer = await rl.question(question).finally(() => {
      rl.close();
    });
    if (!/^y(es)?$/i.test(answer.trim())) {
      out(ctx, "Nothing was downloaded.");
      return ExitCode.ok;
    }
  }
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
  };
  process.once("SIGINT", cancel);
  const live = ctx.stdout.isTTY === true;
  try {
    const path = await downloadModel(target, {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.kind === "bytes" && live) {
          const done = p.totalReceived / p.totalBytes;
          const bar = `${"━".repeat(Math.round(done * 30))}${"─".repeat(30 - Math.round(done * 30))}`;
          ctx.stdout.write(`\r\u001b[K  ${bar} ${mb(p.totalReceived)} of ${mb(p.totalBytes)}  Ctrl-C cancels`);
        } else if (p.kind === "file" && !live) {
          out(ctx, `  ${p.file} (${mb(p.bytes)})`);
        }
      },
    });
    if (live) ctx.stdout.write("\r\u001b[K");
    out(ctx, `✓ Installed in ${tildify(path, ctx.homedir)}; every file matched its SHA-256.`);
    return ExitCode.ok;
  } catch (error) {
    if (live) ctx.stdout.write("\r\u001b[K");
    if (controller.signal.aborted) {
      out(ctx, "Cancelled. Nothing partial was left behind; files already finished are kept for next time.");
      return ExitCode.failure;
    }
    throw error;
  } finally {
    process.off("SIGINT", cancel);
  }
}
