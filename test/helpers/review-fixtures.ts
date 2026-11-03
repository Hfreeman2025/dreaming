import { sha256 } from "../../src/fsx.js";
import type { RunRecord, StoredProposal } from "../../src/inbox/schema.js";
import type { Key, PlainIO, ScreenIO } from "../../src/review/terminal.js";
import { memoryFile } from "./sandbox.js";

/** Synthetic proposals and scripted terminals for the review tests. */

export const RUN_ID = "20261101-020000-abcd";
export const DEPLOY = memoryFile(
  "deploy-window",
  "Deploys happen on Tuesdays",
  "project",
  "Deploys go out on Tuesdays.",
);
export const INDEX = "- [Deploy window](deploy-window.md) — Deploys happen on Tuesdays\n";

export const verified = [
  { session: "S1", quote: "we deploy on Tuesdays and Thursdays now", status: "verified" as const, line: 7 },
];
const common = { reason: "Sessions say so.", confidence: "high" as const, problems: [], status: "pending" as const };

export const ADD = {
  action: "add",
  id: `${RUN_ID}-1`,
  file: "prefer-pnpm.md",
  name: "prefer-pnpm",
  description: "Use pnpm, not npm",
  type: "feedback",
  body: "Use pnpm.",
  baseHash: null,
  evidence: verified,
  ...common,
} satisfies StoredProposal;
export const UPDATE = {
  action: "update",
  id: `${RUN_ID}-2`,
  file: "deploy-window.md",
  name: "deploy-window",
  description: "Deploys happen on Tuesdays and Thursdays",
  type: "project",
  body: "Deploys go out on Tuesdays and Thursdays.",
  baseHash: sha256(DEPLOY),
  evidence: verified,
  ...common,
} satisfies StoredProposal;
export const DELETE_UNVERIFIED = {
  action: "delete",
  id: `${RUN_ID}-3`,
  file: "deploy-window.md",
  name: "deploy-window",
  baseHash: sha256(DEPLOY),
  evidence: [{ session: "S1", quote: "nobody said this at all", status: "not-found" }],
  ...common,
  problems: ["1 of 1 evidence quotes could not be found in the cited session"],
} satisfies StoredProposal;

export function runRecord(proposals: StoredProposal[], memoryDir: string): RunRecord {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    createdAt: "2026-11-01T02:00:00.000Z",
    memoryDir,
    agent: { kind: "claude", command: ["claude", "--print"], durationMs: 1000 },
    summary: "test run",
    sessions: [
      {
        ref: "S1",
        sessionId: "11111111-aaaa-4aaa-8aaa-111111111111",
        path: "/t/s1.jsonl",
        project: "-work-tidepool",
        cwd: "/work/tidepool",
        firstLine: 1,
        lastLine: 9,
        messages: 4,
        omittedMessages: 0,
        malformedLines: 0,
      },
    ],
    skipped: [],
    redactions: 0,
    proposals,
  };
}

export type Edit = (initial: string) => string;
/** An answer, or a step that does something (like editing memory) before answering. */
export type Answer = string | null | (() => Promise<string | null>);

export function scriptedIO(answers: Answer[], edits: Edit[] = [], width = 100) {
  const queue = [...answers];
  const editQueue = [...edits];
  const io: PlainIO & { output: string } = {
    color: false,
    width,
    output: "",
    write(text) {
      io.output += text;
    },
    async ask(prompt) {
      io.output += prompt;
      const step = queue.shift();
      if (step === undefined) throw new Error(`script ran out of answers at: ${prompt}`);
      const answer = typeof step === "function" ? await step() : step;
      io.output += `${answer ?? "<EOF>"}\n`;
      return answer;
    },
    edit(initial) {
      const edit = editQueue.shift();
      if (edit === undefined) throw new Error("unexpected edit");
      return Promise.resolve(edit(initial));
    },
  };
  return io;
}

/** A key press: a name ("a", "right", "return"), a ctrl chord, or a step that acts first. */
export type Press = string | Key | (() => Promise<string>);

export function scriptedScreen(presses: Press[], size = { columns: 100, rows: 30 }, edits: Edit[] = []) {
  const queue = [...presses];
  const editQueue = [...edits];
  const frames: string[][] = [];
  const screen: ScreenIO &
    PlainIO & { output: string; frames: string[][]; last(): string; startScreen(): void; stopScreen(): void } = {
    color: false,
    width: size.columns,
    output: "",
    frames,
    size: () => size,
    draw(lines) {
      frames.push([...lines]);
    },
    async key() {
      const step = queue.shift();
      if (step === undefined) return null;
      if (typeof step === "function") return { name: await step(), ctrl: false, shift: false };
      return typeof step === "string" ? { name: step, ctrl: false, shift: false } : step;
    },
    edit(initial) {
      const edit = editQueue.shift();
      if (edit === undefined) throw new Error("unexpected edit");
      return Promise.resolve(edit(initial));
    },
    onResize() {
      // a scripted screen never changes size
    },
    write(text) {
      screen.output += text;
    },
    ask() {
      throw new Error("the full-screen review never asks for a line");
    },
    startScreen() {
      // nothing to set up
    },
    stopScreen() {
      // nothing to restore
    },
    last: () => (frames.at(-1) ?? []).join("\n"),
  };
  return screen;
}

export { memoryFile, sha256 };
