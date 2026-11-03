/* eslint-disable no-control-regex -- matching terminal escape sequences is the point. */
// Run a command in a real pseudo-terminal (via ptyrun.py) and record what it
// draws, with timestamps, as asciinema v2 events. Keys are sent only after the
// screen shows what the step waits for, so recordings do not depend on how
// fast the machine is.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const KEYS = {
  enter: "\r",
  escape: "\u001b",
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
  space: " ",
  "ctrl-c": "\u0003",
};

const strip = (text) =>
  text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[()][A-Z0-9]|\u001b[@-_]/g, "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * steps: { wait: "text" } | { pause: ms } | { key: "a" | "enter" | ... } | { type: "text" } | { mark: "name" }
 * Returns { events, duration } with event times relative to the start.
 */
export async function recordSession({ argv, env, cwd, cols, rows, steps = [], timeoutMs = 60_000 }) {
  const relay = fileURLToPath(new URL("./ptyrun.py", import.meta.url));
  const child = spawn("python3", [relay, String(cols), String(rows), ...argv], {
    cwd,
    env: {
      ...env,
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      COLUMNS: String(cols),
      LINES: String(rows),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const started = performance.now();
  const at = () => (performance.now() - started) / 1000;
  const events = [];
  let seen = "";
  // One decoder for the whole stream: a character split across two chunks must not become two "�".
  const decoder = new StringDecoder("utf8");
  child.stdout.on("data", (chunk) => {
    const text = decoder.write(chunk);
    if (text === "") return;
    events.push([at(), "o", text]);
    seen += strip(text);
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));

  const deadline = Date.now() + timeoutMs;
  for (const step of steps) {
    if (step.wait !== undefined) {
      while (!seen.includes(step.wait)) {
        if (Date.now() > deadline) {
          child.kill("SIGKILL");
          throw new Error(
            `timed out waiting for "${step.wait}" in: ${argv.join(" ")}\n--- seen ---\n${seen.slice(-2000)}\n--- stderr ---\n${stderr}`,
          );
        }
        await sleep(25);
      }
      seen = "";
    } else if (step.pause !== undefined) {
      await sleep(step.pause);
    } else if (step.mark !== undefined) {
      await sleep(150); // let the last redraw land
      events.push([at(), "m", step.mark]);
    } else if (step.key !== undefined) {
      child.stdin.write(KEYS[step.key] ?? step.key);
    } else if (step.type !== undefined) {
      child.stdin.write(step.type);
    }
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(1000, deadline - Date.now()));
  const code = await exited;
  clearTimeout(timer);
  child.stdin.end();
  return { events, duration: at(), code };
}

/** Join recorded sessions into one cast, typing each command at a shell prompt and capping idle gaps. */
export function castFromTape(tape, { cols, rows, title, idleCap = 2.5, typeDelay = 0.045 }) {
  const header = {
    version: 2,
    width: cols,
    height: rows,
    timestamp: 1793520000,
    title,
    env: { TERM: "xterm-256color", SHELL: "/bin/zsh" },
  };
  const out = [];
  let clock = 0;
  for (const segment of tape) {
    if (segment.prompt !== undefined) {
      out.push([clock, "o", "\u001b[1;36m$\u001b[0m "]);
      clock += 0.35;
      for (const char of segment.prompt) {
        out.push([clock, "o", char]);
        clock += typeDelay;
      }
      clock += 0.25;
      out.push([clock, "o", "\r\n"]);
      clock += 0.05;
      continue;
    }
    if (segment.pause !== undefined) {
      clock += segment.pause / 1000;
      continue;
    }
    let previous = 0;
    for (const [t, kind, data] of segment.events) {
      clock += Math.min(idleCap, Math.max(0, t - previous));
      previous = t;
      out.push([Number(clock.toFixed(3)), kind, data]);
    }
  }
  return `${[JSON.stringify(header), ...out.map((event) => JSON.stringify(event))].join("\n")}\n`;
}

export { strip };
