import { appendFile, readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DreamingError } from "../src/errors.js";
import { loadRuns } from "../src/inbox/store.js";
import { loadState } from "../src/state.js";
import { hoursAgo, jsonl, testConfig, touch, userEntry } from "./helpers/sandbox.js";
import { REPLY, useRunScenario, type RunOptions } from "./helpers/run-scenario.js";

describe("dreaming run: failures and notifications", () => {
  const t = useRunScenario();

  describe("failures are explicit and leave the watermark alone", () => {
    let marksBefore: Record<string, unknown> = {};
    beforeEach(() => {
      marksBefore = {};
    });

    it("keeps earlier marks exactly as they were when a later run fails", async () => {
      await t.run();
      marksBefore = (await loadState(t.sandbox.paths.state))?.sessions ?? {};
      await appendFile(t.s1, jsonl([userEntry("One more thing: squash merges only.")]));
      await touch(t.s1, hoursAgo(1));
      const { rm } = await import("node:fs/promises");
      await rm(t.sandbox.paths.inbox, { recursive: true });
      await expectFailure({ reply: "not json at all" }, /not a JSON object/);
    });

    async function expectFailure(options: RunOptions, message: RegExp) {
      const error = await t.run(options).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DreamingError);
      expect(String(error)).toMatch(message);
      const state = await loadState(t.sandbox.paths.state);
      expect(state?.sessions).toEqual(marksBefore);
      expect(state?.lastRun?.ok).toBe(false);
      expect(await loadRuns(t.sandbox.paths.inbox)).toEqual([]);
      const [workspace] = await readdir(t.sandbox.paths.runs);
      return join(t.sandbox.paths.runs, workspace ?? "missing");
    }

    it("saves the raw output when the reply is not JSON", async () => {
      const workspace = await expectFailure(
        { reply: "I could not decide." },
        /agent output failed validation: the reply is not a JSON object/,
      );
      expect(await readFile(join(workspace, "agent-stdout.txt"), "utf8")).toContain("I could not decide.");
      expect(await t.exists(join(workspace, "prompt.md"))).toBe(true);
    });

    it("rejects output that breaks the schema, naming the field", async () => {
      const bad = { summary: "x", proposals: [{ ...REPLY.proposals[1], target: "../../etc/hosts" }] };
      await expectFailure({ reply: bad }, /proposals\.0\.target/);
    });

    it("reports an agent crash with its exit code and stderr", async () => {
      await expectFailure({ mode: "exit" }, /exited with code 7:\s+fake agent: simulated crash/);
    });

    it("reports an error envelope from the CLI", async () => {
      await expectFailure({ mode: "error-envelope" }, /claude reported an error \(error_max_turns\)/);
    });

    it("stops an agent that exceeds the timeout", async () => {
      t.config = testConfig(t.sandbox, { agent: { bin: t.config.agent.bin, timeoutSeconds: 1 } });
      await expectFailure({ mode: "hang" }, /did not finish within 1 second and was stopped/);
    });
  });

  describe("webhook", () => {
    let server: Server;
    let received: { body: string; contentType: string | undefined }[];
    let status: number;

    beforeEach(async () => {
      received = [];
      status = 200;
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString()));
        req.on("end", () => {
          received.push({ body, contentType: req.headers["content-type"] });
          res.statusCode = status;
          res.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    });
    afterEach(async () => {
      await new Promise((resolve) => server.close(resolve));
    });
    const url = () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("server is not listening on TCP");
      return `http://127.0.0.1:${address.port}/hook`;
    };

    it("posts a counts-only summary", async () => {
      const outcome = await t.run({ webhookUrl: url() });
      expect(outcome.kind === "dreamt" && outcome.webhook).toEqual({ kind: "sent" });
      expect(received).toEqual([
        {
          contentType: "application/json",
          body: JSON.stringify({
            text: "dreaming: read 2 sessions; 2 proposals waiting for review (1 add, 1 update). Run `dreaming review` to decide.",
          }),
        },
      ]);
    });

    it("reports a failed delivery without losing the dream", async () => {
      status = 500;
      const outcome = await t.run({ webhookUrl: url() });
      if (outcome.kind !== "dreamt") throw new Error(outcome.kind);
      expect(outcome.webhook).toEqual({
        kind: "failed",
        message: `webhook to ${new URL(url()).origin} returned HTTP 500`,
      });
      expect((await loadState(t.sandbox.paths.state))?.lastRun?.ok).toBe(true);
    });
  });
});
