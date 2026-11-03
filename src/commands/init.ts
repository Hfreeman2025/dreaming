import { mkdir } from "node:fs/promises";
import { parseConfig, resolveUserPath } from "../config.js";
import { DreamingError, ExitCode } from "../errors.js";
import { fileKind, writeFileAtomic } from "../fsx.js";
import { out, parseFlags, resolvePaths, type CliContext } from "./context.js";

export async function initCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  const { values } = parseFlags(args, {
    "memory-dir": { type: "string" },
    transcripts: { type: "string" },
    force: { type: "boolean", default: false },
  });
  const memoryDirInput = values["memory-dir"];
  if (memoryDirInput === undefined) {
    throw new DreamingError("init needs --memory-dir <path>", {
      exitCode: ExitCode.usage,
      hint: "Point it at the memory directory to curate, e.g. ~/.claude/projects/<project>/memory",
    });
  }
  const { paths } = resolvePaths(ctx);
  if ((await fileKind(paths.config)) !== "missing" && !values.force) {
    throw new DreamingError(`a config file already exists: ${paths.config}`, {
      exitCode: ExitCode.usage,
      hint: "Edit it directly, or pass --force to replace it.",
    });
  }

  const memoryDir = resolveUserPath(memoryDirInput, ctx.homedir);
  if (memoryDir === null || (await fileKind(memoryDir)) !== "directory") {
    throw new DreamingError(`memory directory not found: ${memoryDirInput}`, {
      exitCode: ExitCode.usage,
      hint: "Create it first (it may be empty), or check the path.",
    });
  }
  const raw: Record<string, unknown> = { memoryDir };
  if (values.transcripts !== undefined) raw.transcripts = { root: values.transcripts };
  const config = parseConfig(raw, ctx.homedir, "command-line arguments");

  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  const written: Record<string, unknown> = { memoryDir: config.memoryDir };
  if (values.transcripts !== undefined) written.transcripts = { root: config.transcripts.root };
  await writeFileAtomic(paths.config, `${JSON.stringify(written, null, 2)}\n`);

  out(ctx, `Wrote ${paths.config}`);
  out(ctx, `  memory directory:  ${config.memoryDir}`);
  out(ctx, `  transcripts:       ${config.transcripts.root}`);
  out(ctx);
  out(ctx, "Next: `dreaming run --dry-run` to see what would be read, then `dreaming run`.");
  return ExitCode.ok;
}
