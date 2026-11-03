import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { DreamingError, errorCode, errorMessage } from "../errors.js";
import type { AgentCommand } from "./adapter.js";

export interface ProcessLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  /** Time between SIGTERM and SIGKILL when stopping the process. */
  killGraceMs?: number;
  /** After the agent exits, how long to wait for its output pipes to close. */
  drainMs?: number;
  /** Where process signals and `exit` come from; injectable for tests. */
  signals?: EventEmitter;
  /** Called with the agent's pid (which is also its process group id) once it has started. */
  onSpawn?: (pid: number) => void;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  /** Set when dreaming itself received SIGINT or SIGTERM and stopped the agent. */
  interrupted: NodeJS.Signals | null;
  durationMs: number;
}

export const MAX_STDERR_BYTES = 256_000;

/** Signals that end dreaming: closing the terminal (SIGHUP) included. */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;

/**
 * Run a command with an argument array (no shell), feed it stdin, and collect
 * its output.
 *
 * The agent runs in its own process group, and every stop signal goes to the
 * whole group, so a timeout also stops anything the agent started (a wrapper
 * script's real binary, a background helper). Because the group is separate,
 * signals sent to dreaming would not reach it, so SIGINT, SIGTERM, SIGHUP and
 * SIGQUIT are forwarded, and if dreaming exits for any other reason the group
 * is killed synchronously on the way out. Once the agent exits, its output is collected; a
 * leftover process still holding the pipes gets `drainMs`, then the group is
 * stopped. The group never outlives the call.
 */
export function runProcess(
  command: AgentCommand,
  env: NodeJS.ProcessEnv,
  limits: ProcessLimits,
): Promise<ProcessResult> {
  const started = Date.now();
  const signals: EventEmitter = limits.signals ?? process;
  return new Promise((resolve, reject) => {
    const child = spawn(command.bin, command.args, {
      cwd: command.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    if (child.pid !== undefined) limits.onSpawn?.(child.pid);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let interrupted: NodeJS.Signals | null = null;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        // ESRCH: the group is already gone. Anything else: fall back to the child alone.
        if (errorCode(error) !== "ESRCH") child.kill(signal);
      }
    };
    let stopping = false;
    const stop = () => {
      signalGroup("SIGTERM");
      if (stopping) return;
      stopping = true;
      timers.push(
        setTimeout(() => {
          signalGroup("SIGKILL");
        }, limits.killGraceMs ?? 5000),
      );
    };
    const onSignal = (signal: NodeJS.Signals) => {
      interrupted = signal;
      stop();
    };
    // If dreaming exits without settling (an uncaught error elsewhere), take the group with it.
    const onExit = () => {
      signalGroup("SIGKILL");
    };
    const detach = () => {
      for (const timer of timers) clearTimeout(timer);
      for (const signal of FORWARDED_SIGNALS) signals.off(signal, onSignal);
      signals.off("exit", onExit);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      detach();
      signalGroup("SIGKILL"); // nothing the agent started outlives the run
      resolve({
        exitCode: exit?.code ?? null,
        signal: exit?.signal ?? null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        outputLimitExceeded,
        interrupted,
        durationMs: Date.now() - started,
      });
    };

    for (const signal of FORWARDED_SIGNALS) signals.on(signal, onSignal);
    signals.on("exit", onExit);
    timers.push(
      setTimeout(() => {
        timedOut = true;
        stop();
      }, limits.timeoutMs),
    );

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > limits.maxOutputBytes) {
        if (!outputLimitExceeded) {
          outputLimitExceeded = true;
          stop();
        }
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(chunk);
    });

    child.on("error", (error) => {
      settled = true;
      detach();
      if (errorCode(error) === "ENOENT") {
        reject(
          new DreamingError(`agent binary not found: ${command.bin}`, {
            hint: "Install the agent CLI or set agent.bin in the config to its absolute path.",
          }),
        );
      } else {
        reject(new DreamingError(`could not start the agent: ${errorMessage(error)}`, { cause: error }));
      }
    });

    child.on("exit", (code, signal) => {
      exit = { code, signal };
      // Normally the pipes close right after exit. If something the agent
      // started still holds them, stop waiting after drainMs.
      timers.push(
        setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish();
        }, limits.drainMs ?? 2000),
      );
    });
    child.on("close", finish);

    // A child that exits without reading stdin makes the write fail with EPIPE.
    // The exit status already tells that story, so the write error is recorded
    // in stderr rather than raised separately.
    child.stdin.on("error", (error) => {
      stderr.push(Buffer.from(`\n[dreaming] writing the prompt to the agent failed: ${errorMessage(error)}\n`));
    });
    child.stdin.end(command.stdin);
  });
}
