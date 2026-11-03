import { DreamingError, ExitCode } from "../errors.js";
import { createRedactor } from "../redact.js";
import { useColor } from "../review/terminal.js";
import { stripControl } from "../text.js";
import { span, tildify, toAnsi, wrap, type Line, type Style } from "../ui/text.js";
import { provenance, type CheckedEvidence, type Provenance } from "../why.js";
import { loadSetup, parseFlags, type CliContext } from "./context.js";

const clean = stripControl;

/** "2026-11-01 08:12 UTC": unambiguous, and the same on every machine. */
export function when(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const STATE: Record<Provenance["state"], { text: (p: Provenance) => string; style: Style }> = {
  matches: { text: () => "✓ The file is exactly what dreaming last wrote.", style: "ok" },
  "changed-since": {
    text: () => "! The file has changed since dreaming last wrote it (edited by hand or by an agent).",
    style: "warn",
  },
  "deleted-by-dreaming": { text: () => "This memory was deleted by dreaming.", style: "dim" },
  "removed-since": { text: () => "! The file is gone; it was removed outside dreaming.", style: "warn" },
  "no-history": {
    text: () =>
      "No dreaming history: this memory was written by hand, by an agent directly, or before dreaming was set up.",
    style: "dim",
  },
};

const RECHECK: Record<CheckedEvidence["recheck"]["kind"], { text: string; style: Style }> = {
  "still-there": { text: "✓ still in the transcript", style: "ok" },
  changed: { text: "! no longer at that line (the transcript changed)", style: "warn" },
  "transcript-gone": { text: "! transcript no longer on disk", style: "warn" },
  "not-checkable": { text: "✗ not verified when proposed", style: "bad" },
};

const VERB = { add: "added", update: "updated", delete: "deleted" } as const;

export function renderWhy(p: Provenance, width: number, home = ""): Line[] {
  const path = (value: string) => clean(tildify(value, home));
  const lines: Line[] = [[span(clean(p.file), "heading"), span(p.type ? `  ${clean(p.type)}` : "", "dim")]];
  if (p.description) lines.push(...wrap([span(clean(p.description))], width));
  else if (p.lastDescription) {
    lines.push(...wrap([span("last written by dreaming: ", "dim"), span(clean(p.lastDescription))], width));
  }
  const state = STATE[p.state];
  lines.push(...wrap([span(state.text(p), state.style)], width));
  const checks = p.history.flatMap((h) => h.evidence);
  if (checks.length > 0) {
    const still = checks.filter((c) => c.recheck.kind === "still-there").length;
    const gone = checks.filter((c) => c.recheck.kind === "transcript-gone").length;
    const one = checks.length === 1;
    const parts = [
      `${still} of ${checks.length} evidence ${one ? "quote is" : "quotes are"} still in ${one ? "its transcript" : "their transcripts"}`,
    ];
    if (gone > 0) parts.push(`${gone} transcript${gone === 1 ? "" : "s"} gone`);
    lines.push(
      ...wrap(
        [span(still === checks.length ? "✓ " : "! ", still === checks.length ? "ok" : "warn"), span(parts.join(", "))],
        width,
        [span("  ")],
      ),
    );
  }
  lines.push([]);
  if (p.history.length === 0) return lines;

  lines.push([span("History", "heading")]);
  for (const { entry, evidence } of p.history) {
    const how = entry.result === "already-applied" ? "recorded (memory already matched)" : VERB[entry.action];
    lines.push([], [span(when(entry.at), "bold"), span(`  ${how}`, entry.action === "delete" ? "removed" : "added")]);
    lines.push(
      ...wrap(
        [
          span(
            `  dream ${entry.runId} · proposal ${entry.proposalId.split("-").at(-1) ?? ""} · ${entry.confidence} confidence · ${entry.edited ? "edited in review" : "approved as proposed"}`,
            "dim",
          ),
        ],
        width,
        [span("  ")],
      ),
    );
    lines.push(...wrap([span("  Why  ", "heading"), span(clean(entry.reason))], width, [span("       ")]));
    for (const { evidence: e, session, recheck } of evidence) {
      const bar = span("  ┃ ", recheck.kind === "still-there" ? "ok" : "warn");
      const where = session
        ? [clean(session.cwd ?? session.project), `session ${session.sessionId.slice(0, 8)}`]
        : ["session details missing"];
      if (e.line !== undefined) where.push(`line ${e.line}`);
      const status = RECHECK[recheck.kind];
      // The verdict first, as in the review.
      lines.push(
        ...wrap([bar, span(status.text, status.style), span(` · ${e.session} · ${where.join(" · ")}`, "dim")], width, [
          bar,
        ]),
      );
      lines.push(...wrap([bar, span(clean(e.source ?? e.quote))], width, [bar]));
      if (session && recheck.kind !== "transcript-gone") {
        // Paths are never wrapped or cut: a broken path cannot be copied.
        lines.push([bar, span("transcript  ", "dim"), span(path(session.path), "dim")]);
        lines.push([bar, span("reopen it   ", "dim"), span(`claude --resume ${session.sessionId}`, "accent")]);
      }
    }
    lines.push([span("  backup before this change  ", "dim"), span(path(entry.backupDir), "dim")]);
  }
  return lines;
}

export async function whyCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseFlags(args, { json: { type: "boolean", default: false } }, 1);
  const query = positionals[0];
  if (query === undefined) {
    throw new DreamingError("usage: dreaming why <memory> [--json]", {
      exitCode: ExitCode.usage,
      hint: "Name a memory file, for example: dreaming why prefer-pnpm",
    });
  }
  const { paths, config } = await loadSetup(ctx);
  const result = await provenance(
    config.memoryDir,
    paths.auditLog,
    query,
    createRedactor(config.redaction.extraPatterns),
  );
  if (values.json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return ExitCode.ok;
  }
  const width = Math.max(40, Math.min(ctx.stdout.columns ?? 100, 110));
  const color = useColor(ctx.stdout, ctx.env);
  ctx.stdout.write(
    renderWhy(result, width, ctx.homedir)
      .map((line) => `${toAnsi(line, color)}\n`)
      .join(""),
  );
  return ExitCode.ok;
}
