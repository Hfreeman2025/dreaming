import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DreamingError } from "../errors.js";
import { fileKind, writeFileAtomic } from "../fsx.js";
import { cronBlock, launchdPlist, replaceCronBlock, systemdService, systemdTimer, type ScheduleSpec } from "./units.js";

export type Backend = "launchd" | "systemd" | "cron";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program with an argument array. Injected so tests never touch the real scheduler. */
export type CommandRunner = (bin: string, args: readonly string[], input?: string) => Promise<CommandResult>;

export const execRunner: CommandRunner = (bin, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(bin, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(new DreamingError(`could not run ${bin}: ${error.message}`, { cause: error }));
        return;
      }
      resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
    if (input !== undefined) child.stdin?.end(input);
  });

export interface ScheduleHost {
  homedir: string;
  uid: number;
  xdgConfigHome: string | undefined;
  runner: CommandRunner;
}

export interface ScheduleStatus {
  backend: Backend;
  installed: boolean;
  /** Whether the scheduler has the job loaded/enabled; null where that is not a separate state. */
  active: boolean | null;
  location: string;
}

/** The scheduler to use, or null where scheduling is not supported (Windows). */
export function detectBackend(platform: NodeJS.Platform, systemdBooted: boolean): Backend | null {
  if (platform === "win32") return null;
  if (platform === "darwin") return "launchd";
  if (platform === "linux" && systemdBooted) return "systemd";
  return "cron";
}

async function must(host: ScheduleHost, bin: string, args: readonly string[], input?: string): Promise<CommandResult> {
  const result = await host.runner(bin, args, input);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new DreamingError(`${bin} ${args.join(" ")} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

export function plistPath(host: ScheduleHost, label: string): string {
  return join(host.homedir, "Library", "LaunchAgents", `${label}.plist`);
}

function systemdDir(host: ScheduleHost): string {
  return join(host.xdgConfigHome ?? join(host.homedir, ".config"), "systemd", "user");
}

async function launchdLoaded(host: ScheduleHost, label: string): Promise<boolean> {
  return (await host.runner("launchctl", ["print", `gui/${host.uid}/${label}`])).code === 0;
}

async function readCrontab(host: ScheduleHost): Promise<string> {
  const result = await host.runner("crontab", ["-l"]);
  if (result.code === 0) return result.stdout;
  if (/no crontab/i.test(result.stderr)) return "";
  throw new DreamingError(`crontab -l failed (exit ${result.code}): ${result.stderr.trim()}`);
}

/** Install or replace the job. Returns the files written. */
export async function installSchedule(backend: Backend, spec: ScheduleSpec, host: ScheduleHost): Promise<string[]> {
  await mkdir(dirname(spec.logFile), { recursive: true, mode: 0o700 });
  switch (backend) {
    case "launchd": {
      const path = plistPath(host, spec.label);
      await mkdir(dirname(path), { recursive: true });
      await writeFileAtomic(path, launchdPlist(spec), 0o644);
      if (await launchdLoaded(host, spec.label))
        await must(host, "launchctl", ["bootout", `gui/${host.uid}/${spec.label}`]);
      await must(host, "launchctl", ["bootstrap", `gui/${host.uid}`, path]);
      return [path];
    }
    case "systemd": {
      const dir = systemdDir(host);
      await mkdir(dir, { recursive: true });
      const service = join(dir, `${spec.label}.service`);
      const timer = join(dir, `${spec.label}.timer`);
      await writeFileAtomic(service, systemdService(spec), 0o644);
      await writeFileAtomic(timer, systemdTimer(spec), 0o644);
      await must(host, "systemctl", ["--user", "daemon-reload"]);
      await must(host, "systemctl", ["--user", "enable", "--now", `${spec.label}.timer`]);
      return [service, timer];
    }
    case "cron": {
      const current = await readCrontab(host);
      await must(host, "crontab", ["-"], replaceCronBlock(current, spec.label, cronBlock(spec)));
      return ["crontab"];
    }
  }
}

/** Remove the job. Returns false if there was nothing to remove. */
export async function uninstallSchedule(backend: Backend, label: string, host: ScheduleHost): Promise<boolean> {
  switch (backend) {
    case "launchd": {
      const path = plistPath(host, label);
      const loaded = await launchdLoaded(host, label);
      if (loaded) await must(host, "launchctl", ["bootout", `gui/${host.uid}/${label}`]);
      const exists = (await fileKind(path)) === "file";
      if (exists) await rm(path);
      return loaded || exists;
    }
    case "systemd": {
      const dir = systemdDir(host);
      const files = [join(dir, `${label}.timer`), join(dir, `${label}.service`)];
      const exists = (await fileKind(files[0] ?? "")) === "file";
      if (exists) await must(host, "systemctl", ["--user", "disable", "--now", `${label}.timer`]);
      for (const file of files) await rm(file, { force: true });
      if (exists) await must(host, "systemctl", ["--user", "daemon-reload"]);
      return exists;
    }
    case "cron": {
      const current = await readCrontab(host);
      const updated = replaceCronBlock(current, label, null);
      if (updated === current) return false;
      await must(host, "crontab", ["-"], updated);
      return true;
    }
  }
}

export async function scheduleStatus(backend: Backend, label: string, host: ScheduleHost): Promise<ScheduleStatus> {
  switch (backend) {
    case "launchd": {
      const path = plistPath(host, label);
      const installed = (await fileKind(path)) === "file";
      return { backend, installed, active: await launchdLoaded(host, label), location: path };
    }
    case "systemd": {
      const timer = join(systemdDir(host), `${label}.timer`);
      const installed = (await fileKind(timer)) === "file";
      const result = await host.runner("systemctl", ["--user", "is-active", `${label}.timer`]);
      return { backend, installed, active: result.stdout.trim() === "active", location: timer };
    }
    case "cron": {
      const current = await readCrontab(host);
      const installed = replaceCronBlock(current, label, null) !== current;
      return { backend, installed, active: null, location: "crontab" };
    }
  }
}
