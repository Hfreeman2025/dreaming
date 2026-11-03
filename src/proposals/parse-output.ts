import { formatIssues, parseJson } from "../fsx.js";
import { DreamOutputSchema, type DreamOutput } from "./schema.js";

const FENCED = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/;

/**
 * Parse the agent's final message. It must be one JSON object, either bare or
 * as the only content of a single ```json fence. Prose around the JSON is
 * rejected rather than searched: a reply that does not follow the contract is
 * a failed run that someone should look at, not something to guess through.
 */
export function parseDreamOutput(text: string): { ok: true; output: DreamOutput } | { ok: false; error: string } {
  const trimmed = text.trim();
  const fenced = FENCED.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  if (!candidate.trimStart().startsWith("{")) {
    return { ok: false, error: "the reply is not a JSON object (expected the reply to start with '{')" };
  }
  const json = parseJson(candidate);
  if (!json.ok) return { ok: false, error: `the reply is not valid JSON: ${json.error}` };
  const result = DreamOutputSchema.safeParse(json.value);
  if (!result.success) {
    return { ok: false, error: `the reply does not match the proposal schema:\n${formatIssues(result.error)}` };
  }
  return { ok: true, output: result.data };
}
