import type { AgentCommand } from "../agent/adapter.js";
import type { RunRecord, SkippedEntry } from "../inbox/schema.js";
import type { RunEvent } from "../run/dream.js";
import type { SessionDigest } from "../transcripts/digest.js";
import { stripControl } from "../text.js";
import { lineWidth, span, tildify, toAnsi, truncate, wrap, type Line } from "../ui/text.js";

/**
 * What `dreaming run` shows while it works and when it is done. On a
 * terminal the agent phase has a live elapsed clock, the only moving thing
 * dreaming ever draws; in a log (cron, launchd) each phase is one line.
 */

const clean = stripControl;

export function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export interface Progress {
  onEvent(event: RunEvent): void;
  stop(): void;
}

export function createProgress(
  write: (text: string) => void,
  options: { color: boolean; live: boolean; now?: () => number; columns?: () => number | undefined },
): Progress {
  const now = options.now ?? Date.now;
  // Read on every draw: the terminal can be resized while the agent works.
  const width = () => Math.max(20, options.columns?.() ?? 100);
  const print = (line: Line) => {
    for (const row of wrap(line, width(), [span("    ")])) write(`${toAnsi(row, options.color)}\n`);
  };
  let timer: NodeJS.Timeout | undefined;
  let agent = "";
  let startedAt = 0;
  /**
   * The live line is redrawn in place with a carriage return, which only
   * works while it fits on one row; a wrapped line would leave a copy behind
   * every second. So it gets shorter instead, and never reaches the last column.
   */
  const waiting = (): Line => {
    const room = width() - 1;
    const time = span(clock(now() - startedAt), "bold");
    const full = [
      span("  ● ", "accent"),
      span(`asking ${agent}, read-only `),
      time,
      span("   Ctrl-C stops it; nothing is filed until it answers", "dim"),
    ];
    if (lineWidth(full) <= room) return full;
    const short = [span("  ● ", "accent"), span(`asking ${agent} `), time, span("  Ctrl-C stops it", "dim")];
    if (lineWidth(short) <= room) return short;
    // The clock is what matters most, so it is the last thing to go.
    return truncate([span("  ● ", "accent"), span(`${agent} `), time], room);
  };
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  return {
    onEvent(event) {
      if (event.kind === "read") {
        if (event.sessions === 0) return; // the run's result says so, with what was skipped
        const active = event.skipped.filter((s) => s.reason === "active").length;
        const extra = [
          active > 0 ? `${active} still active, left for later` : "",
          event.skipped.length - active > 0 ? `${event.skipped.length - active} skipped` : "",
        ].filter((part) => part !== "");
        print([
          span("  ✓ ", "ok"),
          span(`${plural(event.sessions, "session")} to read`),
          span(extra.length > 0 ? ` · ${extra.join(" · ")}` : "", "dim"),
        ]);
        if (event.sessions > 0) {
          const notes = [
            plural(event.messages, "message"),
            event.omitted > 0 ? `${event.omitted} trimmed to fit` : "",
            `${plural(event.redactions, "secret")} redacted before the agent sees them`,
          ].filter((part) => part !== "");
          print([span("  ✓ ", "ok"), span("digested"), span(` · ${notes.join(" · ")}`, "dim")]);
        }
      } else if (event.kind === "agent-started") {
        agent = event.agent;
        startedAt = event.startedAt;
        if (options.live) {
          write(toAnsi(waiting(), options.color));
          timer = setInterval(() => {
            write(`\r\u001b[K${toAnsi(waiting(), options.color)}`);
          }, 1000);
          timer.unref();
        } else {
          print([span("  … ", "accent"), span(`asking ${agent}, read-only (this usually takes a few minutes)`)]);
        }
      } else {
        stopTimer();
        const line: Line = [
          span(event.ok ? "  ✓ " : "  ✗ ", event.ok ? "ok" : "bad"),
          span(`${agent} ${event.ok ? "replied" : "stopped"} after ${clock(event.durationMs)}`),
        ];
        if (options.live) write(`\r\u001b[K${toAnsi(line, options.color)}\n`);
        else print(line);
      }
    },
    stop() {
      if (timer && options.live) write("\n");
      stopTimer();
    },
  };
}

const ACTION: Record<"add" | "update" | "delete", { mark: string; style: "added" | "accent" | "removed" }> = {
  add: { mark: "+", style: "added" },
  update: { mark: "~", style: "accent" },
  delete: { mark: "−", style: "removed" },
};

export function renderSkipped(skipped: readonly SkippedEntry[], width: number, home = ""): Line[] {
  if (skipped.length === 0) return [];
  const lines: Line[] = [[span("Not read this time", "heading")]];
  for (const entry of skipped) {
    // Paths are printed whole: a cut path cannot be copied.
    lines.push([span(`  ${entry.reason.padEnd(10)}`, "dim"), span(clean(tildify(entry.path, home)))]);
    lines.push(...wrap([span(`            ${clean(entry.detail)}`, "dim")], width, [span("            ")]));
  }
  return lines;
}

