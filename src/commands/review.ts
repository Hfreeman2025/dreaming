import { ExitCode } from "../errors.js";
import { review } from "../review/session.js";
import { createTerminal } from "../review/terminal.js";
import { loadSetup, parseFlags, type CliContext } from "./context.js";

export async function reviewCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  const { values } = parseFlags(args, {
    "dry-run": { type: "boolean", default: false },
    "allow-unverified": { type: "boolean", default: false },
    plain: { type: "boolean", default: false },
  });
  const { paths, config } = await loadSetup(ctx);
  const terminal = createTerminal(ctx.stdin, ctx.stdout, ctx.env);
  try {
    const summary = await review(
      {
        paths,
        memoryDir: config.memoryDir,
        now: ctx.now,
        dryRun: values["dry-run"],
        allowUnverified: values["allow-unverified"],
      },
      terminal.interactive && !values.plain ? { kind: "screen", terminal } : { kind: "plain", io: terminal },
    );
    // Approved changes that could not be applied are a failure, not a quiet no-op.
    return summary.outcome === "conflict" ? ExitCode.failure : ExitCode.ok;
  } finally {
    terminal.close();
  }
}
