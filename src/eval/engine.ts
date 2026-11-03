import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import type { AgentCommand } from "../agent/adapter.js";
import { runProcess, type ProcessLimits, type ProcessResult } from "../agent/process.js";
import { DreamingError, errorMessage } from "../errors.js";
import { readTextIfExists } from "../fsx.js";
import { makeRunId } from "../ids.js";
import type { PendingProposal } from "../inbox/store.js";
import { memoryArms, memoryPrompt } from "./arms.js";
import { evalArgs, evalCommand, evalEnv, firedCanaries, runControl, type ControlResult } from "./isolation.js";
import { startAudit, type ProcessAudit } from "./procwatch.js";
import type { EvalRecord, EvalRun } from "./record.js";
import { prepareSlot, type Slot } from "./sandbox.js";
import { PACKAGE_MANAGER, parseStream, registryHookCount } from "./stream.js";
import { shuffled } from "./stats.js";
import type { Suite, Task } from "./suite.js";

/** The most runs one eval may make, both arms together. */
export const MAX_RUNS = 30;

export type EvalEvent =
  | { kind: "control"; control: ControlResult }
  | { kind: "planned"; runs: { index: number; arm: EvalRun["arm"]; task: string; rep: number }[] }
  | { kind: "started"; index: number; slot: number; at: number }
  | { kind: "finished"; run: EvalRun }
  | { kind: "stopping"; ended: EvalRecord["ended"]; because: string };

export interface EvalRequest {
  proposal: PendingProposal;
  suite: Suite;
  memoryDir: string;
  /** Both arms together; at most MAX_RUNS. Split evenly across tasks and arms. */
  runs: number;
  tasks: readonly string[] | undefined;
  model: string | undefined;
  parallel: number;
  seed: number;
  bin: string;
  home: string;
  user: string;
  keep: boolean;
}

export interface EvalDeps {
  now: () => Date;
  onEvent: (event: EvalEvent) => void;
  /** Where Ctrl-C comes from; injectable for tests. */
  signals?: EventEmitter;
  runAgent?: (command: AgentCommand, env: NodeJS.ProcessEnv, limits: ProcessLimits) => Promise<ProcessResult>;
  control?: (bin: string, dir: string, who: { home: string; user: string }, nodePath: string) => Promise<ControlResult>;
  audit?: () => ProcessAudit;
  tmpRoot?: () => Promise<string>;
  version?: (bin: string) => Promise<string | null>;
  bashrcExists?: () => Promise<boolean>;
  nodePath?: string;
}

/** Run a check script: exit 0 is a pass, the first line of its output is the reason. */
function runCheck(task: Task, slot: Slot, nodePath: string): Promise<{ passed: boolean; reason: string }> {
  return new Promise((resolve) => {
    const child = spawn(nodePath, [task.checkPath], {
      cwd: slot.repo,
      env: {
        PATH: `${slot.bin}:/usr/bin:/bin`,
        EVAL_REPO: slot.repo,
        EVAL_LOG: slot.shimLog,
        EVAL_ANSWER: slot.answer,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const reason =
        out
          .split("\n")
          .find((line) => line.trim() !== "")
          ?.trim() ?? "(the check printed nothing)";
      resolve({ passed: code === 0, reason: reason.slice(0, 200) });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ passed: false, reason: `the check could not run: ${errorMessage(error)}` });
    });
  });
}

async function cliVersion(bin: string): Promise<string | null> {
  const result = await runProcess(
    { bin, args: ["--version"], cwd: "/", stdin: "" },
    { PATH: "/usr/bin:/bin" },
    {
      timeoutMs: 15_000,
      maxOutputBytes: 10_000,
    },
  );
  return result.exitCode === 0 ? (result.stdout.trim().split("\n")[0] ?? null) : null;
}

