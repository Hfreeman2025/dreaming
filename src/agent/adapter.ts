/**
 * The seam between dreaming and a coding-agent CLI. An adapter turns an
 * invocation into an exact command (binary, argv, stdin) and turns the CLI's
 * stdout back into the agent's final reply. Process handling, timeouts, output
 * limits and validation of the reply live outside the adapter, so a new agent
 * (for example a Codex adapter using `codex exec --sandbox read-only`) only has
 * to answer these two questions.
 *
 * Contract: the command an adapter builds must give the agent read-only access.
 * Each adapter ships a test that asserts this on the constructed argv.
 */

export interface AgentInvocation {
  /** Full prompt text; adapters must pass it on stdin, never in argv. */
  prompt: string;
  /** Working directory for the agent (the run workspace). */
  workspaceDir: string;
  /** Directories the agent needs to read. */
  readableDirs: readonly string[];
  model: string | undefined;
  maxBudgetUsd: number | undefined;
}

export interface AgentCommand {
  bin: string;
  args: string[];
  cwd: string;
  stdin: string;
}

export interface AgentReply {
  /** The agent's final message, expected to be the JSON proposal document. */
  text: string;
  costUsd: number | undefined;
  turns: number | undefined;
}

export interface AgentAdapter {
  readonly kind: string;
  /** The only tools the agent may use. All must be read-only. */
  readonly readOnlyTools: readonly string[];
  buildCommand(invocation: AgentInvocation): AgentCommand;
  /** Parse CLI stdout. Throws a DreamingError if the CLI reported failure or the shape is wrong. */
  parseReply(stdout: string): AgentReply;
}
