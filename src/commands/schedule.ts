import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { ScheduleTimeSchema } from "../config.js";
import { DreamingError, ExitCode } from "../errors.js";
import {
  detectBackend,
  installSchedule,
  scheduleStatus,
  uninstallSchedule,
  type Backend,
  type ScheduleHost,
} from "../schedule/install.js";
import { cronBlock, launchdPlist, systemdService, systemdTimer, type ScheduleSpec } from "../schedule/units.js";
import { loadSetup, out, parseFlags, type CliContext, type Setup } from "./context.js";

const BackendSchema = z.enum(["launchd", "systemd", "cron"]);

async function isExecutable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

/** Resolve the agent binary now, so the job does not depend on the shell's PATH at 2am. */
export async function resolveExecutable(bin: string, pathEnv: string | undefined): Promise<string | null> {
  if (bin.includes("/")) return isAbsolute(bin) && (await isExecutable(bin)) ? bin : null;
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, bin);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export async function buildScheduleSpec(ctx: CliContext, setup: Setup, time: string): Promise<ScheduleSpec> {
  const agentBin = await resolveExecutable(setup.config.agent.bin, ctx.env.PATH);
  if (agentBin === null) {
    throw new DreamingError(`cannot find the agent binary '${setup.config.agent.bin}'; the scheduled job would fail`, {
      hint: "Install it, or set agent.bin in the config to its absolute path.",
    });
  }
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  const pathDirs = [
    dirname(ctx.nodePath),
    dirname(agentBin),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return {
    label: setup.config.schedule.label,
    hour,
    minute,
    programArgs: [ctx.nodePath, ctx.cliPath, "run"],
    env: { DREAMING_HOME: setup.paths.home, PATH: [...new Set(pathDirs)].join(":") },
    logFile: join(setup.paths.logs, "dreaming.log"),
  };
}

function renderFiles(backend: Backend, spec: ScheduleSpec): string {
  switch (backend) {
    case "launchd":
      return launchdPlist(spec);
    case "systemd":
      return `# ${spec.label}.service\n${systemdService(spec)}\n# ${spec.label}.timer\n${systemdTimer(spec)}`;
    case "cron":
      return cronBlock(spec);
  }
}

export async function scheduleCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseFlags(
    args,
    {
      at: { type: "string" },
      backend: { type: "string" },
      print: { type: "boolean", default: false },
    },
    1,
  );
  const action = positionals[0];
  if (action !== "install" && action !== "uninstall" && action !== "status") {
    throw new DreamingError(
      "usage: dreaming schedule install|uninstall|status [--at HH:MM] [--backend launchd|systemd|cron] [--print]",
      {
        exitCode: ExitCode.usage,
      },
    );
  }
  const backendFlag = values.backend === undefined ? undefined : BackendSchema.safeParse(values.backend);
  if (backendFlag?.success === false) {
    throw new DreamingError("--backend must be launchd, systemd or cron", { exitCode: ExitCode.usage });
  }
  if (ctx.platform === "win32") {
    throw new DreamingError("scheduling is not supported on Windows", {
      hint: "Run `dreaming run` from Task Scheduler yourself, or use WSL.",
    });
  }
  const backend = backendFlag?.data ?? detectBackend(ctx.platform, existsSync("/run/systemd/system"));
  if (backend === null) throw new DreamingError(`scheduling is not supported on ${ctx.platform}`);
  const setup = await loadSetup(ctx);
  const host: ScheduleHost = {
    homedir: ctx.homedir,
    uid: ctx.uid,
    xdgConfigHome: ctx.env.XDG_CONFIG_HOME,
    runner: ctx.runner,
  };
  const label = setup.config.schedule.label;

  if (action === "status") {
    const status = await scheduleStatus(backend, label, host);
    const active = status.active === null ? "" : status.active ? ", loaded" : ", not loaded";
    out(ctx, `${backend} ${label}: ${status.installed ? `installed${active}` : "not installed"} (${status.location})`);
    return ExitCode.ok;
  }
  if (action === "uninstall") {
    const removed = await uninstallSchedule(backend, label, host);
    out(ctx, removed ? `Removed the ${backend} job ${label}.` : `No ${backend} job named ${label} was installed.`);
    return ExitCode.ok;
  }

  const time = values.at ?? setup.config.schedule.time;
  if (!ScheduleTimeSchema.safeParse(time).success) {
    throw new DreamingError("--at must be a 24-hour time such as 02:00", { exitCode: ExitCode.usage });
  }
  const spec = await buildScheduleSpec(ctx, setup, time);
  if (values.print) {
    ctx.stdout.write(renderFiles(backend, spec));
    return ExitCode.ok;
  }
  const written = await installSchedule(backend, spec, host);
  out(ctx, `Installed ${backend} job ${label}: dreaming run, daily at ${time}.`);
  for (const file of written) out(ctx, `  ${file}`);
  out(ctx, `Output is logged to ${backend === "systemd" ? `journalctl --user -u ${label}` : spec.logFile}.`);
  return ExitCode.ok;
}
