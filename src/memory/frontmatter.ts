import { isMap, isScalar, parseDocument, stringify } from "yaml";
import { z } from "zod";
import { errorMessage } from "../errors.js";

/**
 * Memory files are Markdown with YAML frontmatter, as Claude Code writes them:
 *
 *   ---
 *   name: prefer-small-prs
 *   description: One-line summary used for recall
 *   metadata:
 *     type: feedback
 *   ---
 *
 *   The fact. **Why:** ... **How to apply:** ...
 *
 * New files are written in exactly this shape. Updates splice new values
 * into the existing frontmatter text, so everything else is kept byte for byte.
 */

export type Frontmatter = Record<string, unknown>;

export interface MemoryDocument {
  frontmatter: Frontmatter;
  /** The frontmatter exactly as written, without the --- fences. */
  rawFrontmatter: string;
  body: string;
}

const FrontmatterObject = z.record(z.string(), z.unknown());

const KnownFields = z.looseObject({
  name: z.string().optional(),
  description: z.string().optional(),
  type: z.string().optional(),
  metadata: z.looseObject({ type: z.string().optional() }).optional(),
});

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export type ParseResult = { ok: true; doc: MemoryDocument } | { ok: false; error: string };

export function parseMemoryDocument(text: string): ParseResult {
  const match = FRONTMATTER.exec(text);
  if (match === null) return { ok: false, error: "missing YAML frontmatter (the file must start with ---)" };
  const rawFrontmatter = match[1] ?? "";
  // logLevel "silent" keeps warnings off the terminal; errors are checked explicitly.
  const parsedDoc = parseDocument(rawFrontmatter, { logLevel: "silent" });
  const [firstError] = parsedDoc.errors;
  if (firstError !== undefined) return { ok: false, error: `frontmatter is not valid YAML: ${firstError.message}` };
  let data: unknown;
  try {
    data = parsedDoc.toJS();
  } catch (error) {
    return { ok: false, error: `frontmatter is not valid YAML: ${errorMessage(error)}` };
  }
  const object = FrontmatterObject.safeParse(data ?? {});
  if (!object.success) return { ok: false, error: "frontmatter must be a YAML mapping" };
  const body = text.slice(match[0].length).replace(/^\r?\n/, "");
  return { ok: true, doc: { frontmatter: object.data, rawFrontmatter, body } };
}

export interface MemoryFields {
  name: string | undefined;
  description: string | undefined;
  type: string | undefined;
}

export function memoryFields(frontmatter: Frontmatter): MemoryFields {
  const known = KnownFields.safeParse(frontmatter);
  if (!known.success) return { name: undefined, description: undefined, type: undefined };
  return {
    name: known.data.name,
    description: known.data.description,
    type: known.data.metadata?.type ?? known.data.type,
  };
}

const assemble = (yaml: string, body: string): string => `---\n${yaml.replace(/\n*$/, "\n")}---\n\n${body.trim()}\n`;

/** A new memory file. */
export function renderNewMemory(fields: { name: string; description: string; type: string; body: string }): string {
  // lineWidth 0: never fold long values; other tools read these files line by line.
  const yaml = stringify(
    { name: fields.name, description: fields.description, metadata: { type: fields.type } },
    { lineWidth: 0 },
  );
  return assemble(yaml, fields.body);
}

/** A file from frontmatter text as a person wrote it, plus a body. */
export function renderWithRawFrontmatter(rawFrontmatter: string, body: string): string {
  return assemble(rawFrontmatter, body);
}

function readsBackAsItself(value: string): boolean {
  const doc = parseDocument(value, { logLevel: "silent" });
  if (doc.errors.length > 0 || doc.warnings.length > 0) return false;
  try {
    return doc.toJS() === value;
  } catch {
    return false; // not representable as plain YAML: it must be quoted
  }
}

/** YAML text for a string value: plain when that reads back as the same string, else double-quoted. */
export function scalarText(value: string): string {
  const plain = readsBackAsItself(value) && value.trim() === value && !value.includes(": ") && !value.includes(" #");
  return plain ? value : JSON.stringify(value);
}

