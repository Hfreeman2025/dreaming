/**
 * Secret redaction for text that leaves a transcript: session digests shown to
 * the agent, and every free-text string the agent returns before it reaches
 * the inbox.
 *
 * The patterns favour over-redaction. A false positive costs a few characters
 * of evidence; a false negative writes a credential into a file a person may
 * share. Already-redacted markers are never matched again, so redaction is
 * idempotent. Every quantifier that can repeat is bounded or linear, so a
 * hostile transcript cannot make redaction run for minutes (see the timing
 * test).
 */

interface Rule {
  kind: string;
  pattern: RegExp;
  /** Replacement; `$<n>` group references are allowed. Defaults to the marker. */
  replacement?: string;
  /**
   * Extra check; the match is left alone when this returns false. Receives
   * the match, its capture groups and the character right after it.
   */
  accept?: (match: string, groups: readonly string[], next: string | undefined) => boolean;
}

export const marker = (kind: string): string => `[REDACTED:${kind}]`;
/** Every marker in a text, as written by {@link marker}. */
export const MARKERS = /\[REDACTED:[A-Za-z0-9_-]{1,40}\]/g;

/** Key names whose values are secrets, in `key = value` / `key: value` / `"key": "value"` form. */
const SECRET_KEY_WORDS =
  "secret|token|api[_-]?key|apikey|access[_-]?key|account[_-]?key|private[_-]?key|client[_-]?secret|credentials?|dsn";
const PASSWORD_KEY_WORDS = ["pass" + "word", "passwd", "passphrase", "pwd"].join("|");
/** A key naming a secret, bounded on both sides so the alternation cannot backtrack catastrophically. */
const keyed = (words: string) => `\\b([A-Za-z0-9_-]{0,40}(?:${words})[A-Za-z0-9_-]{0,40})`;
const ENV_STYLE_NAME = "\\b([A-Z][A-Z0-9_]{0,40}_(?:KEY|AUTH|PASS|DSN))";
/** The separator between key and value, on one line (a quoted key's closing quote included). */
const ASSIGN = `(["']?[ \\t]{0,5}[:=][ \\t]{0,5})`;

/**
 * Transcripts of coding sessions are full of code like `token: z.string()`,
 * `password: string` or `apiKey: process.env.API_KEY`. An unquoted value that
 * is plainly code is left alone: a type name, a variable reference, a
 * placeholder, a read from a well-known configuration root, or a call of a
 * plain identifier. Anything else, and every quoted value, is redacted.
 */
const CODE_VALUE = new RegExp(
  [
    "string|number|boolean|bigint|symbol|undefined|null|unknown|any|never|true|false",
    "\\$\\{?[A-Za-z_]\\w*\\}?", // $VAR, ${VAR}
    "\\*+|x{3,}|\\.{3,}|<[^<>]*>", // ****, xxxx, ..., <placeholder>
    "(?:process\\.env|import\\.meta\\.env|os\\.environ|env|config|settings|options|opts|args|params|secrets|z)(?:\\.[A-Za-z_$][\\w$]*)+(?:\\(.*)?",
    "[A-Za-z_$][\\w$]*\\(.*", // someFunction(...)
  ]
    .map((alternative) => `(?:${alternative})`)
    .join("|"),
  "i",
);
const anchoredCode = new RegExp(`^(?:${CODE_VALUE.source})$`, "i");

/** Rules for `key: value` pairs: double-quoted, single-quoted and bare values. */
function keyedRules(kind: string, key: string, minLength: number, flags: string): Rule[] {
  const replacement = `$1$2${marker(kind)}`;
  return [
    {
      kind,
      // Quoted values are data, never code: redact everything between the quotes.
      pattern: new RegExp(`${key}${ASSIGN}"(?!\\[REDACTED)([^"\\n]{${minLength},200})"`, flags),
      replacement: `$1$2"${marker(kind)}"`,
    },
    {
      kind,
      pattern: new RegExp(`${key}${ASSIGN}'(?!\\[REDACTED)([^'\\n]{${minLength},200})'`, flags),
      replacement: `$1$2'${marker(kind)}'`,
    },
    {
      kind,
      pattern: new RegExp(`${key}${ASSIGN}(?!\\[REDACTED|["'])([^\\s"'\`,;{})\\]]{${minLength},200})`, flags),
      replacement,
      accept: (_match, groups) => !anchoredCode.test(groups[2] ?? ""),
    },
  ];
}

function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Long random-looking tokens with no recognisable prefix. Calibrated so that
 * random base62 strings (about 4.7 bits per character at 32 characters) are
 * caught while long identifiers, hex hashes and UUIDs (3.8-4.2) are not.
 */
/** Share of neighbouring characters that are consecutive code points ("abc", "789"). */
function sequentialShare(text: string): number {
  let sequential = 0;
  for (let i = 1; i < text.length; i += 1) {
    if (text.charCodeAt(i) === text.charCodeAt(i - 1) + 1) sequential += 1;
  }
  return sequential / Math.max(1, text.length - 1);
}

