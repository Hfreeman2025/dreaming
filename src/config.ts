import { isAbsolute, join, normalize } from "node:path";
import { z } from "zod";
import { DreamingError, ExitCode } from "./errors.js";
import { formatIssues, parseJson, readTextIfExists } from "./fsx.js";
import { hasAnyControlChars } from "./text.js";

/** Where dreaming keeps its own files. Everything lives under one directory. */
export interface DreamingPaths {
  home: string;
  config: string;
  state: string;
  inbox: string;
  runs: string;
  backups: string;
  auditLog: string;
  logs: string;
  /** One JSON record per `dreaming eval`. */
  evals: string;
  /** Contradiction checks, one file per dream. */
  checks: string;
  runLock: string;
  applyLock: string;
}

export function dreamingPaths(home: string): DreamingPaths {
  return {
    home,
    config: join(home, "config.json"),
    state: join(home, "state.json"),
    inbox: join(home, "inbox"),
    runs: join(home, "runs"),
    backups: join(home, "backups"),
    auditLog: join(home, "applied.jsonl"),
    logs: join(home, "logs"),
    evals: join(home, "evals"),
    checks: join(home, "checks"),
    runLock: join(home, "run.lock"),
    applyLock: join(home, "apply.lock"),
  };
}

/** Expand a leading `~` and require an absolute path (scheduled jobs have no useful cwd). */
export function resolveUserPath(input: string, homedir: string): string | null {
  const expanded = input === "~" ? homedir : input.startsWith("~/") ? join(homedir, input.slice(2)) : input;
  return isAbsolute(expanded) ? normalize(expanded) : null;
}

function pathSchema(homedir: string) {
  return z
    .string()
    .min(1)
    .refine((value) => !hasAnyControlChars(value), "must not contain control characters")
    .transform((value, ctx) => {
      const resolved = resolveUserPath(value, homedir);
      if (resolved === null) {
        ctx.addIssue({ code: "custom", message: "must be an absolute path (or start with ~/)" });
        return z.NEVER;
      }
      return resolved;
    });
}

/** Model names are passed as a CLI argument, so keep them to a conservative alphabet. */
export const ModelNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/, "must be a model name or alias such as 'sonnet'");

/** Labels become file names and unit names: reverse-DNS style only, no path separators. */
export const ScheduleLabelSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/, "must contain only letters, digits, dots and hyphens");

export const ScheduleTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be a 24-hour time such as 02:00");

/**
 * Webhook URLs are bearer secrets. Require https, except loopback http for
 * local testing, so a summary is never posted in clear text across a network.
 */
export const WebhookUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}, "must be an https:// URL (http:// is allowed only for localhost)");

const RegexSourceSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((source) => {
    try {
      new RegExp(source, "g");
      return true;
    } catch {
      return false;
    }
  }, "must be a valid JavaScript regular expression");

export function configSchema(homedir: string) {
  const path = pathSchema(homedir);
  return z.strictObject({
    memoryDir: path,
    transcripts: z
      .strictObject({
        root: path.default(join(homedir, ".claude", "projects")),
        settleMinutes: z.number().int().min(1).max(1440).default(5),
        lookbackDays: z.number().int().min(1).max(365).default(2),
        maxSessions: z.number().int().min(1).max(200).default(20),
        maxSessionChars: z.number().int().min(20_000).max(2_000_000).default(60_000),
        maxTranscriptBytes: z.number().int().min(1024).max(2_000_000_000).default(200_000_000),
      })
      .prefault({}),
    agent: z
      .strictObject({
        kind: z.literal("claude").default("claude"),
        bin: z
          .string()
          .min(1)
          .refine((value) => !value.startsWith("-"), "must be a command name or path")
          .default("claude"),
        model: ModelNameSchema.optional(),
        timeoutSeconds: z.number().int().min(1).max(7200).default(1200),
        maxOutputBytes: z.number().int().min(1024).max(100_000_000).default(5_000_000),
        maxBudgetUsd: z.number().positive().max(1000).optional(),
      })
      .prefault({}),
    redaction: z.strictObject({ extraPatterns: z.array(RegexSourceSchema).max(50).default([]) }).prefault({}),
    schedule: z
      .strictObject({
        label: ScheduleLabelSchema.default("dev.dreaming.nightly"),
        time: ScheduleTimeSchema.default("02:00"),
      })
      .prefault({}),
    webhook: z
      .strictObject({
        url: WebhookUrlSchema.optional(),
        format: z.enum(["text", "adaptive-card"]).default("text"),
      })
      .prefault({}),
    eval: z
      .strictObject({
        /** The task suite `dreaming eval` runs when --suite is not given. */
        suite: path.optional(),
        /** Model for eval runs; the CLI's default when unset. */
        model: ModelNameSchema.optional(),
        /** Runs at a time. */
        parallel: z.number().int().min(1).max(6).default(3),
      })
      .prefault({}),
    contradictions: z
      .strictObject({
        /** Extra directories to look for the NLI model in (a shared models folder, say). */
        modelDirs: z.array(path).max(10).default([]),
        /** How sure the model must be before a pair is shown as a contradiction. */
        threshold: z.number().min(0.5).max(0.99).default(0.8),
      })
      .prefault({}),
  });
}

