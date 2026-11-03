import { z } from "zod";
import { readJsonFile, writeJsonFile } from "./fsx.js";

/**
 * The watermark. Rather than one timestamp, it records, per transcript, the
 * modification time and line count that were last dreamt over. That makes
 * three cases exact that a single timestamp gets wrong:
 *  - a session skipped because it was still active is picked up next time;
 *  - a session that is resumed later is re-read from where the last dream stopped;
 *  - a run capped by `maxSessions` leaves the rest for the next run.
 */
const SessionMarkSchema = z.strictObject({
  mtimeMs: z.number().nonnegative(),
  lines: z.number().int().nonnegative(),
  dreamtAt: z.string(),
});

const LastRunSchema = z.strictObject({
  at: z.string(),
  ok: z.boolean(),
  runId: z.string().optional(),
  message: z.string(),
});

export const StateSchema = z.strictObject({
  version: z.literal(1),
  /** Transcripts older than this were never in scope (cold-start lookback). */
  floorMs: z.number().nonnegative(),
  sessions: z.record(z.string(), SessionMarkSchema),
  lastRun: LastRunSchema.optional(),
});

export type State = z.infer<typeof StateSchema>;
export type SessionMark = z.infer<typeof SessionMarkSchema>;
export type LastRun = z.infer<typeof LastRunSchema>;

export async function loadState(path: string): Promise<State | null> {
  return readJsonFile(path, StateSchema, "state file");
}

export async function saveState(path: string, state: State): Promise<void> {
  await writeJsonFile(path, state);
}

export function initialState(nowMs: number, lookbackDays: number): State {
  return { version: 1, floorMs: nowMs - lookbackDays * 86_400_000, sessions: {} };
}
