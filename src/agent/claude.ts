import { z } from "zod";
import { DreamingError } from "../errors.js";
import { formatIssues, parseJson } from "../fsx.js";
import type { AgentAdapter, AgentCommand, AgentInvocation, AgentReply } from "./adapter.js";

/** Claude Code tools that only read. */
export const CLAUDE_READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const;

/**
 * Tools that write files, run code, reach the network or start other agents.
 * They are already absent (`--tools`) and unapproved (`--allowedTools`); the
 * explicit deny list is a third, independent layer.
 */
export const CLAUDE_DENIED_TOOLS = [
  "Bash",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
] as const;

const ResultEnvelope = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
  num_turns: z.number().int().optional(),
});

/**
 * `claude -p --output-format json` prints one result envelope. The adapter
 * runs Claude Code headless with:
 *  - `--restricted`: file tools are confined to the working directories (the
 *    run workspace and the memory directory), and user/project settings files
 *    are ignored, so hooks and plugins configured there do not run;
 *  - `--tools Read,Glob,Grep`: no other built-in tool exists in the session;
 *  - `--allowedTools` the same list, and `--permission-mode dontAsk`, so
 *    anything else is denied instead of prompting;
 *  - `--disallowedTools` for every mutating tool;
 *  - `--strict-mcp-config` with no MCP config, so no MCP server (and none of
 *    its tools) is loaded;
 *  - `--no-session-persistence`, so the dream does not write a transcript that
 *    the next dream would read.
 */
export const claudeAdapter = (bin: string): AgentAdapter => ({
  kind: "claude",
  readOnlyTools: CLAUDE_READ_ONLY_TOOLS,

  buildCommand(invocation: AgentInvocation): AgentCommand {
    const tools = CLAUDE_READ_ONLY_TOOLS.join(",");
    const args = [
      "--print",
      "--output-format",
      "json",
      "--restricted",
      "--tools",
      tools,
      "--allowedTools",
      tools,
      "--disallowedTools",
      CLAUDE_DENIED_TOOLS.join(","),
      "--permission-mode",
      "dontAsk",
      "--strict-mcp-config",
      "--no-session-persistence",
    ];
    for (const dir of invocation.readableDirs) args.push("--add-dir", dir);
    if (invocation.model !== undefined) args.push("--model", invocation.model);
    if (invocation.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(invocation.maxBudgetUsd));
    return { bin, args, cwd: invocation.workspaceDir, stdin: invocation.prompt };
  },

  parseReply(stdout: string): AgentReply {
    const parsed = parseJson(stdout.trim());
    if (!parsed.ok) {
      throw new DreamingError(`claude did not print a JSON result envelope: ${parsed.error}`);
    }
    const envelope = ResultEnvelope.safeParse(parsed.value);
    if (!envelope.success) {
      throw new DreamingError(`claude printed an unexpected result envelope:\n${formatIssues(envelope.error)}`);
    }
    const { subtype, is_error: isError, result } = envelope.data;
    if (isError || subtype !== "success") {
      throw new DreamingError(`claude reported an error (${subtype})${result ? `: ${result.slice(0, 500)}` : ""}`);
    }
    if (result === undefined) throw new DreamingError("claude reported success but returned no result text");
    return { text: result, costUsd: envelope.data.total_cost_usd, turns: envelope.data.num_turns };
  },
});
