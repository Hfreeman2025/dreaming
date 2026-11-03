import { randomBytes } from "node:crypto";

/** `YYYYMMDD-HHMMSS-xxxx` in UTC: sorts by time, safe in file names. */
export function makeRunId(now: Date, suffix = randomBytes(2).toString("hex")): string {
  const iso = now.toISOString(); // 2026-11-01T02:00:03.123Z
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}-${suffix}`;
}
