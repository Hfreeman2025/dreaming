import { describe, expect, it } from "vitest";
import { createRedactor } from "../src/redact.js";

const redact = createRedactor();

// Credential-shaped strings are assembled at runtime so that no secret-looking
// literal sits in the repository (secret scanners would flag it on push).
const join = (...parts: string[]) => parts.join("");
const fake = {
  aws: join("AK", "IA", "Q".repeat(16)),
  github: join("gh", "p_", "a1B2".repeat(9)),
  githubPat: join("github", "_pat_", "x".repeat(30)),
  gitlab: join("gl", "pat-", "y".repeat(24)),
  anthropic: join("sk-", "ant-", "api03-", "Z".repeat(30)),
  openai: join("sk-", "proj-", "y".repeat(40)),
  huggingface: join("hf", "_", "k".repeat(34)),
  slack: join("xo", "xb-", "1234567890-abcdefghij"),
  stripe: join("sk", "_live_", "4".repeat(24)),
  sendgrid: join("SG", ".", "a".repeat(22), ".", "b".repeat(43)),
  google: join("AI", "za", "B".repeat(35)),
  googleOauth: join("ya", "29.", "c".repeat(40)),
  npm: join("np", "m_", "C".repeat(36)),
  azureSecret: join("abc", "8Q~", "d".repeat(34)),
  jwt: join("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0", ".", "abcdefghijklmnop"),
  privateKey: join(
    "-----BEGIN ",
    "OPENSSH PRIVATE KEY",
    "-----\n",
    "b3BlbnNzaC1rZXktdjEAAAAA\n",
    "-----END ",
    "OPENSSH PRIVATE KEY",
    "-----",
  ),
  random: join("Xk9fQ2mZp7Lr4Tv8", "Nw1Bc6Hy3Jd5Gs0A"),
};

describe("built-in secret patterns", () => {
  it.each([
    ["aws-access-key-id", `key is ${fake.aws} ok`],
    ["github-token", `export GH=${fake.github}`],
    ["github-token", `use ${fake.githubPat} for ci`],
    ["gitlab-token", `clone with ${fake.gitlab}`],
    ["anthropic-key", `ANTHROPIC ${fake.anthropic}`],
    ["openai-key", `client(${fake.openai})`],
    ["huggingface-token", `hub login ${fake.huggingface}`],
    ["slack-token", `bot ${fake.slack}`],
    ["stripe-key", `charge with ${fake.stripe}`],
    ["sendgrid-key", `mail via ${fake.sendgrid}`],
    ["google-api-key", `maps ${fake.google}`],
    ["google-oauth-token", `gcloud ${fake.googleOauth}`],
    ["npm-token", `//registry.npmjs.org/:_authToken ${fake.npm}`],
    ["azure-client-secret", `client secret ${fake.azureSecret}`],
    ["jwt", `cookie ${fake.jwt}`],
    ["high-entropy", `paste this: ${fake.random} into the form`],
  ])("redacts %s", (kind, input) => {
    const result = redact(input);
    expect(result.text).toContain(`[REDACTED:${kind}]`);
    expect(result.count).toBe(1);
  });

  it("redacts a whole private key block and nothing around it", () => {
    expect(redact(`before\n${fake.privateKey}\nafter`).text).toBe("before\n[REDACTED:private-key]\nafter");
  });

  it("redacts a private key whose END line was cut off by truncation", () => {
    const cut = fake.privateKey.slice(0, fake.privateKey.indexOf("\n-----END"));
    expect(redact(`here: ${cut}`).text).toBe("here: [REDACTED:private-key]");
  });

  it.each([
    [join("Authorization: Bearer ", "abcdefghijklmnop1234"), "Authorization: Bearer [REDACTED:bearer-token]"],
    [join("Authorization: Basic ", "dXNlcjpodW50ZXIyMjI="), "Authorization: Basic [REDACTED:basic-auth]"],
    [join("Coo", "kie: session=", "s3ss10n-v4lue; theme=dark"), join("Coo", "kie: [REDACTED:cookie]")],
    [
      join("postgres://app:", "hunter2hunter2", "@db.internal:5432/x"),
      "postgres://app:[REDACTED:url-password]@db.internal:5432/x",
    ],
    [
      join("dsn https", "://", "0123456789abcdef".repeat(2), "@o1.ingest.example/2"),
      join("dsn https", "://[REDACTED:url-token]@o1.ingest.example/2"),
    ],
    [join("blob?sv=2024&sig=", "AbCdEfGhIjKlMnOpQr%2B", "&se=1"), "blob?sv=2024&sig=[REDACTED:sas-signature]&se=1"],
    [join("mysql --pass", "word ", "'hunter 2'", " -u app"), join("mysql --pass", "word [REDACTED:password] -u app")],
    [join("sshpass", " -p ", "hunter2", " ssh host"), join("sshpass", " -p [REDACTED:password] ssh host")],
  ])("keeps the scheme or header and drops only the secret: %s", (input, expected) => {
    expect(redact(input).text).toBe(expected);
  });

  it.each([
    [join("DB_PASSWORD", "=correct-horse-battery"), "DB_PASSWORD=[REDACTED:password]"],
    [join("password", ': "hunter2"'), 'password: "[REDACTED:password]"'],
    [join('"apiKey"', ': "0123456789abcdef"'), '"apiKey": "[REDACTED:secret]"'],
    [join("client_secret", ": s3cr3t-value-here"), "client_secret: [REDACTED:secret]"],
    [join("AccountKey", "=Zm9vYmFyYmF6cXV4;"), "AccountKey=[REDACTED:secret];"],
    [join("OPENAI_KEY", "=abc123def"), "OPENAI_KEY=[REDACTED:secret]"],
    [join("AZURE_OPENAI_KEY", ": abc123def"), "AZURE_OPENAI_KEY: [REDACTED:secret]"],
  ])("redacts the value of a secret-named assignment: %s", (input, expected) => {
    expect(redact(input).text).toBe(expected);
  });
});