interface Splice {
  start: number;
  end: number;
  text: string;
}

type UpdateResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Apply an update to an existing memory file: set `description` and the type
 * (under `metadata`, or at the top level in older files that keep it there)
 * and replace the body. The new values are spliced into the original
 * frontmatter text at the positions the parser reports, so every other byte
 * (keys, comments, flow lists, indentation, line endings) is kept. A missing
 * key is added on a new line. A file with no frontmatter gets a fresh one;
 * frontmatter that cannot be edited this way is an error for a person.
 */
export function updateMemoryText(
  current: string,
  update: { name: string; description: string; type: string; body: string },
): UpdateResult {
  const match = FRONTMATTER.exec(current);
  if (match === null) return { ok: true, text: renderNewMemory(update) };
  const raw = match[1] ?? "";
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  // The failsafe schema reads every scalar as a string; nothing is converted.
  const doc = parseDocument(raw, { schema: "failsafe", logLevel: "silent" });
  const [firstError] = doc.errors;
  if (firstError !== undefined)
    return { ok: false, error: `its frontmatter is not valid YAML (${firstError.message})` };
  if (!isMap(doc.contents)) return { ok: false, error: "its frontmatter is not a YAML mapping" };

  const splices: Splice[] = [];
  const appended: string[] = [];
  const replace = (node: unknown, value: string): boolean => {
    if (!isScalar(node) || node.range == null) return false;
    const [start, end] = node.range;
    // A block scalar's range ends with its line break; keep it.
    const trailing = /\r?\n$/.exec(raw.slice(start, end))?.[0] ?? "";
    splices.push({ start, end, text: scalarText(value) + trailing });
    return true;
  };
  const refuse = (what: string): UpdateResult => ({ ok: false, error: `its frontmatter ${what}; edit it by hand` });

  const description = doc.get("description", true);
  if (description === undefined) appended.push(`description: ${scalarText(update.description)}`);
  else if (!replace(description, update.description)) return refuse("'description' is not a single value");

  const metadata = doc.get("metadata", true);
  if (metadata !== undefined) {
    if (!isMap(metadata) || metadata.flow === true) return refuse("'metadata' is not a block mapping");
    const type = metadata.get("type", true);
    if (type !== undefined) {
      if (!replace(type, update.type)) return refuse("'metadata.type' is not a single value");
    } else {
      // Add `type` after the mapping's last entry, indented like its first key.
      const firstKey = metadata.items[0]?.key;
      const last = metadata.items.at(-1);
      const lastNode = isScalar(last?.value) || isMap(last?.value) ? last.value : last?.key;
      const keyStart = isScalar(firstKey) ? firstKey.range?.[0] : undefined;
      const anchor = isScalar(lastNode) || isMap(lastNode) ? lastNode.range?.[1] : undefined;
      if (keyStart === undefined || anchor === undefined) return refuse("'metadata' has an unexpected shape");
      const indent = raw.slice(raw.lastIndexOf("\n", keyStart - 1) + 1, keyStart);
      const lineEnd = raw.indexOf("\n", anchor - 1);
      const at = lineEnd === -1 ? raw.length : raw[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
      splices.push({ start: at, end: at, text: `${eol}${indent}type: ${scalarText(update.type)}` });
    }
  } else if (doc.has("type")) {
    if (!replace(doc.get("type", true), update.type)) return refuse("'type' is not a single value");
  } else {
    appended.push("metadata:", `  type: ${scalarText(update.type)}`);
  }

  let edited = raw;
  for (const splice of splices.sort((a, b) => b.start - a.start)) {
    edited = edited.slice(0, splice.start) + splice.text + edited.slice(splice.end);
  }
  if (appended.length > 0) edited = `${edited.replace(/\r?\n$/, "")}${eol}${appended.join(eol)}`;
  const body = update.body.trim().replace(/\r?\n/g, eol);
  return { ok: true, text: `---${eol}${edited}${eol}---${eol}${eol}${body}${eol}` };
}
