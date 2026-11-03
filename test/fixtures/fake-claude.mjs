#!/usr/bin/env node
// A stand-in for `claude -p --output-format json`, so tests never call a model.
//
// FAKE_AGENT_MODE     reply (default) | raw | error-envelope | exit | hang | stubborn | flood |
//                     stderr-flood | orphan | orphan-hang
// FAKE_AGENT_REPLY    text to return as the agent's final message (default: no proposals)
// FAKE_AGENT_RECORD   if set, argv, stdin, cwd, the digests it was pointed at and selected env
//                     are written here as JSON
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_AGENT_MODE ?? "reply";
const stdin = readFileSync(0, "utf8");

if (process.env.FAKE_AGENT_RECORD) {
  // Read the session digests the prompt points at, as a real agent would.
  const digests = {};
  for (const match of stdin.matchAll(/`([^`]+\/sessions\/(S\d+)\.md)`/g)) {
    digests[match[2]] = readFileSync(match[1], "utf8");
  }
  writeFileSync(
    process.env.FAKE_AGENT_RECORD,
    JSON.stringify({
      argv: process.argv.slice(2),
      stdin,
      cwd: process.cwd(),
      digests,
      sawWebhookUrl: process.env.DREAMING_WEBHOOK_URL !== undefined,
      sawDreamingHome: process.env.DREAMING_HOME !== undefined,
    }),
  );
}

const reply = process.env.FAKE_AGENT_REPLY ?? JSON.stringify({ summary: "Nothing new.", proposals: [] });
const envelope = (fields) => `${JSON.stringify({ type: "result", session_id: "fake", duration_ms: 5, ...fields })}\n`;

/** Start a long-lived background process that inherits our stdout and stderr. */
function leaveOrphan() {
  const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  process.stderr.write(`orphan=${orphan.pid}\n`);
  orphan.unref();
}

switch (mode) {
  case "reply":
    process.stdout.write(
      envelope({ subtype: "success", is_error: false, result: reply, total_cost_usd: 0.0123, num_turns: 4 }),
    );
    break;
  case "raw":
    process.stdout.write(reply);
    break;
  case "error-envelope":
    process.stdout.write(envelope({ subtype: "error_max_turns", is_error: true }));
    break;
  case "exit":
    process.stderr.write("fake agent: simulated crash\n");
    process.exit(7);
    break;
  case "hang":
    setInterval(() => {}, 1000);
    break;
  case "stubborn":
    // Ignores SIGTERM, so only SIGKILL stops it.
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    break;
  case "flood": {
    const chunk = "x".repeat(64 * 1024);
    const write = () => {
      while (process.stdout.write(chunk)) {
        /* keep writing until the pipe is full */
      }
      process.stdout.once("drain", write);
    };
    write();
    break;
  }
  case "stderr-flood":
    process.stderr.write("e".repeat(1_000_000));
    process.stdout.write(envelope({ subtype: "success", is_error: false, result: reply }));
    break;
  case "orphan":
    // Exits successfully but leaves a process holding the output pipes.
    leaveOrphan();
    process.stdout.write(envelope({ subtype: "success", is_error: false, result: reply }));
    break;
  case "orphan-hang":
    leaveOrphan();
    setInterval(() => {}, 1000);
    break;
  default:
    process.stderr.write(`fake agent: unknown mode ${mode}\n`);
    process.exit(2);
}