describe("values that look like code but are not", () => {
  // A deterministic pseudo-random base62 string, so the test never depends on chance.
  const pseudoRandom = (length: number) => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let seed = 42;
    return Array.from({ length }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return alphabet[seed % alphabet.length];
    }).join("");
  };

  it.each([
    [join("pass", "word=Summer2024.Winter"), "Summer2024"],
    [join('"pass', 'word": "MyDog.Rex2024"'), "MyDog"],
    [join("DB_", "PASS=Hunter2.Prod"), "Hunter2"],
    [join("client_", "secret: Xk9vQ2", ".Lm3pR8t"), "Xk9vQ2"],
    [join("pass", "word: P@ss(w0rd)!"), "P@ss"],
    [join("pass", 'word: "correct horse battery staple"'), "battery"],
  ])("redacts a real-looking value even when it has dots, brackets or spaces: %s", (input, secretPart) => {
    const result = redact(input);
    expect(result.text).not.toContain(secretPart);
    expect(result.count).toBe(1);
  });

  it("redacts long random strings of any length, including base64 with slashes", () => {
    expect(redact(`blob ${pseudoRandom(300)} end`).text).toBe("blob [REDACTED:high-entropy] end");
    expect(redact(join("aws secret ", "Zk8/mQ2rT9vB4xW7nL1", "pC6yH3dJ5gS0aE/uR")).text).toBe(
      "aws secret [REDACTED:high-entropy]",
    );
  });
});

describe("false positives it avoids", () => {
  it.each([
    "token: z.string(),",
    "const token = randomBytes(8).toString('hex');",
    "password: string;",
    "apiKey: process.env.ANTHROPIC_API_KEY,",
    "DB_PASS=${DB_PASS}",
    "secret: <your secret here>",
    "release(lockPath: string, token: string): Promise<void>",
    "UTF-16 covers the Basic Multilingual Plane directly.",
    "/Users/sam/Projects/TidepoolApp2/src/components/HarborTideChart/index",
    "const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';",
    "We should reduce the token budget for this prompt.",
    "The password reset flow lives in auth/reset.ts.",
    "maxTokens: 4096",
    "token: short",
    "Run npm test before pushing.",
    "See https://example.com/docs/api for details.",
    "Commit 3b9e7c1a52d44f0e9c618a2f4d7e1b03aa11bb22 fixed it.",
    "Session 3b9e7c1a-52d4-4f0e-9c61-8a2f4d7e1b03 is the one.",
    "Rename useDreamingTranscriptWatermarkV2 to something shorter.",
    "getUserProfileByEmailAddressAndTenant2 is slow.",
  ])("leaves ordinary text alone: %s", (input) => {
    expect(redact(input)).toEqual({ text: input, count: 0 });
  });
});

describe("guards", () => {
  it("does not re-redact its own markers", () => {
    const input = join(
      "token=",
      fake.github,
      " and Bear",
      "er abcdefghijklmnop1234 and pg://u:",
      "longsecret@h and ",
      fake.random,
    );
    const once = redact(input).text;
    const twice = redact(once);
    expect(twice.text).toBe(once);
    expect(twice.count).toBe(0);
  });

  it("applies extra patterns from the config", () => {
    const custom = createRedactor(["ACME-[0-9]{6}"]);
    expect(custom("ticket ACME-123456 is internal")).toEqual({
      text: "ticket [REDACTED:custom] is internal",
      count: 1,
    });
  });

  it("counts every secret it replaces", () => {
    expect(redact(`${fake.aws} ${fake.aws} ${fake.npm}`).count).toBe(3);
  });

  it.each([
    ["repeated key words", "pwd.".repeat(1000)],
    ["key words without values", "password_token_secret_".repeat(200)],
    ["unterminated private keys", join("-----BEGIN RSA PRIVATE", " KEY-----\n").repeat(150)],
    ["near-miss URLs", "postgres://user:".repeat(250)],
    ["near-miss assignments", "secret= ".repeat(500)],
    ["long random-looking runs", "aB3".repeat(1500)],
  ])("redacts a hostile 4,000-character message quickly: %s", (_, input) => {
    const started = performance.now();
    redact(input);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
