import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord, StoredProposal } from "../src/inbox/schema.js";
import { postWebhook, summaryText, webhookBody } from "../src/webhook.js";

const record = (actions: ("add" | "update" | "delete")[], sessions = 2): RunRecord => ({
  schemaVersion: 1,
  runId: "20261101-020000-abcd",
  createdAt: "2026-11-01T02:00:00.000Z",
  memoryDir: "/m",
  agent: { kind: "claude", command: ["claude"], durationMs: 1 },
  summary: "secret-looking summary text that must not leave the machine",
  sessions: Array.from({ length: sessions }, (_, i) => ({
    ref: `S${i + 1}`,
    sessionId: "s",
    path: "/private/path.jsonl",
    project: "p",
    firstLine: 1,
    lastLine: 1,
    messages: 1,
    omittedMessages: 0,
    malformedLines: 0,
  })),
  skipped: [],
  redactions: 0,
  proposals: actions.map((action, i): StoredProposal => {
    const base = {
      id: `20261101-020000-abcd-${i + 1}`,
      file: "x.md",
      name: "x",
      reason: "private reason",
      confidence: "low" as const,
      evidence: [{ session: "S1", quote: "private quote", status: "verified" as const }],
      baseHash: null,
      problems: [],
      status: "pending" as const,
    };
    return action === "delete"
      ? { action, ...base }
      : { action, description: "d", type: "user", body: "private body", ...base };
  }),
});

describe("webhook body", () => {
  it("carries counts only, never proposal content or paths", () => {
    const text = summaryText(record(["add", "add", "update"]));
    expect(text).toBe(
      "dreaming: read 2 sessions; 3 proposals waiting for review (2 add, 1 update). Run `dreaming review` to decide.",
    );
    const everything = JSON.stringify(webhookBody(record(["add", "delete"]), "adaptive-card"));
    for (const secret of ["private", "secret-looking", "/m"]) expect(everything).not.toContain(secret);
  });

  it("says when there was nothing to propose", () => {
    expect(summaryText(record([], 1))).toBe("dreaming: read 1 session; nothing new to propose.");
  });

  it("builds a Slack-style text body and a Teams Workflows Adaptive Card body", () => {
    const text = summaryText(record(["delete"]));
    expect(webhookBody(record(["delete"]), "text")).toEqual({ text });
    expect(webhookBody(record(["delete"]), "adaptive-card")).toEqual({
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            type: "AdaptiveCard",
            version: "1.4",
            body: [{ type: "TextBlock", text, wrap: true }],
          },
        },
      ],
    });
  });
});

describe("postWebhook", () => {
  let server: Server;
  let behaviour: "ok" | "redirect" | "hang";
  let url: string;

  beforeEach(async () => {
    behaviour = "ok";
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (behaviour === "hang") return; // never respond
        if (behaviour === "redirect") {
          res.writeHead(307, { location: "http://example.invalid/elsewhere" });
          res.end();
          return;
        }
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("not listening on TCP");
    url = `http://127.0.0.1:${address.port}/hooks/secret-token-path`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("posts JSON", async () => {
    await expect(postWebhook(url, { text: "hi" })).resolves.toBeUndefined();
  });

  it("refuses to follow a redirect", async () => {
    behaviour = "redirect";
    await expect(postWebhook(url, { text: "hi" })).rejects.toThrow(/webhook to http:\/\/127\.0\.0\.1:\d+ failed/);
  });

  it("gives up after the timeout, naming only the origin", async () => {
    behaviour = "hang";
    const error = await postWebhook(url, { text: "hi" }, { timeoutMs: 200 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(error)).toMatch(/webhook to http:\/\/127\.0\.0\.1:\d+ failed: .*(timeout|aborted)/i);
    expect(String(error)).not.toContain("secret-token-path");
  });
});
