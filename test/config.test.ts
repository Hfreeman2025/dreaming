import { describe, expect, it } from "vitest";
import { dreamingPaths, homeFromEnv, loadConfig, parseConfig, parseEnv, webhookTarget } from "../src/config.js";
import { DreamingError, ExitCode } from "../src/errors.js";
import { makeSandbox, writeConfigFile } from "./helpers/sandbox.js";

const HOME = "/home/sam";

function configError(value: unknown): DreamingError {
  try {
    parseConfig(value, HOME, "config.json");
  } catch (error) {
    if (error instanceof DreamingError) return error;
    throw error;
  }
  throw new Error("expected the config to be rejected");
}

describe("config file", () => {
  it("fills defaults around the one required field", () => {
    expect(parseConfig({ memoryDir: "~/notes/memory" }, HOME, "config.json")).toEqual({
      memoryDir: "/home/sam/notes/memory",
      transcripts: {
        root: "/home/sam/.claude/projects",
        settleMinutes: 5,
        lookbackDays: 2,
        maxSessions: 20,
        maxSessionChars: 60_000,
        maxTranscriptBytes: 200_000_000,
      },
      agent: { kind: "claude", bin: "claude", timeoutSeconds: 1200, maxOutputBytes: 5_000_000 },
      redaction: { extraPatterns: [] },
      schedule: { label: "dev.dreaming.nightly", time: "02:00" },
      webhook: { format: "text" },
      eval: { parallel: 3 },
      contradictions: { modelDirs: [], threshold: 0.8 },
    });
  });

  it("refuses unknown keys, so a typo is not silently ignored", () => {
    const error = configError({ memoryDir: "/m", agent: { timeoutSecs: 10 } });
    expect(error.exitCode).toBe(ExitCode.usage);
    expect(error.message).toContain("agent: Unrecognized key");
  });

  it.each([
    [{}, "memoryDir"],
    [{ memoryDir: "relative/path" }, "memoryDir: must be an absolute path"],
    [{ memoryDir: "/m", transcripts: { settleMinutes: 0 } }, "transcripts.settleMinutes"],
    [{ memoryDir: "/m", agent: { kind: "codex" } }, "agent.kind"],
    [{ memoryDir: "/m", agent: { timeoutSeconds: 99_999 } }, "agent.timeoutSeconds"],
    [{ memoryDir: "/m", schedule: { label: "../evil" } }, "schedule.label"],
    [{ memoryDir: "/m", schedule: { time: "25:00" } }, "schedule.time"],
    [
      { memoryDir: "/m", redaction: { extraPatterns: ["(unclosed"] } },
      "redaction.extraPatterns.0: must be a valid JavaScript regular expression",
    ],
    [{ memoryDir: "/m", webhook: { url: "http://hooks.example.com/x" } }, "webhook.url: must be an https:// URL"],
    [{ memoryDir: "/m", webhook: { format: "xml" } }, "webhook.format"],
    [{ memoryDir: "/m\n/etc" }, "memoryDir: must not contain control characters"],
  ])("rejects %j, naming %s", (value, field) => {
    expect(configError(value).message).toContain(field);
  });

  it("allows plain http only for a loopback webhook", () => {
    const config = parseConfig({ memoryDir: "/m", webhook: { url: "http://127.0.0.1:9999/hook" } }, HOME, "c");
    expect(config.webhook.url).toBe("http://127.0.0.1:9999/hook");
  });

  it("explains a missing or unparseable config file", async () => {
    const sandbox = await makeSandbox();
    try {
      await expect(loadConfig(sandbox.paths, sandbox.homedir)).rejects.toThrow(/no config file at .*config\.json/);
      await writeConfigFile(sandbox, "placeholder");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(sandbox.paths.config, "{ memoryDir: oops");
      await expect(loadConfig(sandbox.paths, sandbox.homedir)).rejects.toThrow(/config file is not valid JSON/);
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("environment", () => {
  it("uses DREAMING_HOME when set and ~/.dreaming otherwise", () => {
    expect(homeFromEnv(parseEnv({ DREAMING_HOME: "/srv/dreaming" }), HOME)).toBe("/srv/dreaming");
    expect(homeFromEnv(parseEnv({}), HOME)).toBe("/home/sam/.dreaming");
    expect(homeFromEnv(parseEnv({ DREAMING_HOME: "" }), HOME)).toBe("/home/sam/.dreaming");
    expect(dreamingPaths("/srv/d").auditLog).toBe("/srv/d/applied.jsonl");
  });

  it("refuses a relative DREAMING_HOME and a non-https webhook", () => {
    expect(() => parseEnv({ DREAMING_HOME: "dreaming" })).toThrow(/DREAMING_HOME: must be an absolute path/);
    expect(() => parseEnv({ DREAMING_WEBHOOK_URL: "ftp://example.com" })).toThrow(/DREAMING_WEBHOOK_URL/);
  });

  it("lets the environment webhook URL override the config file, keeping the configured format", () => {
    const config = parseConfig(
      { memoryDir: "/m", webhook: { url: "https://a.example/1", format: "adaptive-card" } },
      HOME,
      "c",
    );
    expect(webhookTarget(config, parseEnv({ DREAMING_WEBHOOK_URL: "https://b.example/2" }))).toEqual({
      url: "https://b.example/2",
      format: "adaptive-card",
    });
    expect(webhookTarget(config, parseEnv({}))).toEqual({ url: "https://a.example/1", format: "adaptive-card" });
    expect(webhookTarget(parseConfig({ memoryDir: "/m" }, HOME, "c"), parseEnv({}))).toBeUndefined();
  });
});