/** The result of a dream: what was filed, how much of the evidence checked out, what to do next. */
export function renderDream(record: RunRecord, inbox: string, width: number, home = ""): Line[] {
  const shown = clean(tildify(inbox, home));
  const quotes = record.proposals.flatMap((p) => p.evidence);
  const verified = quotes.filter((q) => q.status === "verified").length;
  const reply = record.replyRedactions ?? 0;
  const lines: Line[] = [
    [],
    ...wrap(
      [
        span(plural(record.proposals.length, "proposal"), "heading"),
        span(` filed for review · ${verified} of ${quotes.length} quotes verified`, "dim"),
      ],
      width,
    ),
  ];
  // A secret in the reply means the agent wrote one out; say so, in its own words, not as a total.
  if (reply > 0) {
    lines.push(
      ...wrap(
        [
          span("! ", "warn"),
          span(
            `The agent's reply contained ${reply === 1 ? "a secret-shaped string" : `${reply} secret-shaped strings`}; ${reply === 1 ? "it was" : "they were"} redacted before filing.`,
            "warn",
          ),
        ],
        width,
        [span("  ")],
      ),
    );
  }
  const fileWidth = Math.min(28, Math.max(...record.proposals.map((p) => p.file.length), 8));
  for (const p of record.proposals) {
    const action = ACTION[p.action];
    const ok = p.evidence.every((e) => e.status === "verified");
    lines.push(
      truncate(
        [
          span(`  ${action.mark} `, action.style),
          span(p.action.padEnd(7), action.style),
          span(clean(p.file).padEnd(fileWidth + 2)),
          span(("type" in p ? p.type : "").padEnd(11), "dim"),
          span(p.confidence.padEnd(8), "dim"),
          span(
            `${p.evidence.filter((e) => e.status === "verified").length}/${p.evidence.length} `,
            ok ? undefined : "bad",
          ),
          span(ok ? "✓" : "✗", ok ? "ok" : "bad"),
        ],
        width,
      ),
    );
  }
  lines.push(...wrap([span(`  “${clean(record.summary)}”`, "dim")], width, [span("   ")]), []);
  lines.push(
    record.proposals.length > 0
      ? [span("Next  ", "dim"), span("dreaming review", "key"), span(`   inbox ${shown}`, "dim")]
      : [span("Nothing to review. ", "dim"), span(`Inbox ${shown}`, "dim")],
  );
  return lines;
}

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * A command as a shell would take it: one flag (with its values) per line,
 * joined by backslashes, so it can be read, and pasted and run as it is.
 * Paths under the home directory are shown as ~/…, which the shell expands
 * back; anything that needs quoting is quoted instead, and never shortened.
 */
export function commandLines(argv: readonly string[], home = ""): string[] {
  const word = (arg: string) => {
    if (home !== "" && arg.startsWith(`${home}/`) && SAFE.test(arg)) return `~${arg.slice(home.length)}`;
    return SAFE.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
  };
  const groups: string[][] = [];
  for (const arg of argv) {
    if (groups.length === 0 || arg.startsWith("-")) groups.push([word(arg)]);
    else groups.at(-1)?.push(word(arg));
  }
  return groups.map((group, i) => `${i === 0 ? "" : "  "}${group.join(" ")}${i < groups.length - 1 ? " \\" : ""}`);
}

/** A dry run: what would be read, the exact agent command, and where the prompt was written for inspection. */
export function renderDryRun(
  outcome: {
    digests: readonly SessionDigest[];
    skipped: readonly SkippedEntry[];
    command: AgentCommand;
    workspace: string;
  },
  width: number,
  home = "",
): Line[] {
  const lines: Line[] = [[], [span(`Would read ${plural(outcome.digests.length, "session")}`, "heading")]];
  for (const d of outcome.digests) {
    lines.push(
      ...wrap(
        [
          span(`  ${d.ref.padEnd(4)}`, "accent"),
          span(clean(tildify(d.cwd ?? d.project, home))),
          span(
            ` · session ${d.sessionId.slice(0, 8)} · lines ${d.firstLine}–${d.lastLine} · ${plural(d.messages.length, "message")}`,
            "dim",
          ),
        ],
        width,
        [span("      ")],
      ),
    );
  }
  if (outcome.skipped.length > 0) lines.push([], ...renderSkipped(outcome.skipped, width, home));
  lines.push([], [span("Agent command", "heading"), span("  the prompt goes in on stdin", "dim")]);
  // Printed whole, never cut: a cut command cannot be run.
  for (const text of commandLines([outcome.command.bin, ...outcome.command.args], home)) {
    lines.push([span(`  ${clean(text)}`)]);
  }
  lines.push(
    [],
    [span("Prompt and digests  ", "dim"), span(clean(tildify(outcome.workspace, home)))],
    ...wrap([span("Dry run: ", "bold"), span("the agent was not started and the watermark did not move.")], width),
  );
  return lines;
}
