import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAdapter, AgentCommand } from "../agent/adapter.js";
import { runProcess, type ProcessResult } from "../agent/process.js";
import type { Config, DreamingPaths } from "../config.js";
import { DreamingError, errorMessage } from "../errors.js";
import { writeFileAtomic } from "../fsx.js";
import { makeRunId } from "../ids.js";
import type { RunRecord, SkippedEntry } from "../inbox/schema.js";
import { loadRuns, pendingProposals, saveRun } from "../inbox/store.js";
import { withLock } from "../lock.js";
import { snapshotMemory } from "../memory/snapshot.js";
import { checkOutput } from "../proposals/check.js";
import { parseDreamOutput } from "../proposals/parse-output.js";
import { createRedactor } from "../redact.js";
import { initialState, loadState, saveState, type LastRun, type State } from "../state.js";
import { renderDigest, type SessionDigest } from "../transcripts/digest.js";
import { discoverTranscripts } from "../transcripts/discover.js";
import { postWebhook, webhookBody, type WebhookFormat } from "../webhook.js";
import { buildPrompt, loadPromptTemplate, renderPending } from "./prompt.js";
import { prepareSessions } from "./sessions.js";

export interface RunContext {
  paths: DreamingPaths;
  config: Config;
  /** Environment for the agent process. */
  env: NodeJS.ProcessEnv;
  webhook: { url: string; format: WebhookFormat } | undefined;
  adapter: AgentAdapter;
  now: () => Date;
  /** Progress, for the person watching (or the scheduler log). */
  onEvent: (event: RunEvent) => void;
}

export interface RunOptions {
  dryRun: boolean;
  maxSessions: number | undefined;
}

/** What a run is doing, in order, for a progress display. */
export type RunEvent =
  | { kind: "read"; sessions: number; skipped: SkippedEntry[]; messages: number; omitted: number; redactions: number }
  | { kind: "agent-started"; agent: string; startedAt: number }
  | { kind: "agent-finished"; durationMs: number; ok: boolean };

export type WebhookOutcome = { kind: "off" } | { kind: "sent" } | { kind: "failed"; message: string };

export type RunOutcome =
  | { kind: "nothing-new"; skipped: SkippedEntry[] }
  | { kind: "dry-run"; digests: SessionDigest[]; skipped: SkippedEntry[]; command: AgentCommand; workspace: string }
  | { kind: "dreamt"; record: RunRecord; files: { json: string; markdown: string }; webhook: WebhookOutcome };

function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The agent gets the caller's environment minus dreaming's own settings (the webhook URL is a secret). */
export function agentEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("DREAMING_")));
}

function describeProcessFailure(result: ProcessResult, timeoutSeconds: number): string | null {
  if (result.interrupted !== null) return `the run was stopped by ${result.interrupted}`;
  if (result.timedOut) {
    return `the agent did not finish within ${timeoutSeconds} second${timeoutSeconds === 1 ? "" : "s"} and was stopped`;
  }
  if (result.outputLimitExceeded) return "the agent's output exceeded agent.maxOutputBytes and it was stopped";
  if (result.exitCode !== 0) {
    const how = result.signal ? `was killed by ${result.signal}` : `exited with code ${String(result.exitCode)}`;
    const tail = result.stderr.trim().split("\n").slice(-5).join("\n    ");
    return `the agent ${how}${tail ? `:\n    ${tail}` : ""}`;
  }
  return null;
}

export async function dream(ctx: RunContext, options: RunOptions): Promise<RunOutcome> {
  await mkdir(ctx.paths.home, { recursive: true, mode: 0o700 });
  return withLock(ctx.paths.runLock, "run", () => dreamLocked(ctx, options));
}

