import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { clock, commandLines, createProgress, renderDream } from "../src/commands/run-view.js";
import { fileDiff } from "../src/review/diff-view.js";
import { renderDiff } from "../src/review/render.js";
import {
  fit,
  lineWidth,
  span,
  spread,
  textWidth,
  tildify,
  toAnsi,
  toPlain,
  truncate,
  wrap,
  type Line,
} from "../src/ui/text.js";

const plain = (lines: Line[]) => lines.map(toPlain);

describe("text layout", () => {
  it("measures terminal columns: wide characters count two, combining marks none", () => {
    expect(textWidth("abc")).toBe(3);
    expect(textWidth("\u65e5\u672c")).toBe(4);
    expect(textWidth("\u{1F389}")).toBe(2);
    expect(textWidth("e\u0301")).toBe(1);
  });

  it("never breaks inside a command, and keeps a separator with the word before it", () => {
    const line = [span("Next  "), span("dreaming review --plain", "key"), span("  then submit")];
    expect(plain(wrap(line, 20))).toEqual(["Next", "dreaming review --plain", "then submit"]);
    expect(plain(wrap([span("S1 · /home/sam/tidepool · session 3b9e7c1a")], 26))).toEqual([
      "S1 · /home/sam/tidepool ·",
      "session 3b9e7c1a",
    ]);
  });

  it("fills a line to the last column when a word ends exactly there", () => {
    expect(plain(wrap([span("abcd efgh ijkl")], 9))).toEqual(["abcd efgh", "ijkl"]);
  });

  it("wraps at spaces, hard-breaks long words, and indents continuations", () => {
    expect(plain(wrap([span("the quick brown fox jumps")], 10))).toEqual(["the quick", "brown fox", "jumps"]);
    expect(plain(wrap([span("abcdefghijkl")], 5))).toEqual(["abcde", "fghij", "kl"]);
    expect(plain(wrap([span("> "), span("one two three four")], 10, [span("> ")]))).toEqual([
      "> one two",
      "> three",
      "> four",
    ]);
  });

  it("never produces a line wider than asked, whatever the content", () => {
    const content = [
      span(
        "Mixed \u65e5\u672c\u8a9e text with \u{1F389} emoji, a-very-long-unbroken-token-that-must-break and more words.",
      ),
    ];
    for (let width = 4; width <= 60; width += 1) {
      for (const line of wrap(content, width, [span("  ")])) expect(lineWidth(line)).toBeLessThanOrEqual(width);
      expect(lineWidth(truncate(content, width))).toBeLessThanOrEqual(width);
      expect(lineWidth(fit(content, width))).toBe(width);
    }
  });

  it("keeps the right-hand part when a line is tight", () => {
    expect(toPlain(spread([span("left side text")], [span("2/5")], 12))).toBe("left si… 2/5");
  });

  it("prints colour only when asked, and the same text either way", () => {
    const line = [span("ok", "ok"), span(" plain")];
    expect(toAnsi(line, false)).toBe("ok plain");
    expect(toAnsi(line, true)).toBe("\u001b[32mok\u001b[39m plain");
  });

  it("shows paths under the home directory as ~", () => {
    expect(tildify("/home/sam/.dreaming/inbox", "/home/sam")).toBe("~/.dreaming/inbox");
    expect(tildify("/home/samuel/x", "/home/sam")).toBe("/home/samuel/x");
  });
});

describe("diffs as a reviewer reads them", () => {
  const change = {
    file: "deploy-window.md",
    before: "---\nname: deploy-window\ndescription: Deploys happen on Tuesdays\n---\n\nBody.\n",
    after: "---\nname: deploy-window\ndescription: Deploys happen on Tuesdays and Thursdays\n---\n\nBody.\n",
  };

  it("numbers lines and marks the words that changed inside a changed line", () => {
    const diff = fileDiff(change);
    expect(diff).toMatchObject({ status: "modified", added: 1, removed: 1 });
    const added = diff.rows.find((row) => row.kind === "add");
    expect(added?.number).toBe(3);
    expect(added?.segments.filter((s) => s.changed).map((s) => s.text)).toEqual([" and Thursdays"]);
  });

  it("renders the changed words with their own style", () => {
    const lines = renderDiff([change], 80);
    const addLine = lines.find((line) => toPlain(line).includes("+ description"));
    expect(addLine?.find((s) => s.style === "addedWord")?.text).toBe(" and Thursdays");
    expect(plain(lines)[0]).toBe("deploy-window.md  modified  +1 −1");
  });

  it("separates hunks of a long file", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const after = before.replace("line 2\n", "line two\n").replace("line 28", "line twenty-eight");
    expect(plain(renderDiff([{ file: "long.md", before, after }], 80))).toContain("     ⋯");
  });
});

