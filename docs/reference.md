# Reference

Every command, setting and file dreaming uses. The [README](../README.md) explains what it is for.

## Commands

| Command                                                                                             | Does                                                                                                                          |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `dreaming`                                                                                          | What is waiting, what happened last, and the one thing to do next (or how to start)                                           |
| `dreaming init --memory-dir <dir> [--transcripts <dir>] [--force]`                                  | Write a minimal config                                                                                                        |
| `dreaming run [--dry-run] [--max-sessions <n>]`                                                     | Read new sessions and file proposals                                                                                          |
| `dreaming review [--plain] [--dry-run] [--allow-unverified]`                                        | Decide on proposals and apply the approved ones; `--dry-run` shows the exact diff and writes nothing, decisions included      |
| `dreaming why <memory> [--json]`                                                                    | Every change dreaming made to a memory, with its evidence re-checked                                                          |
| `dreaming eval [<proposal>] [--suite <dir>] [--runs <n>] [--tasks <a,b>] [--model <m>] [--dry-run]` | Measure a proposal: a task suite in isolated `claude -p` runs, with and without it (no proposal: list what has been measured) |
| `dreaming eval --replay <file\|id> [--speed <x>]`                                                   | Replay a recorded eval through the live screen; no model call                                                                 |
| `dreaming check`                                                                                    | Check pending proposals for contradictions with the memory set, with the local NLI model                                      |
| `dreaming models [install] [--verify] [--yes]`                                                      | Where the NLI model is; download it (95.9 MB, hash-checked)                                                                   |
| `dreaming status`                                                                                   | Config, watermark, last run, inbox and schedule                                                                               |
| `dreaming schedule install [--at HH:MM] [--backend launchd\|systemd\|cron] [--print]`               | Install a nightly job; `--print` shows the generated files instead                                                            |
| `dreaming schedule uninstall` / `status`                                                            | Remove or inspect it                                                                                                          |

**Exit codes**: `0` success; `1` failure (agent error, invalid agent output, approved changes that could not be applied, an eval that stopped on an isolation check or was interrupted, I/O); `2` usage or invalid config/environment; `3` the dream was saved but the webhook could not be delivered.

**Scheduling** uses launchd on macOS (`~/Library/LaunchAgents/<label>.plist`), a systemd user timer on Linux when systemd is running (`Persistent=true`, so a missed run happens at the next opportunity), and a marked block in your crontab otherwise. It refuses to run on Windows. The default label is `dev.dreaming.nightly`. The job runs Node and the CLI by absolute path, with a PATH that includes the agent binary's directory, all resolved at install time, because schedulers do not load your shell's PATH. Install refuses if the agent binary cannot be found.

## The review

| Key                            | Does                                                      |
| ------------------------------ | --------------------------------------------------------- |
| `a` / `r` / `s`                | Approve, reject, skip (leave it in the inbox for later)   |
| `u`                            | Undo the decision                                         |
| `e`                            | Edit the memory in `$EDITOR`; the diff shows your version |
| `→` `n` / `←` `p`              | Next / previous proposal                                  |
| `↓` `j` / `↑` `k`, `space` `b` | Scroll, page                                              |
| `enter`                        | Submit: the combined diff of everything you approved      |
| `?` / `q`                      | All keys / quit (asks before discarding decisions)        |

The list at the top has one row per proposal: your decision so far (`○` pending, `✓` approved, `✗` rejected), the action, the file, the memory type, the agent's confidence, how many of its quotes verified, the lines it adds and removes, and the checks' marks (`▲` measured to help, `▼` measured to make something worse, `≠` contradicts another memory). Below it, the selected proposal:

