#!/usr/bin/env node
// Demo stand-in for `claude -p --output-format json`. It does what the real agent is
// asked to do, but with canned judgement: it reads the session digests named in the
// prompt, finds which session each of its quotes came from, and returns proposals.
// One proposal deliberately cites a quote nobody said, to show evidence checking.
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
if (flag("--tools") !== "Read,Glob,Grep" || flag("--permission-mode") !== "dontAsk") {
  process.stderr.write("fake agent: refusing to run without read-only tools\n");
  process.exit(1);
}

const prompt = readFileSync(0, "utf8");
// A real agent takes minutes; the recording waits a few seconds so the progress clock is visible.
const delay = Number(process.env.DEMO_AGENT_DELAY_MS ?? 0);
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
// For recording the error state: answer in prose instead of the JSON contract.
if (process.env.DEMO_AGENT_PROSE) {
  const prose = "I read both sessions. I think pnpm matters here, and the deploy days changed.";
  process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: prose })}\n`);
  process.exit(0);
}
const digests = [...prompt.matchAll(/- (S\d+): `([^`]+)`/g)].map(([, ref, path]) => ({
  ref,
  text: readFileSync(path, "utf8"),
}));
const cite = (quote) => {
  const probe = quote.split("...")[0].trim();
  return { session: digests.find((d) => d.text.includes(probe))?.ref ?? "S1", quote };
};

const proposals = [
  {
    action: "add",
    name: "prefer-pnpm",
    description: "Use pnpm, never npm, in the tidepool repo",
    type: "feedback",
    body: "Use pnpm for installs and scripts in tidepool, never npm.\n\n**Why:** npm install breaks the pnpm workspace links.\n\n**How to apply:** run `pnpm install` / `pnpm <script>`; if a doc says npm, translate it.",
    reason: "Sam corrected the agent after it ran npm install.",
    evidence: [cite("Use pnpm here, not npm. npm install breaks the workspace links in this repo.")],
    confidence: "high",
  },
  {
    action: "update",
    target: "deploy-window.md",
    description: "Production deploys happen on Tuesdays and Thursdays",
    type: "project",
    body: "Production deploys go out on Tuesdays and Thursdays (release train changed the week of 26 October 2026).\n\n**Why:** the on-call rota is staffed for releases on those days.\n\n**How to apply:** do not suggest a production deploy on any other day.",
    reason: "The memory says Tuesdays only; Sam said the release train changed.",
    // Shortened with "...": the reviewer is shown the full transcript text instead.
    evidence: [cite("the release train changed ... We deploy on Tuesdays and Thursdays now.")],
    confidence: "high",
  },
  {
    action: "update",
    target: "api-v2-deadline.md",
    description: "The v2 API is live (since 30 October 2026); /v1 returns 410",
    type: "project",
    body: "The v2 API went live on 30 October 2026. The /v1 endpoints now return 410 and the v1 compatibility tests were removed.\n\n**Why:** the migration finished ahead of the 15 November deadline.\n\n**How to apply:** do not add or keep /v1 compatibility code.",
    reason: "The memory still describes the migration as due.",
    evidence: [cite("The v2 API went live on 30 October; the old /v1 endpoints return 410 now")],
    confidence: "high",
  },
  {
    action: "add",
    name: "staging-smoke-key",
    description: "Staging key for the tidepool smoke test",
    type: "reference",
    // As if the agent had read the raw transcript: dreaming redacts this before filing it.
    body: `Smoke tests use the staging key ${["sk", "ant", "api03", "x".repeat(24)].join("-")} against /v2/tides.`,
    reason: "Sam provided the key for smoke tests.",
    evidence: [cite("For the smoke test, use the staging key")],
    confidence: "medium",
  },
  {
    action: "add",
    name: "prefers-tabs",
    description: "Sam prefers tabs over spaces",
    type: "feedback",
    body: "Indent with tabs.\n\n**Why:** stated preference.\n\n**How to apply:** use tabs in new files.",
    reason: "Inferred from a formatting discussion.",
    evidence: [{ session: "S1", quote: "I always want tabs, never spaces." }],
    confidence: "low",
  },
];

const result = {
  summary: `${digests.length} sessions: 1 new preference, 2 outdated memories, 2 weak proposals.`,
  proposals,
};
process.stdout.write(
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(result),
    num_turns: 6,
    total_cost_usd: 0,
  }) + "\n",
);
