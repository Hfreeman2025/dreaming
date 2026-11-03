import { DreamingError } from "../errors.js";
import { hasAnyControlChars } from "../text.js";

/**
 * Generators for the three scheduler formats. These are pure functions over a
 * validated spec so their exact output can be tested, including escaping:
 * each format has its own quoting rules, and a path with a space, quote, `%`
 * or `$` must survive all three.
 */

export interface ScheduleSpec {
  label: string;
  hour: number;
  minute: number;
  /** argv of the job: absolute node binary, absolute CLI script, then arguments. */
  programArgs: readonly string[];
  /** Environment for the job; the scheduler's own environment is minimal. */
  env: Readonly<Record<string, string>>;
  /** File that receives stdout and stderr (launchd and cron). */
  logFile: string;
}

export function validateSpec(spec: ScheduleSpec): void {
  const values = [spec.label, spec.logFile, ...spec.programArgs, ...Object.keys(spec.env), ...Object.values(spec.env)];
  if (values.some(hasAnyControlChars)) {
    throw new DreamingError("scheduled job paths and settings must not contain control characters or newlines");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(spec.label)) {
    throw new DreamingError(`invalid schedule label: ${spec.label}`);
  }
  if (Object.keys(spec.env).some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
    throw new DreamingError("environment variable names must be letters, digits and underscores");
  }
  if (
    !Number.isInteger(spec.hour) ||
    spec.hour < 0 ||
    spec.hour > 23 ||
    !Number.isInteger(spec.minute) ||
    spec.minute < 0 ||
    spec.minute > 59
  ) {
    throw new DreamingError(`invalid schedule time ${spec.hour}:${spec.minute}`);
  }
}

// --- launchd -----------------------------------------------------------------

export function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function launchdPlist(spec: ScheduleSpec): string {
  validateSpec(spec);
  const string = (value: string) => `<string>${xmlEscape(value)}</string>`;
  const env = Object.entries(spec.env)
    .map(([key, value]) => `      <key>${xmlEscape(key)}</key>\n      ${string(value)}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    ${string(spec.label)}
    <key>ProgramArguments</key>
    <array>
${spec.programArgs.map((arg) => `      ${string(arg)}`).join("\n")}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>
      <integer>${spec.hour}</integer>
      <key>Minute</key>
      <integer>${spec.minute}</integer>
    </dict>
    <key>StandardOutPath</key>
    ${string(spec.logFile)}
    <key>StandardErrorPath</key>
    ${string(spec.logFile)}
    <key>ProcessType</key>
    <string>Background</string>
  </dict>
</plist>
`;
}

// --- systemd -----------------------------------------------------------------

/** Quote one ExecStart argument: `\` and `"` escaped, `%` and `$` doubled. */
export function systemdExecArg(value: string): string {
  // A function replacement: in a replacement *string*, "$$" means a single "$".
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$");
  return `"${escaped}"`;
}

/** Quote one Environment= assignment (no variable expansion happens there; specifiers do). */
export function systemdEnvironment(key: string, value: string): string {
  return `"${`${key}=${value}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

export function systemdService(spec: ScheduleSpec): string {
  validateSpec(spec);
  const env = Object.entries(spec.env).map(([key, value]) => `Environment=${systemdEnvironment(key, value)}`);
  return [
    "[Unit]",
    "Description=dreaming: nightly review of agent sessions into memory proposals",
    "",
    "[Service]",
    "Type=oneshot",
    ...env,
    `ExecStart=${spec.programArgs.map(systemdExecArg).join(" ")}`,
    "",
  ].join("\n");
}

export function systemdTimer(spec: ScheduleSpec): string {
  validateSpec(spec);
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    "[Unit]",
    `Description=Run ${spec.label} nightly`,
    "",
    "[Timer]",
    `OnCalendar=*-*-* ${pad(spec.hour)}:${pad(spec.minute)}:00`,
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

// --- cron --------------------------------------------------------------------

/** POSIX single-quote a word for the shell cron runs; `%` is escaped for cron itself. */
export function cronQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`.replaceAll("%", "\\%");
}

export const cronMarkers = (label: string) => ({
  begin: `# BEGIN ${label} (managed by dreaming schedule; do not edit by hand)`,
  end: `# END ${label}`,
});

export function cronBlock(spec: ScheduleSpec): string {
  validateSpec(spec);
  const env = Object.entries(spec.env).map(([key, value]) => `${key}=${cronQuote(value)}`);
  const command = [...env, ...spec.programArgs.map(cronQuote), ">>", cronQuote(spec.logFile), "2>&1"].join(" ");
  const markers = cronMarkers(spec.label);
  return `${markers.begin}\n${spec.minute} ${spec.hour} * * * ${command}\n${markers.end}\n`;
}

/** Replace (or append, or with `block` null remove) the managed block in a crontab. */
export function replaceCronBlock(crontab: string, label: string, block: string | null): string {
  const markers = cronMarkers(label);
  const lines = crontab === "" ? [] : crontab.replace(/\n$/, "").split("\n");
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line === markers.begin) inside = true;
    else if (inside && line === markers.end) inside = false;
    else if (!inside) out.push(line);
  }
  if (inside) throw new DreamingError(`the crontab has '${markers.begin}' without a matching end marker`);
  const kept = out.length === 0 ? "" : `${out.join("\n")}\n`;
  return block === null ? kept : `${kept}${block}`;
}