- **Why**: the agent's reason, in one line.
- **Evidence**: each quote with its verdict first (`✓ verified`, `✗ not found`), the session, its working directory and the transcript line, then the transcript's own text for the quoted span. If the agent elided part of a quote with `...`, you see what it left out.
- **Measured**: what `dreaming eval` found, per task (`high-tide 5/5 → 0/5`), with the overall change and its interval, the reason a run failed, and the command to replay it; or how to measure it.
- **Conflicts**: what the contradiction check found, both sentences side by side and marked inferred, and whether the memory has changed since the check; or how to run it.
- **Memory**: the one-line description that goes into `MEMORY.md`.
- **The diff**: every file the approval would touch, line-numbered, with the changed words highlighted, including the pointer line in `MEMORY.md`. Each diff accounts for what you have already approved above it.

A proposal measured to make a task worse also gets a warning at the top. Approval is refused, with the reason on screen, when evidence did not verify, when two approvals touch the same memory in conflicting ways, or when the file has changed since the agent read it. A proposal that would save a redaction marker such as `[REDACTED:anthropic-key]` into memory is flagged: the agent never saw the secret, so the memory can only hold the placeholder.

`dreaming review --plain` asks about one proposal at a time, line by line, for pipes, scripts and screen readers; it is used automatically when input or output is not a terminal. The full-screen review needs at least 50×14 and says so on anything smaller.

## Provenance

`dreaming why <memory>` reads the audit log and shows every change dreaming made to that memory, oldest first: when, which dream and proposal, the agent's confidence, whether you edited it in review, the reason, and the backup taken before the change. Each evidence quote is checked again, now, against the transcript it came from (`still in the transcript`, `no longer at that line`, `transcript no longer on disk`), with the transcript's path and the command to reopen the session (`claude --resume <id>`). The first lines say whether the file is still exactly what dreaming last wrote or has been edited since. A memory dreaming never touched says so. `--json` prints the same for scripts. The audit log is self-contained, so this works after the inbox has been cleared.

## Task suites

A suite for `dreaming eval` is a directory:

```
suite.json   { "name", "about", "repo", "shims"?, "timeoutSeconds"?, "maxTurns"?,
               "tasks": [{ "id", "prompt", "check", "passMeans" }] }
repo/        the template repository, copied fresh for every run
checks/      one script per task: exit 0 is a pass, the first line it prints is the reason;
             it gets EVAL_REPO (the run's copy), EVAL_ANSWER (the agent's final answer)
             and EVAL_LOG (every shim call)
shims/       optional stand-ins put first on the agent's PATH, for tools a check needs to see used
```