export type Config = z.output<ReturnType<typeof configSchema>>;

/** Environment knobs. Empty strings count as unset. */
export const EnvSchema = z.object({
  DREAMING_HOME: z
    .string()
    .optional()
    .transform((value) => (value === "" ? undefined : value))
    .refine((value) => value === undefined || isAbsolute(value), "must be an absolute path"),
  DREAMING_WEBHOOK_URL: z
    .string()
    .optional()
    .transform((value) => (value === "" ? undefined : value))
    .pipe(WebhookUrlSchema.optional()),
  /** Where the NLI model lives (and downloads go), instead of <home>/models. */
  DREAMING_MODELS: z
    .string()
    .optional()
    .transform((value) => (value === "" ? undefined : value))
    .refine((value) => value === undefined || isAbsolute(value), "must be an absolute path"),
});

export type DreamingEnv = z.output<typeof EnvSchema>;

export function parseEnv(env: Record<string, string | undefined>): DreamingEnv {
  const result = EnvSchema.safeParse({
    DREAMING_HOME: env.DREAMING_HOME,
    DREAMING_WEBHOOK_URL: env.DREAMING_WEBHOOK_URL,
    DREAMING_MODELS: env.DREAMING_MODELS,
  });
  if (!result.success) {
    throw new DreamingError(`invalid environment:\n${formatIssues(result.error)}`, {
      exitCode: ExitCode.usage,
    });
  }
  return result.data;
}

export function homeFromEnv(env: DreamingEnv, homedir: string): string {
  return env.DREAMING_HOME ?? join(homedir, ".dreaming");
}

export function parseConfig(value: unknown, homedir: string, source: string): Config {
  const result = configSchema(homedir).safeParse(value);
  if (!result.success) {
    throw new DreamingError(`invalid config in ${source}:\n${formatIssues(result.error)}`, {
      exitCode: ExitCode.usage,
      hint: "Fix the listed fields; dreaming refuses to run on an invalid config.",
    });
  }
  return result.data;
}

export async function loadConfig(paths: DreamingPaths, homedir: string): Promise<Config> {
  const text = await readTextIfExists(paths.config);
  if (text === null) {
    throw new DreamingError(`no config file at ${paths.config}`, {
      exitCode: ExitCode.usage,
      hint: "Create one with: dreaming init --memory-dir <path to your memory directory>",
    });
  }
  const parsed = parseJson(text);
  if (!parsed.ok) {
    throw new DreamingError(`config file is not valid JSON: ${paths.config}\n  ${parsed.error}`, {
      exitCode: ExitCode.usage,
    });
  }
  return parseConfig(parsed.value, homedir, paths.config);
}

/** The webhook in effect, if any: a URL from the environment wins over the config file. */
export function webhookTarget(
  config: Config,
  env: DreamingEnv,
): { url: string; format: "text" | "adaptive-card" } | undefined {
  const url = env.DREAMING_WEBHOOK_URL ?? config.webhook.url;
  return url === undefined ? undefined : { url, format: config.webhook.format };
}