function looksRandom(token: string): boolean {
  if (!/[A-Z]/.test(token) || !/[a-z]/.test(token) || !/[0-9]/.test(token)) return false;
  // Paths are long and mixed-case too; a token with several slashes is a path, not a key.
  if ((token.match(/\//g) ?? []).length > 2) return false;
  // An alphabet or a counting sequence has high entropy but is not random.
  if (sequentialShare(token) > 0.5) return false;
  return shannonEntropy(token.slice(0, 256)) >= 4.4;
}

const BUILT_IN_RULES: readonly Rule[] = [
  {
    kind: "private-key",
    // Complete blocks, and a BEGIN line whose END was cut off by truncation.
    pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|[\s\S]*$)/g,
  },
  { kind: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { kind: "github-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { kind: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai-key", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{30,}/g },
  { kind: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "slack-webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g },
  { kind: "stripe-key", pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}/g },
  { kind: "sendgrid-key", pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "google-oauth-token", pattern: /\bya29\.[A-Za-z0-9_-]{20,}/g },
  { kind: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "azure-client-secret", pattern: /\b[A-Za-z0-9_~.]{3}\dQ~[A-Za-z0-9_~.-]{31,34}/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    kind: "bearer-token",
    pattern: /\b(Bearer)\s{1,5}(?!\[REDACTED)[A-Za-z0-9._~+/-]{16,}=*/g,
    replacement: `$1 ${marker("bearer-token")}`,
  },
  {
    kind: "basic-auth",
    // Base64 credentials contain a digit or a symbol; prose ("Basic Multilingual Plane") does not.
    pattern: /\b(Basic)\s{1,5}(?!\[REDACTED)(?=[A-Za-z]*[0-9+/])[A-Za-z0-9+/]{12,}={0,2}/g,
    replacement: `$1 ${marker("basic-auth")}`,
  },
  {
    kind: "cookie",
    pattern: /\b((?:Set-)?Cookie):[ \t]{0,5}(?!\[REDACTED)[^\r\n]+/gi,
    replacement: `$1: ${marker("cookie")}`,
  },
  {
    kind: "url-password",
    // Credentials in a URL (user, colon, password, then @host): keep the user, drop the password.
    pattern: /\b([a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@]{1,100}):(?!\[REDACTED)[^\s@/]{1,200}@/gi,
    replacement: `$1:${marker("url-password")}@`,
  },
  {
    kind: "url-token",
    // scheme://<long hex key>@host, as in Sentry DSNs.
    pattern: /\b(https?:\/\/)[0-9a-f]{32,}@/gi,
    replacement: `$1${marker("url-token")}@`,
  },
  {
    kind: "sas-signature",
    pattern: /\b(sig)=(?!\[REDACTED)[A-Za-z0-9%+/=]{16,}/gi,
    replacement: `$1=${marker("sas-signature")}`,
  },
  {
    kind: "password",
    // The value given to a password flag, or to the sshpass "-p" option.
    pattern:
      /(--password[=\s]\s{0,5}|\bsshpass\s{1,5}-p\s{0,5})(?!\[REDACTED)("[^"\n]{1,200}"|'[^'\n]{1,200}'|\S{1,200})/g,
    replacement: `$1${marker("password")}`,
  },
  ...keyedRules("password", keyed(PASSWORD_KEY_WORDS), 4, "gi"),
  ...keyedRules("secret", keyed(SECRET_KEY_WORDS), 8, "gi"),
  // Environment-style names: OPENAI_KEY=..., SERVICE_AUTH=..., DB_PASS=...
  ...keyedRules("secret", ENV_STYLE_NAME, 6, "g"),
  {
    kind: "high-entropy",
    // One greedy class with nothing after it: linear time, any length.
    pattern: /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/=_-])/g,
    accept: looksRandom,
  },
];

export interface RedactionResult {
  text: string;
  /** How many secrets were replaced. */
  count: number;
}

export type Redactor = (text: string) => RedactionResult;

/**
 * Build a redactor from the built-in rules plus user patterns from the config.
 * User patterns are validated by the config schema before they get here.
 */
export function createRedactor(extraPatterns: readonly string[] = []): Redactor {
  const rules: Rule[] = [
    ...BUILT_IN_RULES,
    ...extraPatterns.map((source) => ({ kind: "custom", pattern: new RegExp(source, "g") })),
  ];
  return (input) => {
    let text = input;
    let count = 0;
    for (const rule of rules) {
      const replacement = rule.replacement ?? marker(rule.kind);
      text = text.replace(rule.pattern, (...args: unknown[]) => {
        const match = typeof args[0] === "string" ? args[0] : "";
        // replace() passes: match, each group, offset, whole string.
        const offsetAt = args.findIndex((arg, i) => i > 0 && typeof arg === "number");
        const groups = args.slice(1, offsetAt).map((group) => (typeof group === "string" ? group : ""));
        const offset = args[offsetAt];
        const whole = args[offsetAt + 1];
        const next = typeof offset === "number" && typeof whole === "string" ? whole[offset + match.length] : undefined;
        // Leave markers alone, and matches a rule's extra check turns down.
        if (match.startsWith("[REDACTED:") || (rule.accept !== undefined && !rule.accept(match, groups, next))) {
          return match;
        }
        count += 1;
        return replacement.replace(/\$(\d)/g, (_, group: string) => {
          const value = args[Number(group)];
          return typeof value === "string" ? value : "";
        });
      });
    }
    return { text, count };
  };
}
