/** Process exit codes. Documented in the README; scripts and schedulers rely on them. */
export const ExitCode = {
  ok: 0,
  /** The command failed: agent error, invalid agent output, I/O failure, conflict. */
  failure: 1,
  /** Bad command-line usage or an invalid config file / environment. */
  usage: 2,
  /** The dream was saved, but the configured webhook could not be delivered. */
  notifyFailed: 3,
} as const;

export interface DreamingErrorOptions {
  exitCode?: number;
  /** One line telling the person what to do next. */
  hint?: string;
  cause?: unknown;
}

/** An expected failure with a message written for the person running the command. */
export class DreamingError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;

  constructor(message: string, options: DreamingErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "DreamingError";
    this.exitCode = options.exitCode ?? ExitCode.failure;
    this.hint = options.hint;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Node system errors carry a string `code` (ENOENT, EEXIST, ...). */
export function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}
