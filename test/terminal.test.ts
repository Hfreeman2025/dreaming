import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createTerminal, editorCommand, sanitizeForTerminal, useColor } from "../src/review/terminal.js";

describe("terminal I/O", () => {
  it("splits $VISUAL or $EDITOR on whitespace and runs it without a shell", () => {
    expect(editorCommand({ EDITOR: "code --wait" })).toEqual(["code", "--wait"]);
    expect(editorCommand({ VISUAL: "vim", EDITOR: "nano" })).toEqual(["vim"]);
    expect(editorCommand({ EDITOR: "  " })).toBeNull();
    expect(editorCommand({})).toBeNull();
  });

  it("refuses to edit when no editor is configured, instead of guessing one", async () => {
    const io = createTerminal(Readable.from([]), new PassThrough(), {});
    await expect(io.edit("text", "x.md")).rejects.toThrow("no editor configured; set $VISUAL or $EDITOR");
    io.close();
  });

  it("reads piped answers in order, echoes them, and reports the end of input", async () => {
    const output = new PassThrough();
    let printed = "";
    output.on("data", (chunk: Buffer) => (printed += chunk.toString()));
    const io = createTerminal(Readable.from(["a\nr\n"]), output, {});
    expect(await io.ask("1? ")).toBe("a");
    expect(await io.ask("2? ")).toBe("r");
    expect(await io.ask("3? ")).toBeNull();
    expect(printed).toBe("1? a\n2? r\n3? ");
    io.close();
  });

  it("uses colour only on a TTY, and never with NO_COLOR or TERM=dumb", () => {
    expect(useColor({ isTTY: true }, {})).toBe(true);
    expect(useColor({ isTTY: false }, {})).toBe(false);
    expect(useColor({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    expect(useColor({ isTTY: true }, { TERM: "dumb" })).toBe(false);
  });

  it("reads single keys in raw mode, restores the terminal on stop, and redraws whole frames", async () => {
    const rawCalls: boolean[] = [];
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      rawCalls,
      setRawMode(mode: boolean) {
        rawCalls.push(mode);
      },
    });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    let printed = "";
    output.on("data", (chunk: Buffer) => (printed += chunk.toString()));
    const term = createTerminal(input, output, {});
    expect(term.interactive).toBe(true);
    expect(term.size()).toEqual({ columns: 80, rows: 24 });
    term.startScreen();
    input.write("a");
    input.write("\u001b[C"); // right arrow
    expect(await term.key()).toMatchObject({ name: "a" });
    expect(await term.key()).toMatchObject({ name: "right" });
    term.draw(["one", "two"]);
    term.stopScreen();
    term.close();
    expect(input.rawCalls).toEqual([true, false]);
    expect(printed).toContain("\u001b[?1049h"); // alternate screen on
    expect(printed).toContain("\u001b[Hone\u001b[K\r\ntwo\u001b[K\u001b[J");
    expect(printed.endsWith("\u001b[?25h\u001b[?1049l")).toBe(true); // cursor back, screen restored
  });

  it("is not interactive when output is piped, so the plain review is used", () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    expect(createTerminal(input, new PassThrough(), {}).interactive).toBe(false);
  });

  it("strips escape sequences, control characters and invisible formatting, and turns CR into LF", () => {
    expect(sanitizeForTerminal("a\u001b]0;title\u0007b\u001b[2Kc\rd\u202ee\u200bf\tg")).toBe("abc\ndef\tg");
  });
});
