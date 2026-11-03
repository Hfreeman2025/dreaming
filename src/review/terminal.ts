import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, emitKeypressEvents, type Interface } from "node:readline";
import { DreamingError, errorMessage } from "../errors.js";
import { stripControl } from "../text.js";

/**
 * What the two review front ends need from a terminal. The plain front end
 * reads lines; the full-screen one reads single keys and redraws a frame.
 * Tests supply scripted implementations of these interfaces.
 */

export interface Key {
  name: string;
  ctrl: boolean;
  shift: boolean;
}

export interface PlainIO {
  readonly color: boolean;
  readonly width: number;
  write(text: string): void;
  /** Ask for one line. Resolves `null` when input has ended. */
  ask(prompt: string): Promise<string | null>;
  /** Open `initial` in the person's editor and return what they saved. */
  edit(initial: string, fileName: string): Promise<string>;
}

export interface ScreenIO {
  readonly color: boolean;
  size(): { columns: number; rows: number };
  /** Replace the screen with these (already styled) lines. */
  draw(lines: readonly string[]): void;
  /** The next key press, or `null` when input has ended. */
  key(): Promise<Key | null>;
  edit(initial: string, fileName: string): Promise<string>;
  onResize(listener: () => void): void;
}

/**
 * Agent-written text is printed to a terminal, so it must not be able to
 * move the cursor, rewrite earlier lines or change the window title.
 */
export function sanitizeForTerminal(text: string): string {
  return stripControl(text);
}

export function useColor(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv): boolean {
  return stream.isTTY === true && env.NO_COLOR === undefined && env.TERM !== "dumb";
}

/** `$VISUAL` or `$EDITOR`, split on whitespace (so `code --wait` works). Run directly, never through a shell. */
export function editorCommand(env: NodeJS.ProcessEnv): string[] | null {
  const value = (env.VISUAL ?? env.EDITOR ?? "").trim();
  return value === "" ? null : value.split(/\s+/);
}

type Input = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
type Output = NodeJS.WritableStream & { isTTY?: boolean; columns?: number; rows?: number };

const ALT_SCREEN_ON = "\u001b[?1049h\u001b[?25l";
const ALT_SCREEN_OFF = "\u001b[?25h\u001b[?1049l";

export interface Terminal extends PlainIO, ScreenIO {
  /** True when both ends are terminals, so the full-screen review can run. */
  readonly interactive: boolean;
  startScreen(): void;
  stopScreen(): void;
  close(): void;
}

interface RawKey {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  sequence?: string;
}

export function createTerminal(input: Input, output: Output, env: NodeJS.ProcessEnv): Terminal {
  const color = useColor(output, env);
  const interactive = input.isTTY === true && output.isTTY === true && env.TERM !== "dumb";
  const columns = () => output.columns ?? (Number(env.COLUMNS) || 100);

  // Line input, created on first use. Lines are queued as they arrive so piped input is never lost.
  let lines: Interface | undefined;
  const queued: string[] = [];
  const lineWaiters: ((line: string | null) => void)[] = [];
  let linesEnded = false;
  const lineReader = (): Interface => {
    if (lines) return lines;
    lines = createInterface({ input, terminal: false });
    lines.on("line", (line) => {
      const waiter = lineWaiters.shift();
      if (waiter) waiter(line);
      else queued.push(line);
    });
    lines.on("close", () => {
      linesEnded = true;
      for (const waiter of lineWaiters.splice(0)) waiter(null);
    });
    return lines;
  };
  const echo = (line: string | null) => {
    // With piped input nothing echoes the answer; print it so a log reads naturally.
    if (input.isTTY !== true && line !== null) output.write(`${line}\n`);
    return line;
  };

  // Key input for the full-screen review.
  const keys: Key[] = [];
  const keyWaiters: ((key: Key | null) => void)[] = [];
  let keysEnded = false;
  let screenOn = false;
  let keysAttached = false;
  const onKeypress = (text: string | undefined, key: RawKey | undefined) => {
    const event: Key = { name: key?.name ?? text ?? "", ctrl: key?.ctrl === true, shift: key?.shift === true };
    const waiter = keyWaiters.shift();
    if (waiter) waiter(event);
    else keys.push(event);
  };
  const onEnd = () => {
    keysEnded = true;
    for (const waiter of keyWaiters.splice(0)) waiter(null);
  };
  // Whatever happens, never leave the person's terminal in raw mode or on the alternate screen.
  const restore = () => {
    if (!screenOn) return;
    input.setRawMode?.(false);
    output.write(ALT_SCREEN_OFF);
    screenOn = false;
  };

  const terminal: Terminal = {
    color,
    interactive,
    get width() {
      return columns();
    },
    write: (text) => output.write(text),
    ask(prompt) {
      lineReader();
      output.write(prompt);
      const line = queued.shift();
      if (line !== undefined) return Promise.resolve(echo(line));
      if (linesEnded) return Promise.resolve(null);
      return new Promise((resolve) =>
        lineWaiters.push((value) => {
          resolve(echo(value));
        }),
      );
    },
    size: () => ({ columns: columns(), rows: output.rows ?? (Number(env.LINES) || 30) }),
    draw(frame) {
      output.write(`\u001b[H${frame.map((line) => `${line}\u001b[K`).join("\r\n")}\u001b[J`);
    },
    key() {
      const key = keys.shift();
      if (key) return Promise.resolve(key);
      if (keysEnded) return Promise.resolve(null);
      return new Promise((resolve) => keyWaiters.push(resolve));
    },
    onResize(listener) {
      output.on("resize", listener);
    },
    startScreen() {
      if (!keysAttached) {
        emitKeypressEvents(input);
        input.on("keypress", onKeypress);
        input.on("end", onEnd);
        keysAttached = true;
      }
      input.setRawMode?.(true);
      input.resume();
      output.write(ALT_SCREEN_ON);
      screenOn = true;
      process.once("exit", restore);
    },
    stopScreen() {
      restore();
      process.off("exit", restore);
      input.pause();
    },
    async edit(initial, fileName) {
      const [bin, ...args] = editorCommand(env) ?? [];
      if (bin === undefined) throw new DreamingError("no editor configured; set $VISUAL or $EDITOR to edit proposals");
      const dir = await mkdtemp(join(tmpdir(), "dreaming-edit-"));
      const path = join(dir, fileName);
      await writeFile(path, initial, { mode: 0o600 });
      const wasScreen = screenOn;
      if (wasScreen) terminal.stopScreen();
      lines?.pause();
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          const child = spawn(bin, [...args, path], { stdio: "inherit" });
          child.on("error", reject);
          child.on("close", resolve);
        }).catch((error: unknown) => {
          throw new DreamingError(`could not start the editor '${bin}': ${errorMessage(error)}`);
        });
        if (code !== 0) throw new DreamingError(`the editor exited with code ${String(code)}; the edit was discarded`);
        return await readFile(path, "utf8");
      } finally {
        lines?.resume();
        if (wasScreen) terminal.startScreen();
        await rm(dir, { recursive: true, force: true });
      }
    },
    close() {
      restore();
      process.off("exit", restore);
      input.off("keypress", onKeypress);
      input.off("end", onEnd);
      lines?.close();
    },
  };
  return terminal;
}
