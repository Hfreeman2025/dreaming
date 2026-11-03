import { execFile } from "node:child_process";
import { basename } from "node:path";
import { DreamingError, errorMessage } from "../errors.js";

/**
 * A process audit for the eval: every 200 ms, list every process descended
 * from a running agent (by parent pid, since Claude Code starts its tools and
 * hooks in process groups of their own) and note any that play sound. It is
 * supporting evidence next to Claude Code's own hook events: a sound-playing
 * hook runs for longer than one sampling interval, while a short command can
 * start and finish between two samples.
 */

const SOUND_PLAYERS =
  /^(afplay|say|osascript|aplay|paplay|pw-play|pw-cat|play|ffplay|mpg123|mpv|mplayer|cvlc|vlc|canberra-gtk-play|beep)$/;

export interface AuditReport {
  samples: number;
  /** Distinct process names seen in agent groups. */
  seen: string[];
  soundPlayers: { name: string; run: number }[];
}

export interface ProcessAudit {
  track(pid: number, run: number): void;
  untrack(pid: number): void;
  stop(): Promise<AuditReport>;
}

export type ListProcesses = () => Promise<{ pid: number; ppid: number; name: string }[]>;

export const listProcesses: ListProcesses = () =>
  new Promise((resolve, reject) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,comm="], { maxBuffer: 8_000_000 }, (error, stdout) => {
      if (error) {
        reject(new DreamingError(`the process audit could not list processes: ${error.message}`, { cause: error }));
        return;
      }
      const rows = [];
      for (const line of stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (match)
          rows.push({ pid: Number(match[1]), ppid: Number(match[2]), name: basename((match[3] ?? "").trim()) });
      }
      resolve(rows);
    });
  });

export function startAudit(list: ListProcesses = listProcesses, intervalMs = 200): ProcessAudit {
  const roots = new Map<number, number>(); // agent pid -> run index
  const seen = new Set<string>();
  const soundPlayers: AuditReport["soundPlayers"] = [];
  let samples = 0;
  let busy: Promise<void> | null = null;
  let failure: DreamingError | null = null;

  const sample = async () => {
    if (roots.size === 0) return;
    const rows = await list();
    samples += 1;
    const children = new Map<number, typeof rows>();
    for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
    const descendants: { name: string; run: number }[] = [];
    for (const [root, run] of roots) {
      const self = rows.find((row) => row.pid === root);
      const stack = self === undefined ? [] : [self];
      while (stack.length > 0) {
        const row = stack.pop();
        if (row === undefined) break;
        descendants.push({ name: row.name, run });
        stack.push(...(children.get(row.pid) ?? []));
      }
    }
    for (const row of descendants) {
      const run = row.run;
      seen.add(row.name);
      if (SOUND_PLAYERS.test(row.name) && !soundPlayers.some((s) => s.name === row.name && s.run === run)) {
        soundPlayers.push({ name: row.name, run });
      }
    }
  };
  const timer = setInterval(() => {
    if (busy !== null) return; // never stack samples on a slow machine
    busy = sample()
      .catch((error: unknown) => {
        failure =
          error instanceof DreamingError
            ? error
            : new DreamingError(`the process audit failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        busy = null;
      });
  }, intervalMs);
  timer.unref();

  return {
    track(pid, run) {
      roots.set(pid, run);
    },
    untrack(pid) {
      roots.delete(pid);
    },
    async stop() {
      clearInterval(timer);
      await busy;
      if (failure !== null) throw failure;
      return { samples, seen: [...seen].sort(), soundPlayers };
    },
  };
}
