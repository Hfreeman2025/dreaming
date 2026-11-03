import { describe, expect, it } from "vitest";
import { CLAUDE_DENIED_TOOLS, CLAUDE_READ_ONLY_TOOLS, claudeAdapter } from "../src/agent/claude.js";
import { EventEmitter } from "node:events";
import { MAX_STDERR_BYTES, runProcess } from "../src/agent/process.js";
import { configSchema } from "../src/config.js";
import { DreamingError } from "../src/errors.js";
import { FAKE_AGENT } from "./helpers/sandbox.js";

const invocation = {
  prompt: "PROMPT TEXT",
  workspaceDir: "/home/sam/.dreaming/runs/r1",
  readableDirs: ["/home/sam/.dreaming/runs/r1", "/home/sam/memory"],
  model: undefined,
  maxBudgetUsd: undefined,
};

/** The value following a flag in an argv. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

describe("claude adapter: the agent gets read-only tools", () => {
  const command = claudeAdapter("claude").buildCommand(invocation);

  it("builds exactly this command", () => {
    expect(command).toEqual({
      bin: "claude",
      args: [
        "--print",
        "--output-format",
        "json",
        "--restricted",
        "--tools",
        "Read,Glob,Grep",
        "--allowedTools",
        "Read,Glob,Grep",
        "--disallowedTools",
        "Bash,Edit,MultiEdit,Write,NotebookEdit,WebFetch,WebSearch,Task,Agent",
        "--permission-mode",
        "dontAsk",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--add-dir",
        "/home/sam/.dreaming/runs/r1",
        "--add-dir",
        "/home/sam/memory",
      ],
      cwd: "/home/sam/.dreaming/runs/r1",
      stdin: "PROMPT TEXT",
    });
  });

  it("makes only Read, Glob and Grep available and approved", () => {
    expect(flagValue(command.args, "--tools")?.split(",")).toEqual(["Read", "Glob", "Grep"]);
    expect(flagValue(command.args, "--allowedTools")?.split(",")).toEqual(["Read", "Glob", "Grep"]);
  });

  it("denies every tool that writes, executes, fetches or delegates", () => {
    const denied = flagValue(command.args, "--disallowedTools")?.split(",") ?? [];
    for (const tool of [
      "Bash",
      "Edit",
      "MultiEdit",
      "Write",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Task",
      "Agent",
    ]) {
      expect(denied).toContain(tool);
    }
    const deniedSet = new Set<string>(CLAUDE_DENIED_TOOLS);
    expect(CLAUDE_READ_ONLY_TOOLS.filter((tool) => deniedSet.has(tool))).toEqual([]);
  });

  it("runs in restricted mode: file tools confined to the given directories, user settings and hooks ignored", () => {
    expect(command.args).toContain("--restricted");
    expect(command.args.filter((arg) => arg === "--add-dir")).toHaveLength(2);
  });

  it("never asks for or bypasses permissions, and loads no MCP servers", () => {
    expect(flagValue(command.args, "--permission-mode")).toBe("dontAsk");
    expect(command.args).toContain("--strict-mcp-config");
    expect(command.args).not.toContain("--mcp-config");
    for (const flag of [
      "--dangerously-skip-permissions",
      "--allow-dangerously-skip-permissions",
      "bypassPermissions",
    ]) {
      expect(command.args).not.toContain(flag);
    }
  });

  it("does not persist the dream's own session (it would be dreamt over next time)", () => {
    expect(command.args).toContain("--no-session-persistence");
  });

  it("passes the prompt on stdin, never in argv", () => {
    expect(command.args.join(" ")).not.toContain("PROMPT TEXT");
    expect(command.stdin).toBe("PROMPT TEXT");
  });

  it("adds model and budget as separate argv entries without changing the tool flags", () => {
    const withModel = claudeAdapter("/opt/bin/claude").buildCommand({
      ...invocation,
      model: "sonnet",
      maxBudgetUsd: 0.5,
    });
    expect(flagValue(withModel.args, "--model")).toBe("sonnet");
    expect(flagValue(withModel.args, "--max-budget-usd")).toBe("0.5");
    expect(flagValue(withModel.args, "--tools")).toBe("Read,Glob,Grep");
    expect(withModel.bin).toBe("/opt/bin/claude");
  });

  it("refuses a model name that tries to smuggle in a flag", () => {
    const schema = configSchema("/home/sam");
    for (const model of ["sonnet --dangerously-skip-permissions", "--tools=Bash", "a b"]) {
      expect(schema.safeParse({ memoryDir: "/m", agent: { model } }).success).toBe(false);
    }
    expect(schema.safeParse({ memoryDir: "/m", agent: { bin: "--dangerously-skip-permissions" } }).success).toBe(false);
  });
});

describe("claude adapter: reading the result envelope", () => {
  const adapter = claudeAdapter("claude");
  const envelope = (fields: Record<string, unknown>) =>
    JSON.stringify({ type: "result", subtype: "success", is_error: false, ...fields });

  it("returns the final message, cost and turns", () => {
    expect(adapter.parseReply(envelope({ result: "{}", total_cost_usd: 0.25, num_turns: 6 }))).toEqual({
      text: "{}",
      costUsd: 0.25,
      turns: 6,
    });
  });

  it.each([
    ["not json", /did not print a JSON result envelope/],
    [JSON.stringify({ type: "assistant" }), /unexpected result envelope/],
    [envelope({ subtype: "error_max_turns", is_error: true }), /reported an error \(error_max_turns\)$/],
    [
      envelope({ is_error: true, result: "API Error: overloaded" }),
      /reported an error \(success\): API Error: overloaded/,
    ],
    [envelope({}), /returned no result text/],
  ])("turns a bad envelope into an explicit error: %s", (stdout, pattern) => {
    expect(() => adapter.parseReply(stdout)).toThrow(pattern);
  });
});

describe("runProcess: limits on the agent process", () => {
  // Generous by default: on a loaded machine Node can take over a second to start.
  const fake = (mode: string, timeoutMs = 10_000, signals?: EventEmitter) =>
    runProcess(
      { bin: FAKE_AGENT, args: [], cwd: process.cwd(), stdin: "hello" },
      { ...process.env, FAKE_AGENT_MODE: mode },
      { timeoutMs, maxOutputBytes: 100_000, killGraceMs: 300, drainMs: 300, ...(signals ? { signals } : {}) },
    );
  const orphanPid = (stderr: string) => Number(/orphan=(\d+)/.exec(stderr)?.[1]);
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** A killed process is reaped asynchronously; wait up to two seconds for it to go. */
  const goneWithin2s = async (pid: number) => {
    for (let i = 0; i < 40 && isAlive(pid); i += 1) await new Promise((r) => setTimeout(r, 50));
    return !isAlive(pid);
  };

  it("collects stdout and the exit code", async () => {
    const result = await fake("reply");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({ type: "result", subtype: "success" });
  });

  it("reports a non-zero exit with stderr", async () => {
    const result = await fake("exit");
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("simulated crash");
  });

  it("stops an agent that runs past the timeout", async () => {
    const started = Date.now();
    const result = await fake("hang", 1000);
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGTERM");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("escalates to SIGKILL when the agent ignores SIGTERM", async () => {
    // Long enough for Node to start and install its SIGTERM handler on a slow machine.
    const result = await fake("stubborn", 3000);
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
  });

  it("stops an agent whose output exceeds the limit", async () => {
    const result = await fake("flood");
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(100_000);
  });

  it("returns promptly when the agent exits but leaves a process holding its output, and stops that process", async () => {
    const started = Date.now();
    const result = await fake("orphan");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout).toContain('"subtype":"success"');
    expect(await goneWithin2s(orphanPid(result.stderr))).toBe(true);
  });

  it("stops the agent's whole process group on timeout, not just the agent", async () => {
    const started = Date.now();
    const result = await fake("orphan-hang", 1000);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await goneWithin2s(orphanPid(result.stderr))).toBe(true);
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"])("stops the agent when dreaming receives %s", async (signal) => {
    const signals = new EventEmitter();
    const run = fake("hang", undefined, signals);
    setTimeout(() => signals.emit(signal, signal), 300);
    const result = await run;
    expect(result.interrupted).toBe(signal);
    expect(signals.eventNames()).toEqual([]);
  });

  it("kills the agent's group if dreaming exits while the agent runs", async () => {
    const signals = new EventEmitter();
    const run = fake("orphan-hang", undefined, signals);
    // Wait until the agent has started its background process, then simulate dreaming exiting.
    await new Promise((resolve) => setTimeout(resolve, 500));
    signals.emit("exit");
    const result = await run;
    expect(await goneWithin2s(orphanPid(result.stderr))).toBe(true);
  });

  it("keeps at most 256 KB of the agent's stderr", async () => {
    const result = await fake("stderr-flood");
    expect(result.exitCode).toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stderr.length).toBeLessThanOrEqual(MAX_STDERR_BYTES);
  });

  it("explains a missing agent binary", async () => {
    const run = runProcess({ bin: "/nonexistent/claude", args: [], cwd: process.cwd(), stdin: "" }, process.env, {
      timeoutMs: 1000,
      maxOutputBytes: 1000,
    });
    await expect(run).rejects.toBeInstanceOf(DreamingError);
    await expect(run).rejects.toThrow("agent binary not found: /nonexistent/claude");
  });
});
