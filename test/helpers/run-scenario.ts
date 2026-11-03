import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { z } from "zod";
import { claudeAdapter } from "../../src/agent/claude.js";
import type { Config } from "../../src/config.js";
import { dream, type RunOutcome } from "../../src/run/dream.js";
import {
  NOW,
  assistantEntry,
  hoursAgo,
  makeSandbox,
  memoryFile,
  testConfig,
  text,
  userEntry,
  writeMemory,
  writeTranscript,
  type Sandbox,
} from "./sandbox.js";

/**
 * A two-session scenario for `dream()` tests: S1 holds a correction about
 * pnpm, S2 a project update plus a corrupt line. The fake agent's reply is
 * REPLY unless a test passes its own.
 */

const API_MEMORY = memoryFile(
  "api-migration",
  "The v2 API migration is due on 15 November",
  "project",
  "v2 due 15 Nov.",
);

export const REPLY = {
  summary: "2 sessions: 1 new preference, 1 outdated deadline.",
  proposals: [
    {
      action: "add",
      name: "prefer-pnpm",
      description: "Use pnpm, not npm, in tidepool",
      type: "feedback",
      body: "Use pnpm in tidepool.\n\n**Why:** npm breaks the workspace links.\n\n**How to apply:** run pnpm install.",
      reason: "The developer corrected the agent.",
      evidence: [{ session: "S1", quote: "Use pnpm here, npm breaks the workspace links." }],
      confidence: "high",
    },
    {
      action: "update",
      target: "api-migration.md",
      description: "The v2 API went live on 30 October 2026",
      type: "project",
      body: "The v2 API is live (since 30 October 2026); the old endpoints return 410.",
      reason: "The memory still says the migration is due.",
      evidence: [
        { session: "S2", quote: "The v2 API went live on 30 October; the old endpoints return 410 now." },
        { session: "S2", quote: "a sentence nobody ever typed in any session" },
      ],
      confidence: "high",
    },
  ],
};

const RecordedCall = z.object({
  argv: z.array(z.string()),
  stdin: z.string(),
  cwd: z.string(),
  digests: z.record(z.string(), z.string()),
  sawWebhookUrl: z.boolean(),
  sawDreamingHome: z.boolean(),
});

export interface RunOptions {
  dryRun?: boolean;
  reply?: unknown;
  mode?: string;
  env?: Record<string, string>;
  webhookUrl?: string;
}

export interface RunScenario {
  readonly sandbox: Sandbox;
  config: Config;
  readonly s1: string;
  readonly s2: string;
  /** Where the fake agent records its argv, stdin and digests; absent if it never ran. */
  readonly recordFile: string;
  run(options?: RunOptions): Promise<RunOutcome>;
  recordedCall(): Promise<z.infer<typeof RecordedCall>>;
  exists(path: string): Promise<boolean>;
}

interface State {
  sandbox: Sandbox;
  config: Config;
  s1: string;
  s2: string;
  recordFile: string;
}

/** Register setup and teardown in the calling describe block; use the fields inside tests only. */
export function useRunScenario(): RunScenario {
  let state: State | undefined;
  const current = (): State => {
    if (state === undefined) throw new Error("the run scenario is only available inside a test");
    return state;
  };

  beforeEach(async () => {
    const sandbox = await makeSandbox();
    await writeMemory(sandbox, "api-migration.md", API_MEMORY);
    await writeMemory(sandbox, "MEMORY.md", "- [API migration](api-migration.md) — due 15 November\n");
    const s1 = await writeTranscript(
      sandbox,
      "-work-tidepool",
      "11111111-aaaa-4aaa-8aaa-111111111111",
      [
        userEntry("Use pnpm here, npm breaks the workspace links."),
        assistantEntry([text("Understood, switching to pnpm.")]),
      ],
      hoursAgo(10),
    );
    const s2 = await writeTranscript(
      sandbox,
      "-work-tidepool",
      "22222222-bbbb-4bbb-8bbb-222222222222",
      [userEntry("The v2 API went live on 30 October; the old endpoints return 410 now."), "{corrupt line"],
      hoursAgo(9),
    );
    state = { sandbox, config: testConfig(sandbox), s1, s2, recordFile: join(sandbox.root, "agent-call.json") };
  });
  afterEach(async () => {
    await current().sandbox.cleanup();
    state = undefined;
  });

  return {
    get sandbox() {
      return current().sandbox;
    },
    get config() {
      return current().config;
    },
    set config(config: Config) {
      current().config = config;
    },
    get s1() {
      return current().s1;
    },
    get s2() {
      return current().s2;
    },
    get recordFile() {
      return current().recordFile;
    },
    run(options = {}) {
      const { sandbox, config, recordFile } = current();
      return dream(
        {
          paths: sandbox.paths,
          config,
          env: {
            ...process.env,
            FAKE_AGENT_MODE: options.mode ?? "reply",
            FAKE_AGENT_REPLY:
              typeof options.reply === "string" ? options.reply : JSON.stringify(options.reply ?? REPLY),
            FAKE_AGENT_RECORD: recordFile,
            DREAMING_WEBHOOK_URL: "https://hooks.example.test/secret-path",
            ...options.env,
          },
          webhook: options.webhookUrl === undefined ? undefined : { url: options.webhookUrl, format: "text" },
          adapter: claudeAdapter(config.agent.bin),
          now: () => NOW,
          onEvent: () => undefined,
        },
        { dryRun: options.dryRun ?? false, maxSessions: undefined },
      );
    },
    async recordedCall() {
      return RecordedCall.parse(JSON.parse(await readFile(current().recordFile, "utf8")));
    },
    exists(path) {
      return readFile(path).then(
        () => true,
        () => false,
      );
    },
  };
}