async function dreamLocked(ctx: RunContext, options: RunOptions): Promise<RunOutcome> {
  const { config, paths } = ctx;
  const now = ctx.now();
  const state: State = (await loadState(paths.state)) ?? initialState(now.getTime(), config.transcripts.lookbackDays);
  const recordLastRun = async (lastRun: LastRun, marks: State["sessions"] = {}) => {
    if (options.dryRun) return;
    await saveState(paths.state, { ...state, sessions: { ...state.sessions, ...marks }, lastRun });
  };

  const discovery = await discoverTranscripts({
    root: config.transcripts.root,
    state,
    nowMs: now.getTime(),
    settleMinutes: config.transcripts.settleMinutes,
    maxSessions: options.maxSessions ?? config.transcripts.maxSessions,
    maxTranscriptBytes: config.transcripts.maxTranscriptBytes,
  });
  const redact = createRedactor(config.redaction.extraPatterns);
  const prepared = await prepareSessions(discovery.selected, {
    dreamingHome: paths.home,
    maxChars: config.transcripts.maxSessionChars,
    redact,
    nowIso: now.toISOString(),
  });
  const skipped = [...discovery.skipped, ...prepared.skipped];
  ctx.onEvent({
    kind: "read",
    sessions: prepared.digests.length,
    skipped,
    messages: prepared.digests.reduce((sum, d) => sum + d.messages.length, 0),
    omitted: prepared.digests.reduce((sum, d) => sum + d.omittedMessages, 0),
    redactions: prepared.digests.reduce((sum, d) => sum + d.redactions, 0),
  });

  if (prepared.digests.length === 0) {
    await recordLastRun({ at: now.toISOString(), ok: true, message: "no new sessions" }, prepared.marks);
    return { kind: "nothing-new", skipped };
  }

  const snapshot = await snapshotMemory(config.memoryDir);
  const pending = pendingProposals(await loadRuns(paths.inbox));
  const runId = makeRunId(now);
  const workspace = join(paths.runs, runId);
  await mkdir(join(workspace, "sessions"), { recursive: true, mode: 0o700 });

  const sessions = [];
  for (const digest of prepared.digests) {
    const file = join(workspace, "sessions", `${digest.ref}.md`);
    await writeFileAtomic(file, renderDigest(digest));
    sessions.push({ digest, file });
  }
  const pendingFile = join(workspace, "pending.md");
  await writeFileAtomic(pendingFile, renderPending(pending));
  const prompt = buildPrompt(await loadPromptTemplate(), {
    today: localDate(now),
    memoryDir: config.memoryDir,
    pendingFile,
    sessions,
  });
  await writeFileAtomic(join(workspace, "prompt.md"), prompt);

  const command = ctx.adapter.buildCommand({
    prompt,
    workspaceDir: workspace,
    readableDirs: [workspace, config.memoryDir],
    model: config.agent.model,
    maxBudgetUsd: config.agent.maxBudgetUsd,
  });
  if (options.dryRun) {
    return { kind: "dry-run", digests: prepared.digests, skipped, command, workspace };
  }

  const startedAt = Date.now();
  ctx.onEvent({ kind: "agent-started", agent: ctx.adapter.kind, startedAt });
  // Failure messages can quote the agent's output, so they are redacted like everything else.
  const fail = async (message: string): Promise<never> => {
    const safe = redact(message).text;
    await recordLastRun({ at: now.toISOString(), ok: false, runId, message: safe });
    throw new DreamingError(safe, {
      hint: `Nothing was added to the inbox and the watermark did not move.\nThe agent's output (redacted) and the prompt are in ${workspace}`,
    });
  };

  const result = await runProcess(command, agentEnvironment(ctx.env), {
    timeoutMs: config.agent.timeoutSeconds * 1000,
    maxOutputBytes: config.agent.maxOutputBytes,
  }).catch((error: unknown) => fail(errorMessage(error)));
  ctx.onEvent({
    kind: "agent-finished",
    durationMs: Date.now() - startedAt,
    ok: result.exitCode === 0 && !result.timedOut,
  });
  // Keep the agent's output before anything else can fail, so a paid reply is never lost.
  await writeFileAtomic(join(workspace, "agent-stdout.txt"), redact(result.stdout).text);
  await writeFileAtomic(join(workspace, "agent-stderr.txt"), redact(result.stderr).text);
  const processFailure = describeProcessFailure(result, config.agent.timeoutSeconds);
  if (processFailure !== null) return fail(processFailure);

  let replyText: string;
  let costUsd: number | undefined;
  let turns: number | undefined;
  try {
    const reply = ctx.adapter.parseReply(result.stdout);
    ({ text: replyText, costUsd, turns } = reply);
  } catch (error) {
    if (!(error instanceof DreamingError)) throw error;
    return fail(error.message);
  }
  const parsed = parseDreamOutput(replyText);
  if (!parsed.ok) return fail(`agent output failed validation: ${parsed.error}`);

  const checked = checkOutput(parsed.output, {
    runId,
    digests: new Map(prepared.digests.map((digest) => [digest.ref, digest])),
    snapshot,
    redact,
  });
  const record: RunRecord = {
    schemaVersion: 1,
    runId,
    createdAt: now.toISOString(),
    memoryDir: config.memoryDir,
    agent: {
      kind: ctx.adapter.kind,
      command: [command.bin, ...command.args],
      durationMs: result.durationMs,
      costUsd,
      turns,
    },
    summary: checked.summary,
    sessions: prepared.digests.map((d) => ({
      ref: d.ref,
      sessionId: d.sessionId,
      path: d.path,
      project: d.project,
      cwd: d.cwd,
      firstLine: d.firstLine,
      lastLine: d.lastLine,
      messages: d.messages.length,
      omittedMessages: d.omittedMessages,
      malformedLines: d.malformedLines.length,
      firstTimestamp: d.firstTimestamp,
      lastTimestamp: d.lastTimestamp,
    })),
    skipped,
    redactions: checked.redactions + prepared.digests.reduce((sum, d) => sum + d.redactions, 0),
    replyRedactions: checked.redactions,
    proposals: checked.proposals,
  };
  const files = await saveRun(paths.inbox, record);
  // The watermark moves only after the proposals are safely in the inbox.
  await recordLastRun({ at: now.toISOString(), ok: true, runId, message: checked.summary }, prepared.marks);
  // Digests are redacted copies of transcripts; do not keep them after a successful run.
  await rm(workspace, { recursive: true, force: true });

  let webhook: WebhookOutcome = { kind: "off" };
  if (ctx.webhook !== undefined) {
    try {
      await postWebhook(ctx.webhook.url, webhookBody(record, ctx.webhook.format));
      webhook = { kind: "sent" };
    } catch (error) {
      if (!(error instanceof DreamingError)) throw error;
      webhook = { kind: "failed", message: error.message };
    }
  }
  return { kind: "dreamt", record, files, webhook };
}
