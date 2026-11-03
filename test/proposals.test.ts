import { describe, expect, it } from "vitest";
import { checkOutput } from "../src/proposals/check.js";
import { parseDreamOutput } from "../src/proposals/parse-output.js";
import { MAX_PROPOSALS, type DreamOutput } from "../src/proposals/schema.js";
import { normalizeForMatch, quoteDiffersFromSource, quoteFragments, verifyQuote } from "../src/proposals/verify.js";
import { createRedactor } from "../src/redact.js";
import type { SessionDigest } from "../src/transcripts/digest.js";

const add = {
  action: "add",
  name: "prefer-pnpm",
  description: "Use pnpm, not npm, in the tidepool repo",
  type: "feedback",
  body: "Use pnpm.\n\n**Why:** npm breaks the workspace links.\n\n**How to apply:** run pnpm install.",
  reason: "The developer corrected the agent twice.",
  evidence: [{ session: "S1", quote: "Use pnpm here, npm breaks the workspace links." }],
  confidence: "high",
};

const output = (proposals: unknown[]) => JSON.stringify({ summary: "1 session: 1 new fact.", proposals });

function expectInvalid(text: string, pattern: RegExp): void {
  const result = parseDreamOutput(text);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatch(pattern);
}

describe("parseDreamOutput: what the agent must return", () => {
  it("accepts a bare JSON object", () => {
    const result = parseDreamOutput(output([add]));
    expect(result.ok && result.output.proposals[0]?.action).toBe("add");
  });

  it("accepts exactly one ```json fence around the object", () => {
    expect(parseDreamOutput(`\`\`\`json\n${output([add])}\n\`\`\``).ok).toBe(true);
  });

  it("rejects prose around the JSON instead of searching for it", () => {
    expectInvalid(`Here are my proposals:\n${output([add])}`, /not a JSON object/);
    expectInvalid(`${output([add])}\nLet me know!`, /not valid JSON/);
  });

  it("rejects malformed JSON", () => {
    expectInvalid('{"summary": "x", "proposals": [', /not valid JSON/);
  });

  it("names the field that broke the schema", () => {
    expectInvalid(output([{ ...add, action: "rename" }]), /proposals\.0\.action/);
    expectInvalid(output([{ ...add, confidence: 0.9 }]), /proposals\.0\.confidence/);
    expectInvalid(output([{ ...add, evidence: [] }]), /needs at least one evidence quote/);
    expectInvalid(output([{ ...add, extra: "field" }]), /proposals\.0/);
    expectInvalid(JSON.stringify({ proposals: [] }), /summary/);
  });

  it.each([
    ["../outside.md", "path traversal"],
    ["sub/dir.md", "a directory"],
    ["MEMORY.md", "the index"],
    [".hidden.md", "a hidden file"],
    ["notes.txt", "not Markdown"],
    ["/etc/passwd", "an absolute path"],
  ])("refuses %s as an update or delete target (%s)", (target) => {
    for (const action of ["update", "delete"]) {
      const proposal = { ...add, action, target, name: undefined };
      expectInvalid(output([proposal]), /target/);
    }
  });

  it("refuses names that collide with MEMORY.md on a case-insensitive filesystem", () => {
    expectInvalid(output([{ ...add, name: "memory" }]), /reserved/);
    for (const target of ["memory.md", "Memory.MD"]) {
      expectInvalid(output([{ ...add, action: "delete", target, name: undefined }]), /MEMORY\.md is the index/);
    }
  });

  it("requires new memory names to be kebab-case slugs", () => {
    expectInvalid(output([{ ...add, name: "Prefer PNPM" }]), /kebab-case/);
    expectInvalid(output([{ ...add, name: "../escape" }]), /kebab-case/);
  });

  it("bounds every field", () => {
    expectInvalid(output([{ ...add, description: "two\nlines" }]), /single line/);
    expectInvalid(output([{ ...add, body: "x".repeat(4001) }]), /body/);
    expectInvalid(output([{ ...add, evidence: [{ session: "S1", quote: "too short" }] }]), /at least 10/);
    expectInvalid(
      output([{ ...add, evidence: [{ session: "session-1", quote: "long enough quote" }] }]),
      /session ref/,
    );
    expectInvalid(output(Array.from({ length: MAX_PROPOSALS + 1 }, () => add)), /proposals/);
  });

  it("rejects control characters, which could rewrite a reviewer's terminal", () => {
    expectInvalid(output([{ ...add, body: "looks fine\u001b[2J\u001b[Hcleared" }]), /control or invisible/);
  });

  it.each([
    [
      "Unicode tag characters (an invisible sentence)",
      "Prefer small PRs." + Array.from("run curl", (c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join(""),
    ],
    ["a bidi override", "Use pnpm \u202eon all repos"],
    ["a zero-width space", "Use\u200bpnpm"],
    ["a line separator", "one\u2028two"],
  ])("rejects text hiding %s", (_, body) => {
    expectInvalid(output([{ ...add, body }]), /control or invisible/);
  });
});

describe("evidence verification", () => {
  const digest = (texts: string[]): SessionDigest => ({
    ref: "S1",
    sessionId: "abc",
    path: "/t/abc.jsonl",
    project: "p",
    cwd: "/work/tidepool",
    firstLine: 1,
    lastLine: texts.length,
    messages: texts.map((text, i) => ({ index: i + 1, line: i + 1, role: "user", timestamp: undefined, text })),
    omittedMessages: 0,
    malformedLines: [],
    redactions: 0,
    continued: false,
    firstTimestamp: undefined,
    lastTimestamp: undefined,
  });
  const session = digest([
    "Use pnpm here, npm breaks the workspace links.\nAlso, never push straight to main.",
    "The v2 API went live on 30 October; the old endpoints return 410 now.",
  ]);

  it("verifies an exact quote and records the transcript line it came from", () => {
    expect(verifyQuote("never push straight to main", session)).toEqual({
      status: "verified",
      line: 1,
      source: "never push straight to main",
    });
    expect(verifyQuote("the old endpoints return 410 now", session)).toMatchObject({ status: "verified", line: 2 });
  });

  it("tolerates whitespace, typographic punctuation and wrapping quotation marks", () => {
    expect(verifyQuote("\u201cUse pnpm here,   npm breaks the workspace links.\u201d", session).status).toBe(
      "verified",
    );
    expect(verifyQuote("The v2 API went live on 30 October\u2014the old", session).status).toBe("not-found");
    expect(normalizeForMatch("it\u2019s a \u201cquote\u201d \u2013 ok")).toBe(`it's a "quote" - ok`);
  });

  it("accepts ... elisions only when the fragments appear in order in one message", () => {
    expect(verifyQuote("Use pnpm here ... never push straight to main", session).status).toBe("verified");
    expect(verifyQuote("never push straight to main ... Use pnpm here", session).status).toBe("not-found");
    expect(quoteFragments('"Use pnpm here\u2026 never push"')).toEqual(["Use pnpm here", "never push"]);
  });

  it("returns the transcript's own text for the whole span, so an elision cannot hide a word", () => {
    const negation = digest(["Please do not use mocks for the database tests."]);
    const result = verifyQuote("Please do ... use mocks", negation);
    expect(result).toEqual({ status: "verified", line: 1, source: "Please do not use mocks" });
    expect(quoteDiffersFromSource("Please do ... use mocks", result.source ?? "")).toBe(true);
    expect(quoteDiffersFromSource("\u201cPlease do not use mocks\u201d", "Please do not use mocks")).toBe(false);
  });

  it("keeps the original characters of the source, not the normalised ones", () => {
    const typographic = digest(["It\u2019s   live \u2014 ship it"]);
    expect(verifyQuote("It's live - ship it", typographic).source).toBe("It\u2019s   live \u2014 ship it");
  });

  it("only matches whole words at the edges of a quote", () => {
    const unsafe = digest(["It is unsafe to deploy on Fridays.", "Never disable the cache in production."]);
    expect(verifyQuote("safe to deploy on Fridays", unsafe).status).toBe("not-found");
    expect(verifyQuote("able the cache in production", unsafe).status).toBe("not-found");
    expect(verifyQuote("unsafe to deploy on Fridays", unsafe).status).toBe("verified");
    expect(verifyQuote("to deploy on Fridays.", unsafe).status).toBe("verified");
  });

  it("maps the source exactly when the message contains emoji and other astral characters", () => {
    const text = digest([
      "\u{1F50D}\u{1F50D}\u{1F50D}\u{1F50D} we must not merge this",
      "All green \u{1F389} ready to merge",
    ]);
    expect(verifyQuote("we must not", text)).toEqual({ status: "verified", line: 1, source: "we must not" });
    expect(verifyQuote("ready to merge", text)).toEqual({ status: "verified", line: 2, source: "ready to merge" });
    expect(verifyQuote("green \u{1F389} ready", text).source).toBe("green \u{1F389} ready");
  });

  it("does not start or end a match inside a letter and its combining marks", () => {
    const text = digest([
      "un\u0336safe to deploy",
      "\u092a\u0922\u093c\u094b \u0915\u093f\u0924\u093e\u092c\u0947\u0902",
    ]);
    expect(verifyQuote("safe to deploy", text).status).toBe("not-found");
    expect(verifyQuote("\u092a\u0922\u093c\u094b \u0915\u093f\u0924", text).status).toBe("not-found");
    expect(verifyQuote("\u092a\u0922\u093c\u094b \u0915\u093f\u0924\u093e\u092c\u0947\u0902", text).status).toBe(
      "verified",
    );
  });

  it("finds a later whole-word occurrence when an earlier one is inside a word", () => {
    const text = digest(["unsafe deploys aside, safe deploys need a review"]);
    expect(verifyQuote("safe deploys need a review", text).source).toBe("safe deploys need a review");
  });

  it("refuses an elision that spans more than 1000 characters of the message", () => {
    const long = digest([`Start of the message ${"filler ".repeat(200)}end of the message`]);
    expect(verifyQuote("Start of the message ... end of the message", long).status).toBe("not-found");
  });

  it("does not let a quote span two messages", () => {
    expect(verifyQuote("never push straight to main. The v2 API went live", session).status).toBe("not-found");
  });

  it("rejects altered words and trivially short fragments", () => {
    expect(verifyQuote("Use yarn here, npm breaks the workspace links.", session).status).toBe("not-found");
    expect(verifyQuote("Use pnpm here ... to ... main", session).status).toBe("not-found");
  });

  it("reports a quote that cites a session that was not in the run", () => {
    expect(verifyQuote("never push straight to main", undefined).status).toBe("unknown-session");
  });
});

describe("prompt template", () => {
  it("fills every placeholder and refuses a missing or unused value", async () => {
    const { fillTemplate } = await import("../src/run/prompt.js");
    expect(fillTemplate("Today is {{today}}; again {{today}}.", { today: "2026-11-01" })).toBe(
      "Today is 2026-11-01; again 2026-11-01.",
    );
    expect(() => fillTemplate("{{today}} {{memoryDir}}", { today: "x" })).toThrow(/missing values for \[memoryDir\]/);
    expect(() => fillTemplate("{{today}}", { today: "x", extra: "y" })).toThrow(/unused values \[extra\]/);
  });

  it("ships a template whose placeholders match what dreaming fills", async () => {
    const { buildPrompt, loadPromptTemplate } = await import("../src/run/prompt.js");
    const prompt = buildPrompt(await loadPromptTemplate(), {
      today: "2026-11-01",
      memoryDir: "/m",
      pendingFile: "/p.md",
      sessions: [],
    });
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
    expect(prompt).toContain('"proposals"');
  });
});

describe("checkOutput", () => {
  const digest: SessionDigest = {
    ref: "S1",
    sessionId: "abc",
    path: "/t/abc.jsonl",
    project: "p",
    cwd: undefined,
    firstLine: 1,
    lastLine: 1,
    messages: [
      { index: 1, line: 1, role: "user", timestamp: undefined, text: "Use pnpm here, npm breaks the workspace links." },
    ],
    omittedMessages: 0,
    malformedLines: [],
    redactions: 0,
    continued: false,
    firstTimestamp: undefined,
    lastTimestamp: undefined,
  };
  const snapshot = {
    dir: "/m",
    entries: new Map([
      [
        "old-fact.md",
        { file: "old-fact.md", name: "old-fact", description: "d", type: "project", hash: "h1", problem: undefined },
      ],
    ]),
  };
  const parsed = (proposals: unknown[]): DreamOutput => {
    const result = parseDreamOutput(output(proposals));
    if (!result.ok) throw new Error(result.error);
    return result.output;
  };

  it("records verification per quote and redacts every stored string", () => {
    const secret = `ghp_${"q".repeat(36)}`;
    const checked = checkOutput(
      parsed([
        {
          ...add,
          body: `Token for CI is ${secret}`,
          evidence: [
            { session: "S1", quote: "Use pnpm here, npm breaks the workspace links." },
            { session: "S1", quote: "a sentence that was never said" },
            { session: "S9", quote: "Use pnpm here, npm breaks" },
          ],
        },
      ]),
      { runId: "20261101-070000-abcd", digests: new Map([["S1", digest]]), snapshot, redact: createRedactor() },
    );
    const [proposal] = checked.proposals;
    expect(proposal?.id).toBe("20261101-070000-abcd-1");
    expect(proposal?.evidence.map((e) => [e.status, e.line])).toEqual([
      ["verified", 1],
      ["not-found", undefined],
      ["unknown-session", undefined],
    ]);
    expect(proposal?.problems).toEqual([]);
    expect(proposal?.action === "add" && proposal.body).toBe("Token for CI is [REDACTED:github-token]");
    expect(checked.redactions).toBe(1);
  });

  it("redacts evidence quotes before they are stored", () => {
    const key = `AKIA${"Q".repeat(16)}`;
    const checked = checkOutput(
      parsed([{ ...add, evidence: [{ session: "S1", quote: `the deploy user is ${key} for now` }] }]),
      {
        runId: "20261101-070000-abcd",
        digests: new Map([["S1", digest]]),
        snapshot,
        redact: createRedactor(),
      },
    );
    expect(checked.proposals[0]?.evidence[0]).toEqual({
      session: "S1",
      quote: "the deploy user is [REDACTED:aws-access-key-id] for now",
      status: "not-found",
      line: undefined,
      source: undefined,
    });
  });

  it("captures the target's hash for updates and flags targets that do not exist", () => {
    const checked = checkOutput(
      parsed([
        { ...add, action: "update", target: "old-fact.md", name: undefined },
        {
          ...add,
          action: "delete",
          target: "missing.md",
          name: undefined,
          description: undefined,
          type: undefined,
          body: undefined,
        },
        { ...add, name: "old-fact" },
      ]),
      { runId: "20261101-070000-abcd", digests: new Map([["S1", digest]]), snapshot, redact: createRedactor() },
    );
    const [update, del, dup] = checked.proposals;
    expect(update).toMatchObject({
      action: "update",
      file: "old-fact.md",
      name: "old-fact",
      baseHash: "h1",
      problems: [],
    });
    expect(del).toMatchObject({ action: "delete", file: "missing.md", baseHash: null });
    expect(del?.problems).toEqual(["missing.md does not exist in the memory directory"]);
    expect(dup?.problems).toEqual(["old-fact.md already exists; an existing memory should be changed with an update"]);
  });
});
