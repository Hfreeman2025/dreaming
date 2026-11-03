import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuns } from "../src/inbox/store.js";
import { loadState } from "../src/state.js";
import { NOW, hoursAgo, jsonl, touch, userEntry, writeTranscript } from "./helpers/sandbox.js";
import { REPLY, useRunScenario } from "./helpers/run-scenario.js";

describe("dreaming run", () => {
  const t = useRunScenario();

  it("files verified proposals in the inbox and advances the watermark", async () => {
    const outcome = await t.run();
    if (outcome.kind !== "dreamt") throw new Error(`expected a dream, got ${outcome.kind}`);
    const { record } = outcome;

    expect(record.summary).toBe("2 sessions: 1 new preference, 1 outdated deadline.");
    expect(record.sessions.map((s) => [s.ref, s.path, s.firstLine, s.lastLine, s.malformedLines])).toEqual([
      ["S1", t.s1, 1, 2, 0],
      ["S2", t.s2, 1, 2, 1],
    ]);
    expect(record.agent).toMatchObject({ kind: "claude", costUsd: 0.0123, turns: 4 });
    expect(record.agent.command.slice(0, 7)).toEqual([
      t.config.agent.bin,
      "--print",
      "--output-format",
      "json",
      "--restricted",
      "--tools",
      "Read,Glob,Grep",
    ]);

    const [add, update] = record.proposals;
    expect(add).toMatchObject({
      id: `${record.runId}-1`,
      action: "add",
      file: "prefer-pnpm.md",
      status: "pending",
      problems: [],
    });
    expect(add?.evidence.map((e) => [e.status, e.line])).toEqual([["verified", 1]]);
    expect(update).toMatchObject({ action: "update", file: "api-migration.md", name: "api-migration" });
    expect(update?.evidence.map((e) => [e.status, e.line])).toEqual([
      ["verified", 1],
      ["not-found", undefined],
    ]);
    expect(update?.problems).toEqual([]);

    // The inbox holds the JSON record and a Markdown view.
    expect((await loadRuns(t.sandbox.paths.inbox)).map((r) => r.runId)).toEqual([record.runId]);
    const markdown = await readFile(outcome.files.markdown, "utf8");
    expect(markdown).toContain("## 1. add `prefer-pnpm.md` (pending)");
    expect(markdown).toContain("NOT FOUND in the session");
    expect(markdown).toContain("- **Problem:** 1 of 2 evidence quotes could not be found in the cited session");
    expect(markdown).toContain(
      "**S1** · /work/tidepool · session 11111111-aaaa-4aaa-8aaa-111111111111 · line 1 · verified\n\nTranscript text:\n\n```text\nUse pnpm here, npm breaks the workspace links.\n```",
    );

    // The watermark records each session's mtime and line count.
    const state = await loadState(t.sandbox.paths.state);
    expect(state?.sessions[t.s1]).toEqual({ mtimeMs: hoursAgo(10).getTime(), lines: 2, dreamtAt: NOW.toISOString() });
    expect(state?.sessions[t.s2]?.lines).toBe(2);
    expect(state?.lastRun).toEqual({ at: NOW.toISOString(), ok: true, runId: record.runId, message: record.summary });

    // The run workspace (redacted transcript digests) is removed after success.
    expect(await readdir(t.sandbox.paths.runs)).toEqual([]);
  });

  it("gives the agent the digests and the date, and withholds dreaming's own settings", async () => {
    await t.run();
    const call = await t.recordedCall();
    expect(call.digests.S1).toContain(
      "## [1] user · 2026-10-31T10:00:00.000Z\n\nUse pnpm here, npm breaks the workspace links.",
    );
    expect(call.digests.S2).toContain("- Transcript lines: 1-2");
    expect(call.stdin).toContain("Today is 2026-11-01.");
    expect(call.stdin).toMatch(/- S1: `[^`]+\/sessions\/S1\.md` \(\/work\/tidepool, 2 messages/);
    expect(call.stdin).toContain(`Memory directory: \`${t.sandbox.memoryDir}\``);
    expect(call.argv).toContain("--no-session-persistence");
    expect(call.sawWebhookUrl).toBe(false);
    expect(call.sawDreamingHome).toBe(false);
  });

  it("does nothing on a second run with no new activity", async () => {
    await t.run();
    const { rm } = await import("node:fs/promises");
    await rm(t.recordFile);
    const outcome = await t.run();
    expect(outcome.kind).toBe("nothing-new");
    expect(await t.exists(t.recordFile)).toBe(false);
  });

  it("re-reads a transcript from the start when it was rewritten shorter", async () => {
    await t.run();
    await writeFile(t.s1, jsonl([userEntry("A rewritten session with one line.")]));
    await touch(t.s1, hoursAgo(1));
    const outcome = await t.run({ reply: { summary: "Nothing new.", proposals: [] } });
    if (outcome.kind !== "dreamt") throw new Error(outcome.kind);
    expect(outcome.record.sessions.map((s) => [s.path, s.firstLine, s.lastLine])).toEqual([[t.s1, 1, 1]]);
  });

  it("re-reads only the new part of a resumed session", async () => {
    await t.run();
    await appendFile(t.s1, jsonl([userEntry("Also: keep commits small, one concern each.")]));
    await touch(t.s1, hoursAgo(1));
    const outcome = await t.run({ reply: { summary: "Nothing new.", proposals: [] } });
    if (outcome.kind !== "dreamt") throw new Error(outcome.kind);
    expect(outcome.record.sessions.map((s) => [s.path, s.firstLine, s.lastLine, s.messages])).toEqual([
      [t.s1, 3, 3, 1],
    ]);
    const digest = (await t.recordedCall()).digests.S1 ?? "";
    expect(digest).toContain("- Transcript lines: 3-3");
    expect(digest).toContain("dreamt over before; only the messages added since then are shown");
    expect(digest).toContain("Also: keep commits small, one concern each.");
    expect(digest).not.toContain("Use pnpm here");
  });

  it("dry run shows the sessions and command without running the agent or moving the watermark", async () => {
    const outcome = await t.run({ dryRun: true });
    if (outcome.kind !== "dry-run") throw new Error(outcome.kind);
    expect(outcome.digests.map((d) => d.ref)).toEqual(["S1", "S2"]);
    expect(outcome.command.args).toContain("--tools");
    expect(await t.exists(t.recordFile)).toBe(false);
    expect(await loadState(t.sandbox.paths.state)).toBeNull();
    expect(await t.exists(join(outcome.workspace, "prompt.md"))).toBe(true);
  });

  it("never dreams over a session that ran inside the dreaming home", async () => {
    const self = await writeTranscript(
      t.sandbox,
      "-dreaming-runs",
      "33333333-cccc-4ccc-8ccc-333333333333",
      [userEntry("dreaming prompt text", { cwd: join(t.sandbox.paths.runs, "20261101-020000-0000") })],
      hoursAgo(8),
    );
    const outcome = await t.run();
    if (outcome.kind !== "dreamt") throw new Error(outcome.kind);
    expect(outcome.record.sessions.map((s) => s.path)).not.toContain(self);
    expect(outcome.record.skipped).toContainEqual({
      path: self,
      reason: "self",
      detail: "a dreaming agent session; never dreamt over",
    });
    expect((await loadState(t.sandbox.paths.state))?.sessions[self]?.lines).toBe(1);
  });

  it("redacts secrets the agent writes before they reach the inbox", async () => {
    const token = `ghp_${"z".repeat(36)}`;
    const reply = structuredClone(REPLY);
    const first = reply.proposals[0];
    if (first) first.body = `CI token is ${token}`;
    const outcome = await t.run({ reply });
    if (outcome.kind !== "dreamt") throw new Error(outcome.kind);
    expect(await readFile(outcome.files.json, "utf8")).not.toContain(token);
    expect(await readFile(outcome.files.markdown, "utf8")).toContain("CI token is [REDACTED:github-token]");
    // Counted apart from the transcripts' own redactions, so the reviewer is told the agent wrote one.
    expect(outcome.record.replyRedactions).toBe(1);
  });

  it("refuses to start while another run holds the lock", async () => {
    await mkdir(t.sandbox.paths.home, { recursive: true });
    await writeFile(
      t.sandbox.paths.runLock,
      JSON.stringify({ pid: process.pid, purpose: "run", startedAt: "earlier", token: "x" }),
    );
    await expect(t.run()).rejects.toThrow(`another dreaming run is in progress (pid ${process.pid}, started earlier)`);
  });
});
