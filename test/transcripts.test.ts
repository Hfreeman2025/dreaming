import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRedactor } from "../src/redact.js";
import { initialState, type State } from "../src/state.js";
import { buildDigest, fitToBudget, renderDigest, truncateMessage } from "../src/transcripts/digest.js";
import { discoverTranscripts } from "../src/transcripts/discover.js";
import { parseTranscript } from "../src/transcripts/parse.js";
import {
  NOW,
  assistantEntry,
  hoursAgo,
  jsonl,
  makeSandbox,
  minutesAgo,
  text,
  userEntry,
  writeTranscript,
  type Sandbox,
} from "./helpers/sandbox.js";

describe("parseTranscript", () => {
  it("extracts user and assistant text with line numbers and timestamps", () => {
    const parsed = parseTranscript(
      jsonl([
        { type: "summary", summary: "ignored" },
        userEntry("Use pnpm here, npm breaks the workspace links."),
        assistantEntry([
          text("Switching to pnpm."),
          { type: "tool_use", name: "Bash", input: { command: "pnpm install" } },
        ]),
      ]),
    );
    expect(parsed.totalLines).toBe(3);
    expect(parsed.malformedLines).toEqual([]);
    expect(parsed.cwd).toBe("/work/tidepool");
    expect(parsed.messages).toEqual([
      {
        line: 2,
        role: "user",
        timestamp: "2026-10-31T10:00:00.000Z",
        text: "Use pnpm here, npm breaks the workspace links.",
      },
      {
        line: 3,
        role: "assistant",
        timestamp: "2026-10-31T10:01:00.000Z",
        text: "Switching to pnpm.\n[tool: Bash] pnpm install",
      },
    ]);
  });

  it("counts malformed lines instead of dropping them silently", () => {
    const parsed = parseTranscript(
      jsonl([
        userEntry("first message, fine"),
        "{not json",
        JSON.stringify({ no: "type field" }),
        JSON.stringify({ type: "user", message: { content: 42 } }),
        JSON.stringify([1, 2, 3]),
        assistantEntry([text("still parsed after the bad lines")]),
      ]),
    );
    expect(parsed.malformedLines).toEqual([2, 3, 4, 5]);
    expect(parsed.messages.map((m) => m.text)).toEqual(["first message, fine", "still parsed after the bad lines"]);
  });

  it("does not count a line that is still being written, so it is read once complete", () => {
    const complete = JSON.stringify(userEntry("first message, complete"));
    const partial = JSON.stringify(userEntry("second message, still being wri")).slice(0, 60);
    const parsed = parseTranscript(`${complete}\n${partial}`);
    expect(parsed.totalLines).toBe(1);
    expect(parsed.malformedLines).toEqual([]);
    expect(parsed.messages.map((m) => m.text)).toEqual(["first message, complete"]);
  });

  it("counts a complete last line even without a trailing newline", () => {
    const content = `${JSON.stringify(userEntry("one"))}\n${JSON.stringify(userEntry("two"))}`;
    expect(parseTranscript(content).totalLines).toBe(2);
  });

  it("skips meta and sidechain entries, tool results and thinking", () => {
    const parsed = parseTranscript(
      jsonl([
        userEntry("<local-command-caveat>internal</local-command-caveat>", { isMeta: true }),
        assistantEntry([text("subagent chatter")], { isSidechain: true }),
        userEntry("", {
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "huge output" }] },
        }),
        assistantEntry([{ type: "thinking", thinking: "private reasoning" }, text("visible answer")]),
      ]),
    );
    expect(parsed.messages.map((m) => m.text)).toEqual(["visible answer"]);
  });

  it("removes injected system reminders so memory cannot cite itself", () => {
    const parsed = parseTranscript(
      jsonl([
        userEntry("<system-reminder>Memory: prefers yarn</system-reminder>\nActually we moved to pnpm last week."),
      ]),
    );
    expect(parsed.messages[0]?.text).toBe("Actually we moved to pnpm last week.");
  });

  it("strips terminal escape sequences and control characters", () => {
    const parsed = parseTranscript(jsonl([userEntry("red \u001b[31mtext\u001b[0m and a bell\u0007\r\nnext line")]));
    expect(parsed.messages[0]?.text).toBe("red text and a bell\nnext line");
  });

  it("parses only lines after fromLine but keeps the session's cwd", () => {
    const content = jsonl([
      userEntry("old message", { cwd: "/work/old" }),
      userEntry("new message", { cwd: undefined }),
    ]);
    const parsed = parseTranscript(content, 1);
    expect(parsed.messages.map((m) => m.text)).toEqual(["new message"]);
    expect(parsed.cwd).toBe("/work/old");
    expect(parsed.totalLines).toBe(2);
  });

  it("summarises tool calls on one line and caps their length", () => {
    const parsed = parseTranscript(
      jsonl([
        assistantEntry([{ type: "tool_use", name: "Bash", input: { command: `echo ${"a".repeat(300)}\nrm -rf x` } }]),
      ]),
    );
    const line = parsed.messages[0]?.text ?? "";
    expect(line.startsWith("[tool: Bash] echo aaa")).toBe(true);
    expect(line).not.toContain("\n");
    expect(line.length).toBe("[tool: Bash] ".length + 160 + 3);
  });
});