describe("dreaming run progress", () => {
  it("prints one line per phase in a log", () => {
    let out = "";
    let now = 0;
    const progress = createProgress((text) => (out += text), { color: false, live: false, now: () => now });
    progress.onEvent({
      kind: "read",
      sessions: 2,
      skipped: [{ path: "/t/x.jsonl", reason: "active", detail: "d" }],
      messages: 9,
      omitted: 0,
      redactions: 1,
    });
    progress.onEvent({ kind: "agent-started", agent: "claude", startedAt: 0 });
    now = 72_000;
    progress.onEvent({ kind: "agent-finished", durationMs: 72_000, ok: true });
    progress.stop();
    expect(out).toBe(
      [
        "  ✓ 2 sessions to read · 1 still active, left for later",
        "  ✓ digested · 9 messages · 1 secret redacted before the agent sees them",
        "  … asking claude, read-only (this usually takes a few minutes)",
        "  ✓ claude replied after 1:12",
        "",
      ].join("\n"),
    );
  });

  it("on a terminal, keeps one line with a live clock and replaces it when the agent answers", () => {
    let out = "";
    const progress = createProgress((text) => (out += text), { color: false, live: true, now: () => 5_000 });
    progress.onEvent({ kind: "agent-started", agent: "claude", startedAt: 0 });
    progress.onEvent({ kind: "agent-finished", durationMs: 5_000, ok: false });
    expect(out).toBe(
      "  ● asking claude, read-only 0:05   Ctrl-C stops it; nothing is filed until it answers\r\u001b[K  ✗ claude stopped after 0:05\n",
    );
    expect(clock(3_725_000)).toBe("62:05");
  });

  it("keeps the live line on one row of a narrow terminal, so redraws never leave copies", () => {
    vi.useFakeTimers();
    try {
      let now = 5_000;
      let columns = 40;
      let out = "";
      const progress = createProgress((text) => (out += text), {
        color: false,
        live: true,
        now: () => now,
        columns: () => columns,
      });
      progress.onEvent({ kind: "agent-started", agent: "claude", startedAt: 0 });
      expect(out).toBe("  ● asking claude 0:05  Ctrl-C stops it");
      columns = 16; // resized while waiting
      now = 6_000;
      vi.advanceTimersByTime(1000);
      progress.onEvent({ kind: "agent-finished", durationMs: 6_000, ok: true });
      const drawn = out.split("\r\u001b[K");
      expect(drawn).toEqual([
        "  ● asking claude 0:05  Ctrl-C stops it",
        "  ● claude 0:06",
        "  ✓ claude replied after 0:06\n",
      ]);
      for (const row of drawn.slice(0, -1)) expect(textWidth(row)).toBeLessThan(40);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps progress lines under their text on a narrow terminal", () => {
    let out = "";
    const progress = createProgress((text) => (out += text), { color: false, live: false, columns: () => 40 });
    progress.onEvent({ kind: "read", sessions: 2, skipped: [], messages: 9, omitted: 0, redactions: 1 });
    expect(out).toBe(
      [
        "  ✓ 2 sessions to read",
        "  ✓ digested · 9 messages · 1 secret",
        "    redacted before the agent sees them",
        "",
      ].join("\n"),
    );
  });

  it("summarises a dream the way the review will show it", () => {
    const lines = plain(
      renderDream(
        {
          schemaVersion: 1,
          runId: "20261101-020000-abcd",
          createdAt: "2026-11-01T02:00:00.000Z",
          memoryDir: "/m",
          agent: { kind: "claude", command: ["claude"], durationMs: 1 },
          summary: "1 session: 1 new preference.",
          sessions: [],
          skipped: [],
          redactions: 2,
          replyRedactions: 1,
          proposals: [
            {
              action: "add",
              id: "20261101-020000-abcd-1",
              file: "prefer-pnpm.md",
              name: "prefer-pnpm",
              description: "d",
              type: "feedback",
              body: "b",
              reason: "r",
              confidence: "high",
              evidence: [{ session: "S1", quote: "q", status: "not-found" }],
              baseHash: null,
              problems: [],
              status: "pending",
            },
          ],
        },
        "/home/sam/.dreaming/inbox/20261101-020000-abcd.md",
        100,
      ),
    );
    expect(lines).toEqual([
      "",
      "1 proposal filed for review · 0 of 1 quotes verified",
      "! The agent's reply contained a secret-shaped string; it was redacted before filing.",
      "  + add    prefer-pnpm.md  feedback   high    0/1 ✗",
      "  “1 session: 1 new preference.”",
      "",
      "Next  dreaming review   inbox /home/sam/.dreaming/inbox/20261101-020000-abcd.md",
    ]);
  });
});

describe("commandLines", () => {
  it("prints one flag per line, and the shell reads it back as the same argv", () => {
    const home = "/home/sam";
    const args = [
      "--add-dir",
      `${home}/runs/1`,
      "--name",
      "it's here",
      "--empty",
      "",
      "--outside",
      "/opt/x y",
      "--last",
    ];
    const lines = commandLines(["printf", "%s\\n", ...args], home);
    expect(lines).toEqual([
      "printf '%s\\n' \\",
      "  --add-dir ~/runs/1 \\",
      "  --name 'it'\\''s here' \\",
      "  --empty '' \\",
      "  --outside '/opt/x y' \\",
      "  --last",
    ]);
    const shell = spawnSync("/bin/sh", ["-c", lines.join("\n")], { env: { HOME: home }, encoding: "utf8" });
    expect(shell.stdout).toBe(`${args.join("\n")}\n`);
  });
});
