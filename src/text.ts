/* eslint-disable no-control-regex -- these patterns exist to find control characters. */

/** CSI and OSC sequences, then any other two-byte ESC sequence. */
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;
const CONTROL_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const CONTROL_EXCEPT_NEWLINE_TAB_TEST = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const ANY_CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Characters that render as nothing or change how surrounding text is
 * displayed: zero-width and bidi formatting characters, Unicode tag
 * characters (which can smuggle whole sentences invisibly), private-use and
 * unassigned code points, and the Unicode line/paragraph separators.
 */
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cn}\u2028\u2029]/u;
const INVISIBLE_ALL = /[\p{Cf}\p{Co}\p{Cn}\u2028\u2029]/gu;

/**
 * Remove terminal escape sequences, control characters and invisible
 * formatting characters, keeping newlines and tabs. Carriage returns become
 * newlines, so text can never overwrite an earlier part of a terminal line.
 */
export function stripControl(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(ANSI_ESCAPE, "")
    .replace(CONTROL_EXCEPT_NEWLINE_TAB, "")
    .replace(INVISIBLE_ALL, "");
}

/** True if the text has control characters other than newline and tab. */
export function hasControlChars(text: string): boolean {
  return CONTROL_EXCEPT_NEWLINE_TAB_TEST.test(text);
}

/** True if the text has any control character, newlines and tabs included. */
export function hasAnyControlChars(text: string): boolean {
  return ANY_CONTROL.test(text);
}

/** True if the text has characters a reader cannot see (see INVISIBLE). */
export function hasInvisibleChars(text: string): boolean {
  return INVISIBLE.test(text);
}

/** Text that is safe to store and show: no control or invisible characters (newline and tab allowed). */
export function isPlainText(text: string): boolean {
  return !hasControlChars(text) && !hasInvisibleChars(text);
}
