import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectBackend,
  installSchedule,
  scheduleStatus,
  uninstallSchedule,
  type CommandResult,
  type ScheduleHost,
} from "../src/schedule/install.js";
import {
  cronBlock,
  cronQuote,
  launchdPlist,
  replaceCronBlock,
  systemdExecArg,
  systemdService,
  systemdTimer,
  type ScheduleSpec,
} from "../src/schedule/units.js";
import { makeSandbox, type Sandbox } from "./helpers/sandbox.js";

const spec: ScheduleSpec = {
  label: "dev.dreaming.nightly",
  hour: 2,
  minute: 30,
  programArgs: ["/usr/local/bin/node", "/opt/dreaming/dist/cli.js", "run"],
  env: { DREAMING_HOME: "/home/sam/.dreaming", PATH: "/usr/local/bin:/usr/bin:/bin" },
  logFile: "/home/sam/.dreaming/logs/dreaming.log",
};

describe("launchd plist", () => {
  it("generates a user agent that runs `dreaming run` at the configured time", () => {
    expect(launchdPlist(spec)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>dev.dreaming.nightly</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/node</string>
      <string>/opt/dreaming/dist/cli.js</string>
      <string>run</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>DREAMING_HOME</key>
      <string>/home/sam/.dreaming</string>
      <key>PATH</key>
      <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>
      <integer>2</integer>
      <key>Minute</key>
      <integer>30</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/home/sam/.dreaming/logs/dreaming.log</string>
    <key>StandardErrorPath</key>
    <string>/home/sam/.dreaming/logs/dreaming.log</string>
    <key>ProcessType</key>
    <string>Background</string>
  </dict>
</plist>
`);
  });

  it("escapes XML in paths and passes spaces, % and $ through untouched (launchd uses no shell)", () => {
    const plist = launchdPlist({
      ...spec,
      programArgs: ["/Users/a&b/<node>", "/x/'cli'.js", "/My Apps/100%/$HOME/run"],
    });
    expect(plist).toContain("<string>/Users/a&amp;b/&lt;node&gt;</string>");
    expect(plist).toContain("<string>/x/&apos;cli&apos;.js</string>");
    expect(plist).toContain("<string>/My Apps/100%/$HOME/run</string>");
  });
});

describe("systemd units", () => {
  it("generates a oneshot service and a persistent daily timer", () => {
    expect(systemdService(spec)).toBe(
      [
        "[Unit]",
        "Description=dreaming: nightly review of agent sessions into memory proposals",
        "",
        "[Service]",
        "Type=oneshot",
        'Environment="DREAMING_HOME=/home/sam/.dreaming"',
        'Environment="PATH=/usr/local/bin:/usr/bin:/bin"',
        'ExecStart="/usr/local/bin/node" "/opt/dreaming/dist/cli.js" "run"',
        "",
      ].join("\n"),
    );
    expect(systemdTimer(spec)).toBe(
      [
        "[Unit]",
        "Description=Run dev.dreaming.nightly nightly",
        "",
        "[Timer]",
        "OnCalendar=*-*-* 02:30:00",
        "Persistent=true",
        "",
        "[Install]",
        "WantedBy=timers.target",
        "",
      ].join("\n"),
    );
  });

  it("escapes quotes, backslashes, % specifiers and $ expansion in ExecStart", () => {
    expect(systemdExecArg('/home/s am/100%/"q"\\$HOME')).toBe('"/home/s am/100%%/\\"q\\"\\\\$$HOME"');
  });

  it("escapes % in Environment= but leaves $ alone (no expansion happens there)", () => {
    const unit = systemdService({ ...spec, env: { DREAMING_HOME: "/home/x/50%/$dir" } });
    expect(unit).toContain('Environment="DREAMING_HOME=/home/x/50%%/$dir"');
  });
});

describe("cron", () => {
  it("generates a managed block with quoted paths and a log redirect", () => {
    expect(cronBlock(spec)).toBe(
      "# BEGIN dev.dreaming.nightly (managed by dreaming schedule; do not edit by hand)\n" +
        "30 2 * * * DREAMING_HOME='/home/sam/.dreaming' PATH='/usr/local/bin:/usr/bin:/bin' '/usr/local/bin/node' '/opt/dreaming/dist/cli.js' 'run' >> '/home/sam/.dreaming/logs/dreaming.log' 2>&1\n" +
        "# END dev.dreaming.nightly\n",
    );
  });

  it("quotes single quotes for the shell and escapes % for cron", () => {
    expect(cronQuote("/it's/100%")).toBe("'/it'\\''s/100\\%'");
  });

  it("keeps spaces and $ literal inside single quotes", () => {
    expect(cronQuote("/My Apps/$HOME/run")).toBe("'/My Apps/$HOME/run'");
  });

  it("replaces its own block, keeps other entries, and removes cleanly", () => {
    const other = "0 * * * * /usr/bin/backup\n";
    const installed = replaceCronBlock(other, spec.label, cronBlock(spec));
    expect(installed).toBe(other + cronBlock(spec));
    const reinstalled = replaceCronBlock(installed, spec.label, cronBlock({ ...spec, hour: 4 }));
    expect(reinstalled.match(/# BEGIN/g)).toHaveLength(1);
    expect(reinstalled).toContain("30 4 * * *");
    expect(replaceCronBlock(reinstalled, spec.label, null)).toBe(other);
  });

  it("refuses a crontab with an unterminated block rather than guessing", () => {
    const broken = "# BEGIN dev.dreaming.nightly (managed by dreaming schedule; do not edit by hand)\n30 2 * * * x\n";
    expect(() => replaceCronBlock(broken, spec.label, null)).toThrow(/without a matching end marker/);
  });
});

describe("spec validation", () => {
  it.each([
    [{ ...spec, label: "../../evil" }, /invalid schedule label/],
    [{ ...spec, programArgs: ["/node", "/cli.js\nrm -rf ~", "run"] }, /control characters/],
    [{ ...spec, env: { "BAD KEY": "x" } }, /environment variable names/],
    [{ ...spec, hour: 24 }, /invalid schedule time/],
  ])("rejects an unsafe spec", (bad, message) => {
    expect(() => launchdPlist(bad)).toThrow(message);
    expect(() => systemdService(bad)).toThrow(message);
    expect(() => cronBlock(bad)).toThrow(message);
  });
});

describe("installing, with a fake command runner", () => {
  let sandbox: Sandbox;
  let calls: { bin: string; args: readonly string[]; input: string | undefined }[];
  let responses: Map<string, CommandResult>;
  let host: ScheduleHost;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    calls = [];
    responses = new Map();
    host = {
      homedir: sandbox.homedir,
      uid: 501,
      xdgConfigHome: undefined,
      runner: (bin, args, input) => {
        calls.push({ bin, args, input });
        return Promise.resolve(responses.get(`${bin} ${args.join(" ")}`) ?? { code: 0, stdout: "", stderr: "" });
      },
    };
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });
  const localSpec = () => ({ ...spec, logFile: join(sandbox.root, "logs", "dreaming.log") });
  const commands = () => calls.map((c) => `${c.bin} ${c.args.join(" ")}`);

  it("picks launchd on macOS, systemd on systemd Linux, cron otherwise", () => {
    expect(detectBackend("darwin", false)).toBe("launchd");
    expect(detectBackend("linux", true)).toBe("systemd");
    expect(detectBackend("linux", false)).toBe("cron");
    expect(detectBackend("freebsd", false)).toBe("cron");
    expect(detectBackend("win32", false)).toBeNull();
  });

  it("launchd: writes the plist and bootstraps it, replacing a loaded copy", async () => {
    const files = await installSchedule("launchd", localSpec(), host);
    const plist = join(sandbox.homedir, "Library", "LaunchAgents", "dev.dreaming.nightly.plist");
    expect(files).toEqual([plist]);
    expect(await readFile(plist, "utf8")).toBe(launchdPlist(localSpec()));
    // `launchctl print` succeeded (code 0), so the old copy is booted out first.
    expect(commands()).toEqual([
      "launchctl print gui/501/dev.dreaming.nightly",
      "launchctl bootout gui/501/dev.dreaming.nightly",
      `launchctl bootstrap gui/501 ${plist}`,
    ]);
  });

  it("launchd: surfaces a failing launchctl as an error", async () => {
    responses.set("launchctl print gui/501/dev.dreaming.nightly", { code: 113, stdout: "", stderr: "not found" });
    responses.set(
      `launchctl bootstrap gui/501 ${join(sandbox.homedir, "Library", "LaunchAgents", "dev.dreaming.nightly.plist")}`,
      {
        code: 5,
        stdout: "",
        stderr: "Bootstrap failed: 5: Input/output error",
      },
    );
    await expect(installSchedule("launchd", localSpec(), host)).rejects.toThrow(/failed \(exit 5\): Bootstrap failed/);
  });

  it("systemd: writes both units, reloads, and enables the timer", async () => {
    const files = await installSchedule("systemd", localSpec(), host);
    const dir = join(sandbox.homedir, ".config", "systemd", "user");
    expect(files).toEqual([join(dir, "dev.dreaming.nightly.service"), join(dir, "dev.dreaming.nightly.timer")]);
    expect(await readFile(join(dir, "dev.dreaming.nightly.timer"), "utf8")).toBe(systemdTimer(localSpec()));
    expect(commands()).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now dev.dreaming.nightly.timer",
    ]);
    await uninstallSchedule("systemd", spec.label, host);
    expect(commands().slice(2)).toEqual([
      "systemctl --user disable --now dev.dreaming.nightly.timer",
      "systemctl --user daemon-reload",
    ]);
  });

  it("cron: installs into an empty crontab and reports status", async () => {
    responses.set("crontab -l", { code: 1, stdout: "", stderr: "crontab: no crontab for sam" });
    await installSchedule("cron", localSpec(), host);
    expect(calls.at(-1)).toEqual({ bin: "crontab", args: ["-"], input: cronBlock(localSpec()) });

    responses.set("crontab -l", { code: 0, stdout: cronBlock(localSpec()), stderr: "" });
    expect(await scheduleStatus("cron", spec.label, host)).toEqual({
      backend: "cron",
      installed: true,
      active: null,
      location: "crontab",
    });
    expect(await uninstallSchedule("cron", spec.label, host)).toBe(true);
    expect(calls.at(-1)?.input).toBe("");
  });

  it("cron: a failing `crontab -l` is an error, not an empty crontab", async () => {
    responses.set("crontab -l", { code: 1, stdout: "", stderr: "crontab: permission denied" });
    await expect(installSchedule("cron", localSpec(), host)).rejects.toThrow(
      /crontab -l failed \(exit 1\): crontab: permission denied/,
    );
    expect(commands()).toEqual(["crontab -l"]);
  });

  it("reports nothing to uninstall when nothing is installed", async () => {
    responses.set("launchctl print gui/501/dev.dreaming.nightly", { code: 113, stdout: "", stderr: "" });
    expect(await uninstallSchedule("launchd", spec.label, host)).toBe(false);
    expect(await scheduleStatus("launchd", spec.label, host)).toMatchObject({ installed: false, active: false });
  });
});
