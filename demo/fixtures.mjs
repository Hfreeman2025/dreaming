// Synthetic data for the demo: a fictional developer, Sam, working on "tidepool",
// a tide-prediction API. Nothing here comes from a real session or a real memory.
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

const memory = (name, description, type, body) =>
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;

export const MEMORY_FILES = {
  "user-role.md": memory(
    "user-role",
    "Sam is a backend engineer on tidepool (TypeScript, Postgres)",
    "user",
    "Sam is a backend engineer on tidepool, a tide-prediction API. Comfortable with TypeScript and Postgres; newer to the front end.",
  ),
  "deploy-window.md": memory(
    "deploy-window",
    "Production deploys happen on Tuesdays only",
    "project",
    "Production deploys go out on Tuesdays only.\n\n**Why:** the on-call rota is staffed for releases on Tuesdays.\n\n**How to apply:** do not suggest a production deploy on any other day.",
  ),
  "release-checklist.md": memory(
    "release-checklist",
    "Before every release, run the /v1 compatibility tests",
    "project",
    "Before every release, run the /v1 compatibility tests and keep them green.\n\n**Why:** partner apps still depend on /v1.\n\n**How to apply:** run `pnpm test:v1-compat` before tagging a release.",
  ),
  "api-v2-deadline.md": memory(
    "api-v2-deadline",
    "The v2 API migration is due on 15 November 2026",
    "project",
    "The v2 API migration is due on 15 November 2026. Until then, /v1 endpoints must keep working.\n\n**Why:** two partner apps still call /v1.\n\n**How to apply:** keep /v1 routes and their tests green.",
  ),
};

export const MEMORY_INDEX = [
  "# Memory",
  "",
  "- [Sam's role](user-role.md) — Backend engineer on tidepool (TypeScript, Postgres)",
  "- [Deploy window](deploy-window.md) — Production deploys happen on Tuesdays only",
  "- [API v2 deadline](api-v2-deadline.md) — The v2 API migration is due on 15 November 2026",
  "- [Release checklist](release-checklist.md) — Before every release, run the /v1 compatibility tests",
  "",
].join("\n");

// Built at runtime so no secret-shaped literal sits in the repository.
const FAKE_STAGING_KEY = ["sk", "ant", "api03", "D3M0".repeat(8)].join("-");

const user = (text, at) => ({
  type: "user",
  cwd: "/home/sam/tidepool",
  timestamp: at,
  message: { role: "user", content: text },
});
const assistant = (blocks, at) => ({
  type: "assistant",
  cwd: "/home/sam/tidepool",
  timestamp: at,
  message: { role: "assistant", content: blocks },
});
const say = (text) => ({ type: "text", text });
const tool = (name, input) => ({ type: "tool_use", id: `t-${name}`, name, input });

function sessions(day) {
  const at = (time) => `${day}T${time}:00.000Z`;
  return {
    // Yesterday morning: a correction and a process change.
    "3b9e7c1a-52d4-4f0e-9c61-8a2f4d7e1b03": [
      user("Add a pnpm-workspace entry for the new tides-core package and install it.", at("09:12")),
      assistant([say("I'll add it and run npm install."), tool("Bash", { command: "npm install" })], at("09:13")),
      user("Use pnpm here, not npm. npm install breaks the workspace links in this repo.", at("09:14")),
      assistant([say("Understood. Switching to pnpm."), tool("Bash", { command: "pnpm install" })], at("09:15")),
      user(
        "Also, heads up: the release train changed this week. We deploy on Tuesdays and Thursdays now.",
        at("09:40"),
      ),
      assistant([say("Noted: Tuesday and Thursday deploys.")], at("09:41")),
    ],
    // Yesterday afternoon: a project milestone, a pasted credential, and a damaged line.
    "a41f0d62-9e37-4b85-b2c4-6d1e8f3a7c59": [
      user(
        "The v2 API went live on 30 October; the old /v1 endpoints return 410 now, so we can delete the v1 compatibility tests.",
        at("15:02"),
      ),
      assistant(
        [say("I'll remove the v1 compatibility suite."), tool("Bash", { command: "git rm -r test/v1-compat" })],
        at("15:04"),
      ),
      '{"type":"user","message":{"content":"this line was cut off mid-wri',
      user(`For the smoke test, use the staging key ${FAKE_STAGING_KEY} and hit /v2/tides.`, at("15:20")),
      assistant(
        [say("Running the smoke test against staging."), tool("Bash", { command: "pnpm smoke:staging" })],
        at("15:22"),
      ),
    ],
  };
}

const LIVE_SESSION = "c7d2e855-1f6a-4e93-8b0d-2a5c9e4f6d18";

/** Write the memory directory and transcripts under `root`. Returns their paths. */
export async function writeFixtures(root, now) {
  const memoryDir = join(root, "memory");
  const projectsDir = join(root, "projects");
  const projectDir = join(projectsDir, "-home-sam-tidepool");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  for (const [file, content] of Object.entries(MEMORY_FILES)) await writeFile(join(memoryDir, file), content);
  await writeFile(join(memoryDir, "MEMORY.md"), MEMORY_INDEX);

  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  let hoursAgo = 20;
  for (const [id, entries] of Object.entries(sessions(yesterday))) {
    const path = join(projectDir, `${id}.jsonl`);
    await writeFile(path, entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n");
    const mtime = new Date(now.getTime() - hoursAgo * 3_600_000);
    await utimes(path, mtime, mtime);
    hoursAgo -= 4;
  }
  // A session still in progress: dreaming must leave it alone until it settles.
  await writeFile(
    join(projectDir, `${LIVE_SESSION}.jsonl`),
    JSON.stringify(user("Let me check the flaky tide-table test...", now.toISOString())) + "\n",
  );
  return { memoryDir, projectsDir };
}