describe("discoverTranscripts", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  const options = (state: State, overrides: Partial<Parameters<typeof discoverTranscripts>[0]> = {}) => ({
    root: sandbox.projectsDir,
    state,
    nowMs: NOW.getTime(),
    settleMinutes: 5,
    maxSessions: 20,
    maxTranscriptBytes: 1_000_000,
    ...overrides,
  });

  it("on a cold start, reads only the lookback window", async () => {
    const recent = await writeTranscript(sandbox, "p", "recent", [userEntry("hello there")], hoursAgo(20));
    await writeTranscript(sandbox, "p", "old", [userEntry("hello there")], hoursAgo(72));
    const result = await discoverTranscripts(options(initialState(NOW.getTime(), 2)));
    expect(result.selected.map((s) => s.path)).toEqual([recent]);
    expect(result.skipped).toEqual([]);
  });

  it("skips sessions active within the settle window and reports them", async () => {
    const live = await writeTranscript(sandbox, "p", "live", [userEntry("still typing")], minutesAgo(2));
    const settled = await writeTranscript(sandbox, "p", "settled", [userEntry("done for today")], minutesAgo(30));
    const result = await discoverTranscripts(options(initialState(NOW.getTime(), 2)));
    expect(result.selected.map((s) => s.path)).toEqual([settled]);
    expect(result.skipped).toEqual([
      { path: live, reason: "active", detail: "modified in the last 5 minutes; will be read once it settles" },
    ]);
  });

  it("uses each session's own watermark: unchanged sessions are not re-read, grown ones resume", async () => {
    const unchanged = await writeTranscript(sandbox, "p", "a", [userEntry("one")], hoursAgo(10));
    const grown = await writeTranscript(sandbox, "p", "b", [userEntry("one"), userEntry("two")], hoursAgo(1));
    const state: State = {
      ...initialState(NOW.getTime(), 2),
      sessions: {
        [unchanged]: { mtimeMs: hoursAgo(10).getTime(), lines: 1, dreamtAt: "x" },
        [grown]: { mtimeMs: hoursAgo(5).getTime(), lines: 1, dreamtAt: "x" },
      },
    };
    const result = await discoverTranscripts(options(state));
    expect(result.selected.map((s) => [s.path, s.fromLine])).toEqual([[grown, 1]]);
  });

  it("does not lose a session that was active during the previous run", async () => {
    // Previous run at NOW-24h saw this file live; it has not changed since.
    const path = await writeTranscript(sandbox, "p", "late", [userEntry("wrapped up")], hoursAgo(24));
    const state = initialState(hoursAgo(24).getTime(), 2);
    const result = await discoverTranscripts(options(state));
    expect(result.selected.map((s) => s.path)).toEqual([path]);
  });

  it("caps a run at maxSessions, oldest first, and defers the rest", async () => {
    const oldest = await writeTranscript(sandbox, "p", "s1", [userEntry("a")], hoursAgo(9));
    const middle = await writeTranscript(sandbox, "q", "s2", [userEntry("b")], hoursAgo(8));
    const newest = await writeTranscript(sandbox, "p", "s3", [userEntry("c")], hoursAgo(7));
    const result = await discoverTranscripts(options(initialState(NOW.getTime(), 2), { maxSessions: 2 }));
    expect(result.selected.map((s) => s.path)).toEqual([oldest, middle]);
    expect(result.skipped.map((s) => [s.path, s.reason])).toEqual([[newest, "deferred"]]);
  });

  it("refuses transcripts over the size limit, with the reason", async () => {
    const big = await writeTranscript(sandbox, "p", "big", [userEntry("x".repeat(2000))], hoursAgo(3));
    const result = await discoverTranscripts(options(initialState(NOW.getTime(), 2), { maxTranscriptBytes: 1024 }));
    expect(result.selected).toEqual([]);
    expect(result.skipped[0]?.path).toBe(big);
    expect(result.skipped[0]?.reason).toBe("too-large");
  });

  it("ignores files that are not top-level .jsonl transcripts", async () => {
    await writeTranscript(sandbox, "p", "real", [userEntry("a")], hoursAgo(3));
    await writeTranscript(sandbox, "p/real/subagents", "agent-1", [userEntry("b")], hoursAgo(3));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${sandbox.projectsDir}/p/notes.txt`, "not a transcript");
    const result = await discoverTranscripts(options(initialState(NOW.getTime(), 2)));
    expect(result.selected.map((s) => s.sessionId)).toEqual(["real"]);
  });

  it("errors clearly when the transcripts root does not exist", async () => {
    await expect(
      discoverTranscripts(options(initialState(NOW.getTime(), 2), { root: `${sandbox.root}/missing` })),
    ).rejects.toThrow(/transcripts directory not found/);
  });
});

describe("digests", () => {
  const messages = (lengths: number[]) => lengths.map((n, i) => ({ id: i + 1, text: "m".repeat(n) }));

  it("keeps everything that fits the budget", () => {
    expect(fitToBudget(messages([10, 10, 10]), 30)).toEqual({ kept: messages([10, 10, 10]), omitted: 0 });
  });

  it("keeps the start (30% of the budget) and the most recent messages, dropping the middle", () => {
    const { kept, omitted } = fitToBudget(messages([20, 20, 20, 20, 20, 20, 20, 20, 20, 20]), 100);
    // Head: message 1 (20 of the 30-char head share). Tail: 10, 9, 8, 7 fill the remaining 80.
    expect(kept.map((m) => m.id)).toEqual([1, 7, 8, 9, 10]);
    expect(omitted).toBe(5);
  });

  it("truncates a long message and says how much was cut", () => {
    expect(truncateMessage("abcdefghij", 4)).toBe("abcd\n[... 6 more characters truncated]");
  });

  it("redacts before the agent sees anything, and marks omitted messages", () => {
    const parsed = parseTranscript(
      jsonl([
        userEntry(`deploy key is ghp_${"a".repeat(36)}`),
        ...Array.from({ length: 8 }, (_, i) => userEntry(`filler ${i} ${"x".repeat(3000)}`)),
        userEntry("final decision: ship on Friday"),
      ]),
    );
    const digest = buildDigest(
      "S1",
      { path: "/t/p/abc.jsonl", project: "p", sessionId: "abc", mtimeMs: 0, size: 0, fromLine: 0 },
      parsed,
      { maxChars: 20_000, redact: createRedactor() },
    );
    expect(digest.messages[0]?.text).toBe("deploy key is [REDACTED:github-token]");
    expect(digest.redactions).toBe(1);
    expect(digest.omittedMessages).toBeGreaterThan(0);
    expect(digest.messages.at(-1)?.text).toBe("final decision: ship on Friday");
    const rendered = renderDigest(digest);
    expect(rendered).toContain(`[... ${digest.omittedMessages} messages omitted ...]`);
    expect(rendered).toContain("- Transcript lines: 1-10");
  });
});

describe("softWrap", () => {
  it("breaks long lines at spaces only, so a file reader sees every word", async () => {
    const { softWrap } = await import("../src/transcripts/digest.js");
    expect(softWrap("aaaa bbbb cccc dddd", 10)).toBe("aaaa bbbb\ncccc dddd");
    expect(softWrap("short\nlines stay", 10)).toBe("short\nlines stay");
    expect(softWrap("x".repeat(25), 10)).toBe("x".repeat(25));
  });

  it("does not change which quotes verify", async () => {
    const { softWrap } = await import("../src/transcripts/digest.js");
    const { normalizeForMatch } = await import("../src/proposals/verify.js");
    const text = "The release train changed this week, so we deploy on Tuesdays and Thursdays now.";
    expect(normalizeForMatch(softWrap(text, 20))).toBe(normalizeForMatch(text));
  });
});