export async function runEval(request: EvalRequest, deps: EvalDeps): Promise<EvalRecord> {
  const { suite, proposal } = request;
  const chosen = request.tasks === undefined ? suite.tasks : suite.tasks.filter((t) => request.tasks?.includes(t.id));
  const unknown = (request.tasks ?? []).filter((id) => !suite.tasks.some((t) => t.id === id));
  if (unknown.length > 0) throw new DreamingError(`no task called ${unknown.join(", ")} in suite ${suite.name}`);
  if (request.runs > MAX_RUNS)
    throw new DreamingError(`an eval makes at most ${MAX_RUNS} runs; asked for ${request.runs}`);
  const reps = Math.floor(request.runs / (2 * chosen.length));
  if (reps < 1) {
    throw new DreamingError(`${request.runs} runs is too few for ${chosen.length} tasks in two arms`, {
      hint: `Use at least ${2 * chosen.length} runs, or fewer tasks with --tasks.`,
    });
  }

  const arms = await memoryArms(request.memoryDir, { runId: proposal.run.runId, proposal: proposal.proposal });
  const memoryText = { without: memoryPrompt(arms.without), with: memoryPrompt(arms.with) };

  const root = await (deps.tmpRoot ?? (() => mkdtemp(join(tmpdir(), "dreaming-eval-"))))();
  const rel = relative(request.home, root);
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    throw new DreamingError(`eval sandboxes must be outside the home directory; ${root} is inside it`, {
      hint: "Set TMPDIR to a directory outside your home directory.",
    });
  }

  const started = deps.now();
  const evalId = makeRunId(started);
  const nodePath = deps.nodePath ?? process.execPath;
  const runAgent = deps.runAgent ?? runProcess;
  const signals: EventEmitter = deps.signals ?? process;
  const record: EvalRecord = {
    schemaVersion: 1,
    evalId,
    createdAt: started.toISOString(),
    finishedAt: null,
    ended: "completed",
    endedBecause: null,
    proposal: {
      runId: proposal.run.runId,
      id: proposal.proposal.id,
      action: proposal.proposal.action,
      file: proposal.proposal.file,
      description: "description" in proposal.proposal ? proposal.proposal.description : "",
    },
    memoryDir: request.memoryDir,
    suite: {
      name: suite.name,
      about: suite.about,
      tasks: chosen.map((t) => ({ id: t.id, prompt: t.prompt, passMeans: t.passMeans })),
    },
    plan: { runs: reps * 2 * chosen.length, reps, seed: request.seed, parallel: request.parallel },
    agent: {
      bin: request.bin,
      version: await (deps.version ?? cliVersion)(request.bin),
      model: request.model ?? null,
      argv: evalArgs({
        bin: request.bin,
        cwd: "<slot>/repo",
        prompt: "",
        settingsPath: "<slot>/settings.json",
        debugFile: "<slot>/debug.log",
        maxTurns: chosen[0]?.maxTurns ?? 20,
        model: request.model,
        memoryFile: "<slot>/memory.md",
      }),
    },
    isolation: {
      control: { ok: false, hookEvents: 0, canaries: [], detail: "not run" },
      workDir: root,
      bashrc: await (
        deps.bashrcExists ?? (async () => (await readTextIfExists(join(request.home, ".bashrc"))) !== null)
      )(),
      audit: { samples: 0, seen: [], soundPlayers: [] },
    },
    runs: [],
  };

  const status: { stopping: { ended: EvalRecord["ended"]; because: string } | null } = { stopping: null };
  const stop = (ended: EvalRecord["ended"], because: string) => {
    if (status.stopping !== null) return;
    status.stopping = { ended, because };
    deps.onEvent({ kind: "stopping", ended, because });
  };
  const onSignal = () => {
    stop("interrupted", "stopped by Ctrl-C; the finished runs are kept");
  };
  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);
  const audit = (deps.audit ?? startAudit)();

  try {
    // 1. Prove the hook detector works before trusting its silence.
    const control = await (deps.control ?? runControl)(
      request.bin,
      join(root, "control"),
      { home: request.home, user: request.user },
      nodePath,
    );
    record.isolation.control = {
      ok: control.ok,
      hookEvents: control.hookEvents,
      canaries: control.canaries,
      detail: control.detail,
    };
    deps.onEvent({ kind: "control", control });
    if (!control.ok) {
      throw new DreamingError(
        `the hook detector could not be checked, so isolation cannot be proved: ${control.detail}`,
        {
          hint: "No eval run was started. Check that the claude CLI supports --include-hook-events.",
        },
      );
    }

    // 2. Plan: every task, `reps` times, in both arms, in a seeded random order.
    const plan = shuffled(
      chosen.flatMap((task) =>
        (["without", "with"] as const).flatMap((arm) =>
          Array.from({ length: reps }, (_, rep) => ({ arm, task: task.id, rep })),
        ),
      ),
      request.seed,
    ).map((run, index) => ({ ...run, index }));
    deps.onEvent({ kind: "planned", runs: plan });

    // 3. Run, `parallel` at a time, each in its own slot.
    const queue = [...plan];
    const worker = async (slotIndex: number) => {
      for (;;) {
        if (status.stopping !== null) return;
        const next = queue.shift();
        if (next === undefined) return;
        const task = chosen.find((t) => t.id === next.task);
        if (task === undefined) return;
        const slot = await prepareSlot(join(root, `slot-${slotIndex + 1}`), suite, nodePath);
        const at = Date.now() - started.getTime();
        deps.onEvent({ kind: "started", index: next.index, slot: slotIndex, at });
        const text = memoryText[next.arm];
        if (text !== "") await writeFile(slot.memory, text, { mode: 0o600 });
        const command = evalCommand({
          bin: request.bin,
          cwd: slot.repo,
          prompt: task.prompt,
          settingsPath: slot.settings,
          debugFile: slot.debug,
          maxTurns: task.maxTurns,
          model: request.model,
          memoryFile: text === "" ? undefined : slot.memory,
        });
        const env = evalEnv({
          binDir: slot.bin,
          home: request.home,
          user: request.user,
          tmpDir: slot.tmp,
          extra: { EVAL_REPO: slot.repo },
        });
        let agentPid: number | undefined;
        const result = await runAgent(command, env, {
          timeoutMs: task.timeoutSeconds * 1000,
          maxOutputBytes: 20_000_000,
          signals,
          onSpawn: (pid) => {
            agentPid = pid;
            audit.track(pid, next.index);
          },
        });
        if (agentPid !== undefined) audit.untrack(agentPid);
        await writeFile(slot.stream, result.stdout);
        const telemetry = parseStream(result.stdout);
        const debugLog = (await readTextIfExists(slot.debug)) ?? "";
        const canaries = await firedCanaries(slot.canary);
        const registryHooks = registryHookCount(debugLog);
        await writeFile(slot.answer, telemetry.result?.answer ?? "");
        // The sandbox holds only if the agent's package-manager commands reached the suite's shims.
        const packageCommands = telemetry.bashCommands.filter((c) => PACKAGE_MANAGER.test(c)).length;
        const shimCalls = ((await readTextIfExists(slot.shimLog)) ?? "")
          .split("\n")
          .filter((l) => l.trim() !== "").length;
        const bypassed = suite.shimsDir !== undefined && packageCommands > 0 && shimCalls === 0;

        // Stopped part-way by Ctrl-C: not a result either way.
        if (result.interrupted !== null) return;
        // The agent could not run at all (no login, an API error): not the memory's doing, so not
        // counted. Running out of time or turns is the task going badly, so those are checked.
        const couldNotRun =
          !result.timedOut &&
          (telemetry.result === undefined ||
            (telemetry.result.isError && telemetry.result.subtype !== "error_max_turns"));
        let outcome: EvalRun["outcome"];
        let reason: string;
        if (bypassed) {
          outcome = "error";
          reason = `${String(packageCommands)} package-manager commands ran, but none reached the sandbox's shims`;
        } else if (couldNotRun) {
          outcome = "error";
          const said = telemetry.result?.answer.trim() ?? "";
          reason =
            (said !== "" ? said : (result.stderr.trim().split("\n")[0] ?? "")) ||
            `the agent exited with ${String(result.exitCode)}`;
          reason = reason.slice(0, 160);
        } else {
          const check = await runCheck(task, slot, nodePath);
          outcome = check.passed ? "pass" : "fail";
          reason = result.timedOut ? `timed out after ${String(task.timeoutSeconds)} s; ${check.reason}` : check.reason;
        }
        const run: EvalRun = {
          index: next.index,
          arm: next.arm,
          task: next.task,
          rep: next.rep,
          startedMs: at,
          wallMs: result.durationMs,
          outcome,
          reason,
          agent: {
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            subtype: telemetry.result?.subtype ?? null,
            model: telemetry.model ?? null,
            turns: telemetry.result?.turns ?? 0,
            durationMs: telemetry.result?.durationMs ?? 0,
            costUsd: telemetry.result?.costUsd ?? 0,
            usage: telemetry.result?.usage ?? { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 },
            toolCalls: telemetry.toolCalls,
          },
          isolation: { hookEvents: telemetry.hookEvents.length, canaries, registryHooks, packageCommands, shimCalls },
        };
        record.runs.push(run);
        deps.onEvent({ kind: "finished", run });
        if (run.isolation.hookEvents > 0 || canaries.length > 0 || (registryHooks ?? 0) > 0) {
          stop(
            "isolation",
            `run ${next.index + 1} reported a hook (${String(run.isolation.hookEvents)} hook event${run.isolation.hookEvents === 1 ? "" : "s"}, canary: ${canaries.join(", ") || "none"}); the eval stopped`,
          );
        }
        if (bypassed) {
          stop(
            "error",
            `run ${String(next.index + 1)} used real package-manager tools instead of the sandbox's shims; the eval stopped`,
          );
        }
        if (outcome === "error" && /not logged in|please run \/login/i.test(reason)) {
          stop("error", "Claude Code is not logged in; run claude once to log in, then try again");
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(request.parallel, plan.length) }, (_, i) => worker(i)));
  } finally {
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
    record.isolation.audit = await audit.stop();
    if (!request.keep) await rm(root, { recursive: true, force: true });
  }

  if (record.isolation.audit.soundPlayers.length > 0) {
    stop(
      "isolation",
      `a sound player ran in an agent's process group: ${record.isolation.audit.soundPlayers.map((s) => s.name).join(", ")}`,
    );
  }
  record.ended = status.stopping?.ended ?? "completed";
  record.endedBecause = status.stopping?.because ?? null;
  record.finishedAt = deps.now().toISOString();
  record.runs.sort((a, b) => a.index - b.index);
  return record;
}