`demo/suites/tidepool` is a complete example: three tasks, offline shims for npm, pnpm, npx, yarn and corepack (npm fails exactly as real npm does on pnpm's `workspace:` protocol), and checks the agent never sees.

## Proposals and memory files

The agent returns JSON: a one-line summary and up to 25 proposals. Each is an `add` (new memory), `update` (replace an existing memory's description, type and body) or `delete`, with a reason, one to five evidence quotes that each name a session (`S1`, `S2`, ...), and a confidence of `low`, `medium` or `high`. The JSON Schema in the prompt is generated from the same zod schema that validates the reply.

Approved changes are written the way Claude Code reads them: one Markdown file per memory with `name`, `description` and `metadata.type` frontmatter, and one pointer line per memory in `MEMORY.md` (`- [Title](file.md) — description`). An update splices the new description and type into the existing frontmatter text at the positions the YAML parser reports, so every other byte (keys, comments, flow lists, indentation, line endings) is kept; a key the file lacks is added on a new line. Pointer edits keep each line of `MEMORY.md` as it was, including its line ending.

## Configuration

`~/.dreaming/config.json`. Unknown keys are rejected, so a typo fails loudly instead of being ignored. Paths may start with `~/`.

| Key                                | Default                          | Meaning                                                                           |
| ---------------------------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| `memoryDir`                        | (required)                       | The memory directory to curate                                                    |
| `transcripts.root`                 | `~/.claude/projects`             | Holds one folder of `*.jsonl` sessions per project                                |
| `transcripts.settleMinutes`        | `5`                              | Sessions modified more recently than this are left for later                      |
| `transcripts.lookbackDays`         | `2`                              | How far back the first run looks                                                  |
| `transcripts.maxSessions`          | `20`                             | Sessions per run; the rest wait for the next run                                  |
| `transcripts.maxSessionChars`      | `60000`                          | Digest budget per session; the middle is dropped first                            |
| `transcripts.maxTranscriptBytes`   | `200000000`                      | Larger transcripts are skipped and reported                                       |
| `agent.bin`                        | `claude`                         | Agent CLI                                                                         |
| `agent.model`                      | (CLI default)                    | Passed as `--model`                                                               |
| `agent.timeoutSeconds`             | `1200`                           | The agent, and anything it started, is stopped (SIGTERM, then SIGKILL) after this |
| `agent.maxOutputBytes`             | `5000000`                        | The agent is stopped if it prints more than this                                  |
| `agent.maxBudgetUsd`               | (none)                           | Passed as `--max-budget-usd`                                                      |
| `redaction.extraPatterns`          | `[]`                             | Extra regular expressions to redact                                               |
| `schedule.label` / `schedule.time` | `dev.dreaming.nightly` / `02:00` | Scheduler label and daily time                                                    |
| `webhook.url`                      | (off)                            | Post a run summary (see below)                                                    |
| `webhook.format`                   | `text`                           | `text` or `adaptive-card`                                                         |
| `eval.suite`                       | (none)                           | The task suite `dreaming eval` runs without `--suite`                             |
| `eval.model` / `eval.parallel`     | (CLI default) / `3`              | Model and runs at a time for evals                                                |
| `contradictions.modelDirs`         | `[]`                             | More directories to find the NLI model in (a shared models folder)                |
| `contradictions.threshold`         | `0.8`                            | Probability of "contradiction" needed to show a pair                              |

Environment: `DREAMING_HOME` moves the whole `~/.dreaming` directory; `DREAMING_WEBHOOK_URL` overrides `webhook.url`; `DREAMING_MODELS` is where the NLI model lives and downloads go, instead of `~/.dreaming/models`. All are validated. The agent process receives your environment minus every `DREAMING_*` variable.

A real dream costs one headless Claude Code session; set `agent.model` and `agent.maxBudgetUsd` to control it.

**Webhook.** Off by default. When a URL is set, each run that reads sessions posts a summary containing counts only (sessions read, proposals by action); no proposal content, quotes or paths leave the machine. `text` sends `{"text": "..."}`, the shape Slack incoming webhooks accept; `adaptive-card` sends a message with one Adaptive Card, the shape Microsoft Teams Workflows webhooks expect. Both follow the services' documented formats and have not been tested against the live services. The URL must be `https://` (plain `http://` only for localhost), redirects are refused, and error messages show only its origin, because webhook URLs are credentials.

## Files

Everything dreaming owns lives under `~/.dreaming` (or `$DREAMING_HOME`), with files readable only by you:

| Path                                 | What it is                                                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.json`                        | Validated configuration (see above)                                                                                                             |
| `state.json`                         | The watermark: per transcript, the modification time and number of complete lines last read                                                     |
| `inbox/<run>.json`, `inbox/<run>.md` | One record per run, plus a Markdown view                                                                                                        |
| `runs/<run>/`                        | Prompt, digests and the agent's output (redacted); removed after a successful run                                                               |
| `backups/<apply>/`                   | Copy of the memory directory's Markdown files, taken before each apply                                                                          |
| `evals/<eval>.json`                  | Every eval: plan, isolation evidence, and each run with its outcome, turns, tokens and time; statistics are recomputed from it                  |
| `checks/<run>.json`                  | Contradiction checks for a dream's proposals, with a hash of the memory they were checked against                                               |
| `models/`                            | The NLI model, if installed here (`<id>/<revision>/<file>`)                                                                                     |
| `applied.jsonl`                      | Audit log: one line per applied proposal (when, what, before/after hashes, reason, evidence and the sessions it cites); `dreaming why` reads it |
| `logs/dreaming.log`                  | Output of scheduled runs (launchd and cron)                                                                                                     |
