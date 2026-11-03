# dreaming

Your coding agent proposes changes to its own memory each night; you measure them, check them against everything else it remembers, and review them like a pull request.

![A terminal recording of dreaming eval: the replay of a recorded evaluation of one proposed memory. Thirty real agent runs fill a grid task by task, with and without the memory; the interval for the change narrows as runs finish, and the verdict flags that the memory breaks the repository's lint in every run.](shots/v3/eval.svg)

<sub><b>Recorded, replayed.</b> This is <code>dreaming eval --replay</code> on <code>demo/recorded/evals</code>: 30 real <code>claude -p</code> runs (Claude Code 2.1.281, Sonnet 5) made on 2 November 2026 by <code>scripts/record-evals.mjs</code>, on a synthetic repository, shown at 12× through the same renderer the live command uses. The proposed memory, "Sam prefers tabs", cites a quote nobody said; measured, it makes the agent break the repository's two-space lint in every run. Run it live with <code>dreaming eval</code> under your own login.</sub>

Coding agents such as Claude Code keep long-term memory as plain files that are loaded into every session. Those files are either written by hand, which goes stale, or written by the agent unsupervised, which accumulates guesses nobody checked. dreaming sits between the two. After you log off, a headless agent with read-only tools re-reads the day's sessions and proposes what memory should learn, correct or forget, citing quotes that dreaming checks against the transcripts. Then dreaming does two things no memory system does for you: it **measures** a proposal, by running a task suite with and without it in isolated agent sessions and reporting the change in pass rate, turns and tokens with honest intervals; and it **checks** every proposal for contradictions with the rest of your memory, with a small language-inference model running on your machine. In the morning you approve, edit or reject, with all of that beside each proposal. Only approved changes are written, with a backup and an audit trail. The agent proposes; the evidence is checked; a person approves.

## Memory you can measure

A memory is an instruction your agent will follow in every session from now on. dreaming treats a proposed one the way you would treat a code change: it runs the tests.

```sh
dreaming eval prefers-tabs --suite demo/suites/tidepool
```

**The experiment.** A task suite is a template repository, a few everyday tasks, and for each task a check the agent never sees. dreaming runs every task the same number of times in two arms: **without** the proposal (the memory directory as it is now) and **with** it (the same directory with the proposal applied by the same planner the real apply uses, so the agent sees exactly what approving would write). The arms differ in nothing else: same prompts, same model, same fresh copy of the repository, in a seeded random order so time-of-day drift falls on both. Each run is a real `claude -p` session; afterwards the task's check decides pass or fail and says why ("ran npm install (1×), which breaks the workspace links"). An eval makes at most 30 runs.

**The statistics** are chosen for small samples, because 30 runs is a small sample:

- each arm's pass rate gets the **Clopper–Pearson exact interval** ([Clopper and Pearson, 1934](https://doi.org/10.1093/biomet/26.4.404)), which never undercovers;
- the change in pass rate gets **Newcombe's hybrid score interval** for a difference of proportions ([Newcombe, 1998](<https://doi.org/10.1002/(SICI)1097-0258(19980430)17:8%3C873::AID-SIM779%3E3.0.CO;2-I>), method 10), which behaves at 0/5 and 5/5 where the textbook interval collapses (it is tested against the paper's worked examples);
- each task is its own comparison, so a task counts as moved only when **Fisher's exact test** ([Fisher, 1922](https://doi.org/10.2307/2340521)) is below 0.05/k and its interval, made **simultaneous** at 1 − 0.05/k with a Bonferroni correction ([Dunn, 1961](https://doi.org/10.1080/01621459.1961.10482090)), clears zero. With three tasks that is 98.3% each, so a chance "effect" on one of them does not turn up one eval in seven. Both rules were added after the real runs showed why: a tabs memory "helped" a package-manager task by 0/5 → 3/5, and in another batch "hurt" it by 5/5 → 1/5, where the approximate interval clears zero and the exact test (p = 0.048) does not;
- turns, tokens and time get a **stratified percentile bootstrap** of the difference in means ([Efron, 1979](https://doi.org/10.1214/aos/1176344552)), resampled within each task, with a seeded generator so a replay prints the same numbers.

The approach follows [Miller (2024), "Adding Error Bars to Evals"](https://arxiv.org/abs/2411.00640): report the interval, not the point; compare arms on the same questions; plan for the sample you can afford. A memory is flagged **worse** when any task moved down by that rule, and **helps** when one moved up; otherwise the verdict is "no measurable effect", with the intervals, because that is what five runs per arm per task can say. The pooled interval across tasks is shown for context but does not decide: it mixes tasks with different base rates.

**What the recorded evals found** (synthetic suite, real runs, 2 November 2026):

| Proposal                                           | Verdict                     | What moved (98.3% simultaneous CI; exact p)                                                            | Per run, with it                      | Cost, time     |
| -------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------- | -------------- |
| `prefer-pnpm.md`, "use pnpm, never npm"            | no measurable effect        | install-and-test 4/5 → 5/5 (p = 1.0): the baseline already used pnpm, hinted by `release-checklist.md` | 0.4 fewer turns (95% CI −0.8 to −0.1) | $0.72, 3.7 min |
| `prefers-tabs.md`, which cites a quote nobody said | **▼ makes high-tide worse** | high-tide 5/5 → 0/5 (−100 to −24; p = 0.008): "lint fails: indent with spaces, not tabs" in every run  | 7k more tokens (95% CI +3k to +12k)   | $0.82, 6.2 min |
| `deploy-window.md`, "Tuesdays and Thursdays"       | **▲ helps on deploy-day**   | deploy-day 0/5 → 5/5 (+24 to +100; p = 0.008)                                                          | 8k more tokens (95% CI +1k to +15k)   | $0.79, 7.0 min |

**Focused on the task it is about.** Spread over three tasks, `prefer-pnpm.md` shows no measurable effect, because five runs per arm cannot separate it from a noisy baseline. Run with `--tasks install-and-test`, all 30 runs measure that one task (15 per arm; 3 November 2026, `demo/recorded/focused`): **install-and-test 5/15 → 15/15, +67 points (95% CI +34 to +85; exact p = 0.0002)**; per run, 1.5 fewer turns (95% CI −2.3 to −0.6) and 25.8k fewer tokens (95% CI −39.1k to −10.6k); time 71 s → 59 s, an interval that still includes zero (−31 s to +7 s). The eval took 11 minutes and cost $1.35 at API prices, with the same isolation evidence: the control fired, and across the 30 runs there were 0 hook events, 0 canary files and no shim bypass.

The same three evals were run three times, 270 real runs in all (the first two batches with an earlier version of the demo memory, and with the memory passed as an argument rather than a file). Under the rule above, every batch gave the same three verdicts. The noisy task is install-and-test: its without-memory pass rate ran from 0/5 to 5/5 between batches, which is why the shipped tabs eval's 5/5 → 1/5 there (p = 0.048) is not called an effect.

**Isolation, proved rather than assumed.** Eval runs must not touch your setup, and your hooks must not run (yours might play sounds). Every run gets `--safe-mode` (installed plugins, hooks, CLAUDE.md, skills and MCP servers off), `--setting-sources project` (no user or local settings; the temporary repository has none), `--settings` with `disableAllHooks` plus a canary hook on every hook event that would touch a file if any hook ran at all, `--strict-mcp-config`, `--no-session-persistence` (no transcript, so no dream ever reads an eval), an environment built from an allowlist (nothing of your session's variables), a working directory outside your home, and the memory in a mode-0600 file (`--append-system-prompt-file`), never in argv, where any process listing would show it. Then the proof, recorded in every eval:

1. **A positive control.** Before any run, Claude Code starts with the canary hook _enabled_, in an empty, separate config directory (no login, no plugins, no model call). The canary must fire and Claude Code must report the hook events in its stream (`--include-hook-events`); otherwise the eval refuses to start, because a detector that has not been seen to fire proves nothing by staying silent.
2. **Every run**, three independent checks: zero hook events in Claude Code's own stream, no canary file, and zero hooks in its debug log's registry. Any one failing stops the eval.
3. **A process audit**, every 200 ms, of every process descended from each agent, flagging sound players (`afplay`, `say`, `osascript` and the like).
4. **The sandbox held**: every package-manager command in the agent's Bash calls must reach the suite's shims (real `npm` sits in `/opt/homebrew/bin` on macOS and a login shell can put it first); a run where they did not is not counted and stops the eval.

In the recorded evals: the positive control fired (SessionStart, UserPromptSubmit and SessionEnd canaries, four hook events) before each eval; across the 90 runs there were 0 hook events, 0 canary files and 0 registered hooks; 97 package-manager commands produced 88 shim calls and no run bypassed the shims; and 4,573 process samples saw no sound player.

**Writing a suite** for your own project takes a directory:

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

**What an eval cannot tell you.** The suite is what it measures: three synthetic tasks written for these memories, so the results are a demonstration of the method, not of Claude in general. Five runs per arm per task detect only large effects; narrow the suite with `--tasks` to put all 30 runs where the memory matters. Both arms get the memory files appended to the system prompt; Claude Code itself loads the index and reads files on demand, so this is a close stand-in, not the same thing. The cost is real: $0.72 to $0.82 at API prices and four to seven minutes per 30-run eval with Sonnet 5, on a shared and busy laptop, under your own login.

## Contradictions across the memory set

A new memory can be right and still leave an old one saying the opposite. When the v2 API goes live, "keep the /v1 compatibility tests green" becomes wrong, and an agent told both things will follow whichever it read last. `dreaming check` (and every `dreaming run`, when the model is installed) compares each pending proposal, sentence by sentence, with every other memory and every other pending proposal:

1. sentences from different files are paired when they share **at least two content words**, a cheap stand-in for "about the same thing", which contradiction requires ([de Marneffe, Rafferty and Manning, 2008](https://aclanthology.org/P08-1118/));
2. each pair goes **both ways** through a natural-language-inference cross-encoder, [`cross-encoder/nli-deberta-v3-xsmall`](https://huggingface.co/cross-encoder/nli-deberta-v3-xsmall) (DeBERTa-v3, [He, Gao and Chen, 2021](https://arxiv.org/abs/2111.09543), fine-tuned on [SNLI](https://nlp.stanford.edu/projects/snli/) and [MultiNLI](https://aclanthology.org/N18-1101/)), in its int8 ONNX form, running in WebAssembly in Node on your machine: nothing leaves it;
3. a pair is a contradiction when either direction puts 0.8 or more of its probability on "contradiction" (chosen before measuring).

The review shows both sentences side by side, marked inferred: the model is small and the decision is yours.

**How good it is**, on a labelled set of 62 synthetic memory pairs (26 contradictions, 22 compatible, 14 unrelated; `test/fixtures/contradictions.json`, measured by `scripts/contradiction-accuracy.mjs` into `docs/contradiction-accuracy.json`):

|                                                   | Precision | Recall | F1    |
| ------------------------------------------------- | --------- | ------ | ----- |
| As shipped (two shared words, then the threshold) | 0.821     | 0.885  | 0.852 |
| The first version (one shared word)               | 0.758     | 0.962  | 0.847 |
| The classifier alone, every pair (AUROC 0.872)    | 0.619     | 1.000  | 0.765 |

The two-word rule was added after the first version called "Staging key for the tidepool smoke test" a contradiction of "the v1 compatibility tests were removed" (0.99), on the word "test" alone; the labelled set was seen while choosing it, so treat its numbers as optimistic. Its remaining errors are the ones you would expect: the same words about different subjects ("use npm in the legacy billing repo" against "use pnpm in tidepool"), and some entailments read as contradictions.

**The model is a download, done properly.** `dreaming models install` states the size and source first (95.9 MB from huggingface.co, pinned to revision `2a4f614`), asks, shows progress, checks every file's SHA-256 before it is renamed into place, cancels cleanly with Ctrl-C (nothing partial is left behind), and keeps the files already finished for the next attempt. Without the model everything works except this check, and the review and the dream say so. `dreaming models --verify` re-hashes it. The runtime (`onnxruntime-web` and `@huggingface/tokenizers`, about 150 MB) is an optional dependency, loaded only by the check. The model loads in about a second; a check of the demo's five proposals takes about four seconds on a busy laptop.

## The morning review

`dreaming review` is laid out like a pull request. At the top is the list of proposals, one row each, like the changed files of a PR: your decision so far (`○` pending, `✓` approved, `✗` rejected), the action, the file, the memory type, the agent's confidence, how many of its evidence quotes verified, the lines it adds and removes, and the checks' marks: `▲` measured to help, `▼` measured to make something worse, `≠` contradicts another memory. Below it is the selected proposal:

- **Why**: the agent's reason, in one line.
- **Evidence**: each quote with its verdict first (`✓ verified`, `✗ not found`), the session, its working directory and the transcript line, then the transcript's own text for the quoted span. If the agent elided part of a quote with `...`, you see what it left out.
- **Measured**: what `dreaming eval` found, per task (`high-tide 5/5 → 0/5`), with the overall change and its interval, the reason a run failed, and the command to replay it; or how to measure it.
- **Conflicts**: what the contradiction check found, both sentences side by side and marked inferred, and whether the memory has changed since the check; or how to run it.
- **Memory**: the one-line description that goes into `MEMORY.md`.
- **The diff**: every file the approval would touch, line-numbered, with the changed words highlighted, including the pointer line in `MEMORY.md`. Each diff accounts for what you have already approved above it.

| Key                            | Does                                                      |
| ------------------------------ | --------------------------------------------------------- |
| `a` / `r` / `s`                | Approve, reject, skip (leave it in the inbox for later)   |
| `u`                            | Undo the decision                                         |
| `e`                            | Edit the memory in `$EDITOR`; the diff shows your version |
| `→` `n` / `←` `p`              | Next / previous proposal                                  |
| `↓` `j` / `↑` `k`, `space` `b` | Scroll, page                                              |
| `enter`                        | Submit: the combined diff of everything you approved      |
| `?` / `q`                      | All keys / quit (asks before discarding decisions)        |

A proposal measured to make a task worse also gets a warning at the top. Nothing is written until you submit and confirm the combined diff. Approval is refused, with the reason on screen, when evidence did not verify, when two approvals touch the same memory in conflicting ways, or when the file has changed since the agent read it. A proposal that would save a redaction marker such as `[REDACTED:anthropic-key]` into memory is flagged: the agent never saw the secret, so the memory can only hold the placeholder.

`dreaming review --plain` asks about one proposal at a time, line by line, for pipes, scripts and screen readers; it is used automatically when input or output is not a terminal. The full-screen review needs at least 50×14 and says so on anything smaller.

## Where did this memory come from?

```sh
dreaming why prefer-pnpm
```

`dreaming why` reads the audit log and shows every change dreaming made to that memory, oldest first: when, which dream and proposal, the agent's confidence, whether you edited it in review, the reason, and the backup taken before the change. Each evidence quote is checked again, now, against the transcript it came from (`still in the transcript`, `no longer at that line`, `transcript no longer on disk`), with the transcript's path and the command to reopen the session (`claude --resume <id>`). The first lines say whether the file is still exactly what dreaming last wrote or has been edited since. A memory dreaming never touched says so. `--json` prints the same for scripts. The audit log is self-contained, so this works after the inbox has been cleared.

## Quickstart

Requires Node.js 22.13 or newer. From a fresh clone:

```sh
npm ci
npm run demo
```

The demo builds the CLI and runs the whole loop in a temporary directory: synthetic memory files, synthetic sessions (one still active, one with a corrupt line and a pasted credential) and a fake agent in place of Claude. No model is called and nothing outside the temporary directory is touched. It takes a few seconds and shows:

1. `dreaming run --dry-run`: which sessions would be read, which are skipped and why, and the exact agent command.
2. `dreaming run`: five proposals filed in the inbox, one of them citing a quote nobody said, and a warning that the agent's reply contained a secret-shaped string (redacted before filing).
3. `dreaming review`, with answers piped in, so it runs line by line: three proposals approved, the credential rejected, the invented evidence blocked and then rejected, and the combined diff confirmed.
4. The resulting `MEMORY.md`, the audit log, `dreaming why prefer-pnpm`, and a second run that finds nothing new.
5. `dreaming eval --replay` of the recorded eval of `prefers-tabs.md`: 30 real `claude -p` runs from `demo/recorded`, replayed, with no model call now.

If the NLI model is installed (`DREAMING_MODELS` pointing at it), the dream also runs the contradiction check; otherwise it says it skipped it and why.

To make the decisions yourself, in the full-screen review, on the same synthetic data:

```sh
npm run demo -- --try
```

### Use it with Claude Code

You need the `claude` CLI on your PATH and the memory directory you want to curate. Claude Code keeps a project's memory in `~/.claude/projects/<project>/memory/`, where `<project>` is the project's path with `/` replaced by `-`.

```sh
npm run build
npm link                      # puts `dreaming` on your PATH; or run `node dist/cli.js`
dreaming init --memory-dir ~/.claude/projects/-Users-sam-code-tidepool/memory
dreaming                      # what is waiting, and the one thing to do next
dreaming run --dry-run        # what would be read, and the exact command; runs nothing
dreaming run                  # one headless agent session; proposals go to the inbox
dreaming review               # decide, see the exact diff, submit
dreaming why <memory>         # where an applied memory came from
dreaming schedule install --at 02:00
```

A real run costs one headless Claude Code session. Set `agent.model` and `agent.maxBudgetUsd` in the config to control it.

## How it works

```
 ~/.claude/projects/*/*.jsonl
            |
   discover  changed since each session's watermark, quiet for 5 minutes, oldest first, capped
            |
   digest    user and assistant text plus one-line tool-call summaries; injected reminders
            |  removed; secrets redacted; long sessions trimmed from the middle
            |
   agent     claude -p --restricted with Read, Glob and Grep only; prompt on stdin; JSON out
            |
   validate  strict schema; anything else fails the run, keeps the (redacted) output, and
            |  leaves the watermark where it was
            |
   verify    every evidence quote is matched against the message it claims to come from
            |
   inbox     ~/.dreaming/inbox/<run>.json (source of truth) and <run>.md (for reading)
            |
   check     each proposal against every memory, sentence pairs both ways through a local
            |  NLI model; contradictions saved beside the inbox
            |
   eval      (on request) a task suite in isolated claude -p runs, with and without the
            |  proposal; pass rate, turns and tokens with intervals; saved per eval
            |
   review    a PR-style screen: evidence, diffs and a decision per proposal; nothing is
            |  written until you submit the combined diff
            |
   apply     exact diff -> confirm -> backup -> atomic writes -> one audit line per proposal
            |
   why       audit log -> the dream, the reason, the quotes, re-checked against the transcripts
```

**Proposals.** The agent returns JSON: a one-line summary and up to 25 proposals. Each is an `add` (new memory), `update` (replace an existing memory's description, type and body) or `delete`, with a reason, one to five evidence quotes that each name a session (`S1`, `S2`, ...), and a confidence of `low`, `medium` or `high`. The JSON Schema in the prompt is generated from the same zod schema that validates the reply.

**Memory format.** Approved changes are written the way Claude Code reads them: one Markdown file per memory with `name`, `description` and `metadata.type` frontmatter, and one pointer line per memory in `MEMORY.md` (`- [Title](file.md) — description`). An update splices the new description and type into the existing frontmatter text at the positions the YAML parser reports, so every other byte (keys, comments, flow lists, indentation, line endings) is kept; a key the file lacks is added on a new line. Pointer edits keep each line of `MEMORY.md` as it was, including its line ending.

**Files.** Everything dreaming owns lives under `~/.dreaming` (or `$DREAMING_HOME`), with files readable only by you:

| Path                                 | What it is                                                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.json`                        | Validated configuration (see below)                                                                                                             |
| `state.json`                         | The watermark: per transcript, the modification time and number of complete lines last read                                                     |
| `inbox/<run>.json`, `inbox/<run>.md` | One record per run, plus a Markdown view                                                                                                        |
| `runs/<run>/`                        | Prompt, digests and the agent's output (redacted); removed after a successful run                                                               |
| `backups/<apply>/`                   | Copy of the memory directory's Markdown files, taken before each apply                                                                          |
| `evals/<eval>.json`                  | Every eval: plan, isolation evidence, and each run with its outcome, turns, tokens and time; statistics are recomputed from it                  |
| `checks/<run>.json`                  | Contradiction checks for a dream's proposals, with a hash of the memory they were checked against                                               |
| `models/`                            | The NLI model, if installed here (`<id>/<revision>/<file>`)                                                                                     |
| `applied.jsonl`                      | Audit log: one line per applied proposal (when, what, before/after hashes, reason, evidence and the sessions it cites); `dreaming why` reads it |
| `logs/dreaming.log`                  | Output of scheduled runs (launchd and cron)                                                                                                     |

## Design decisions

**The agent never writes.** Read-only access is enforced in layers on the `claude` command line. `--restricted` confines Claude Code's file tools to the run workspace and the memory directory and ignores user and project settings files, so hooks and plugins configured there do not run. `--tools Read,Glob,Grep` means no other built-in tool exists in the session; `--allowedTools` approves only those three; `--permission-mode dontAsk` denies anything unapproved instead of prompting; `--disallowedTools` names the built-in tools that write, execute, fetch or delegate, as a backstop; and `--strict-mcp-config` with no MCP config loads no MCP server. A test asserts the exact argv, and `dreaming run --dry-run` prints it. The only code that writes to the memory directory is the apply step, and it runs only after a person confirms a diff.

**Evidence is checked, not trusted.** Each quote must appear in a single message of the session it cites, starting and ending on word and character boundaries ("safe to deploy" does not verify against "unsafe to deploy", and a match never splits a letter from its accents or an emoji sequence). Matching ignores differences models introduce when copying (whitespace, typographic quotes and dashes, surrounding quotation marks) and accepts `...` between fragments that appear in order within 1,000 characters. Because an elision can drop a word that matters, the reviewer is shown the transcript's own text for the whole matched span, not the agent's rendering of it, together with the transcript line. A proposal with a quote that cannot be found is blocked and cannot be approved without `--allow-unverified`. Verification proves the quote exists; whether the proposal follows from it is still the reviewer's call.

**A strict contract, no repair.** The reply must be one JSON object matching the schema, either bare or as the only content of a single json code fence. dreaming does not search prose for JSON or patch near-misses: a reply that broke the contract is a run someone should look at. The agent's output (redacted) and the prompt are kept in `runs/<run>/`, the exit code is non-zero, and the watermark does not move, so the next run retries the same sessions. The output is saved as soon as the agent exits, so a later failure cannot lose a paid reply.

**A watermark per session, not per run.** `state.json` records each transcript's modification time and number of complete lines when it was last read. A single "last run" timestamp silently loses sessions that were still active during a run, and re-reads whole sessions that were resumed. Per-session marks handle both: active sessions are picked up once they settle, resumed sessions are read from where the last dream stopped, a line still being written is not counted until it is complete, and a run capped by `maxSessions` leaves the rest for the next one.

**Never overwrite a person's edits.** Each update or delete carries the hash of its target as the agent saw it. If the file has changed since, the proposal is blocked as stale. The apply step re-reads every file just before writing and refuses if anything differs from the diff that was shown. Writes are atomic (temp file, fsync, rename), the memory directory is backed up first, and if any write or the audit append fails, every file already written is restored, any partial audit line is removed, and the error says so.

**Idempotent by construction.** Applying compares the desired end state with what is on disk, rather than replaying a log. Re-applying an applied proposal changes nothing and is recorded as `already-applied`. That also covers a crash between writing memory and updating the inbox: the next review shows the proposal as already in place and records it.

**Redaction in both directions.** Session text is redacted before the agent sees it, and every free-text string the agent returns (summary, reasons, descriptions, bodies, quotes) is redacted again before it is stored; names and file targets are restricted to slug and file-name shapes. The patterns cover common credential shapes (cloud, model-provider and SaaS API keys, tokens, JWTs, private keys, bearer and basic auth headers, cookies, URL credentials, `password=`-style assignments) plus long random-looking strings. They favour over-redaction. Quoted values are always redacted in full; an unquoted value that is plainly code is left alone (a type name, a `$VAR` reference, a read from a well-known root such as `process.env`, or a function call such as `z.string()`), since coding sessions are full of them. Every pattern is bounded so a hostile transcript cannot stall a run, and the repository's own files pass the redactor (a test checks). Extra patterns can be added in the config. Redactions in the agent's reply are counted apart from those in the transcripts, and the run says so when there are any: a secret-shaped string the agent wrote is worth knowing about. In review, a proposal that would save a redaction marker into memory is flagged.

**Transcripts are untrusted input.** Sessions can contain text from web pages, files and tool output, including text written to manipulate an agent. The prompt tells the agent that digests are data, not instructions; the agent cannot act on anything it reads; its output is schema-checked; and every change goes past a person. Agent text containing control characters or invisible Unicode (zero-width, bidirectional-override and tag characters) is rejected outright, so nothing can reach a memory file that the reviewer could not see. Terminal output is stripped of escape sequences, and the Markdown inbox puts agent text in code fences, so a previewer never renders an agent-supplied link, image or HTML.

**dreaming does not dream about itself.** The agent runs with `--no-session-persistence`, and any session whose working directory is inside the dreaming home is skipped, so tomorrow's run does not read tonight's prompt.

**Small surface.** Three runtime dependencies (zod for validation, yaml for frontmatter, diff for unified diffs). There is no TUI framework: the full-screen review writes to the terminal directly (raw keys, the alternate screen, whole-frame redraws), and one review model drives both it and `--plain`, so tests drive the same decisions through either front end. Confidence is a three-level label rather than a number, because a model's stated probability is not calibrated and a decimal would suggest it is.

**Any terminal, any width.** Every screen is laid out for the terminal it is in. On a narrow one, list columns drop, text wraps at word breaks under its label, and the live clock shortens rather than wrapping (a wrapped line cannot be redrawn in place). Commands and paths are never cut, because a cut command cannot be pasted and run; the dry run prints the agent command one flag per line, and a test feeds it to `/bin/sh` to prove it reads back as the same arguments. Colour only repeats what the text already says, so with `NO_COLOR` every mark and word stays and only the highlighting goes. The only thing that moves is the elapsed clock while the agent works.

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

Scheduling uses launchd on macOS (`~/Library/LaunchAgents/<label>.plist`), a systemd user timer on Linux when systemd is running (`Persistent=true`, so a missed run happens at the next opportunity), and a marked block in your crontab otherwise. It refuses to run on Windows. The default label is `dev.dreaming.nightly`. The job runs Node and the CLI by absolute path, with a PATH that includes the agent binary's directory, all resolved at install time, because schedulers do not load your shell's PATH. Install refuses if the agent binary cannot be found.

Exit codes: `0` success; `1` failure (agent error, invalid agent output, approved changes that could not be applied, an eval that stopped on an isolation check or was interrupted, I/O); `2` usage or invalid config/environment; `3` the dream was saved but the webhook could not be delivered.

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

**Webhook.** Off by default. When a URL is set, each run that reads sessions posts a summary containing counts only (sessions read, proposals by action); no proposal content, quotes or paths leave the machine. `text` sends `{"text": "..."}`, the shape Slack incoming webhooks accept; `adaptive-card` sends a message with one Adaptive Card, the shape Microsoft Teams Workflows webhooks expect. Both follow the services' documented formats and have not been tested against the live services. The URL must be `https://` (plain `http://` only for localhost), redirects are refused, and error messages show only its origin, because webhook URLs are credentials.

## What the tests prove

The test suite uses synthetic fixtures only and a fake agent binary, so no model is called. Each safety claim above has a test:

| Claim                                                                                                                                             | Where                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| The agent runs restricted, with only Read, Glob and Grep, and no MCP servers                                                                      | `test/agent.test.ts`, "the agent gets read-only tools"                                                        |
| Invalid agent output is an error, the output is kept, earlier watermarks do not move                                                              | `test/run.test.ts`, "failures are explicit"                                                                   |
| Quotes must match whole words in the cited message; elisions show the full source                                                                 | `test/proposals.test.ts`, "evidence verification"                                                             |
| Invisible and control characters in agent output are rejected                                                                                     | `test/proposals.test.ts`, "rejects text hiding"                                                               |
| Secrets are redacted before the agent and before the inbox, quickly, without eating code                                                          | `test/redact.test.ts`, `test/transcripts.test.ts`, `test/proposals.test.ts`, `test/run.test.ts`               |
| Active, resumed, rewritten, half-written and capped sessions are handled exactly                                                                  | `test/transcripts.test.ts`, `test/run.test.ts`                                                                |
| A person's edits are never overwritten                                                                                                            | `test/apply.test.ts`, "conflicts"; `test/review.test.ts`, "conflict"                                          |
| Updates keep other frontmatter exactly as written                                                                                                 | `test/memory.test.ts`, "updating an existing memory"                                                          |
| A failed write or audit append rolls everything back                                                                                              | `test/apply.test.ts`, "failure handling"                                                                      |
| Re-applying is a no-op                                                                                                                            | `test/apply.test.ts`, "is idempotent"                                                                         |
| Agent text cannot control the reviewer's terminal or a Markdown previewer                                                                         | `test/review.test.ts`, "strips terminal escape sequences"; `test/storage.test.ts`, "renders agent text inert" |
| Timeouts, output limits and interrupts stop the agent and everything it started                                                                   | `test/agent.test.ts`, "limits on the agent process"                                                           |
| Scheduler files survive spaces, quotes, `%` and `$` in paths                                                                                      | `test/schedule.test.ts`                                                                                       |
| The review writes nothing until you submit, and applies exactly the diff it showed                                                                | `test/review-screen.test.ts`, `test/review.test.ts`                                                           |
| Conflicting approvals, unverified evidence and stale files block approval, with a reason                                                          | `test/review-screen.test.ts`, `test/review.test.ts`                                                           |
| `why` traces a memory to its dream and re-checks each quote against today's transcript                                                            | `test/why.test.ts`                                                                                            |
| Screens fit narrow terminals; commands are never cut; the dry-run command round-trips through `sh`                                                | `test/review-screen.test.ts`, `test/cli.test.ts`, `test/ui.test.ts`                                           |
| Interval maths matches published values (Clopper–Pearson, Newcombe's worked examples, Fisher, normal quantiles)                                   | `test/eval.test.ts`, "eval statistics"                                                                        |
| A chance difference on one of several tasks is not called an effect; a real one is                                                                | `test/eval.test.ts`, "eval verdicts"                                                                          |
| Eval runs are isolated (exact argv, allowlisted environment), and the hook detector is proved before it is trusted                                | `test/eval.test.ts`, "eval isolation" and "refuses to start when the positive control does not fire"          |
| An eval stops on a reported hook, an unreported one (its canary file), a bypassed sandbox, or a logged-out CLI                                    | `test/eval.test.ts`, "dreaming eval, end to end with a fake agent"                                            |
| The memory never appears in an argument; its file is mode 0600                                                                                    | `test/eval.test.ts`, "never puts the memory in an argument"                                                   |
| Ctrl-C keeps the finished runs; at most 30 runs; sandboxes outside the home directory                                                             | `test/eval.test.ts`                                                                                           |
| The two arms differ in the proposal only                                                                                                          | `test/eval.test.ts`, "differs between arms in the proposal only"                                              |
| The contradiction pipeline pairs, scores both ways and thresholds as described; downloads are hash-checked, cancellable and leave nothing partial | `test/contradict.test.ts`                                                                                     |
| The review shows measurements and conflicts, and notices when memory changed since a check                                                        | `test/review-insight.test.ts`, `test/eval-cli.test.ts`                                                        |
| The repository contains no credential-shaped strings or hidden characters                                                                         | `test/repository.test.ts`                                                                                     |
| The recordings and recorded evals contain no paths from the machine that made them                                                                | `test/repository.test.ts`; the recorders also refuse to write them                                            |
| The recordings render, animate and hold still under reduced motion in Chromium, WebKit and Firefox                                                | `test/browser/assets.spec.ts` (`npm run test:browsers`)                                                       |

## Limits and non-goals

- **Confinement is Claude Code's.** dreaming relies on Claude Code's restricted mode to keep the agent's file tools inside the workspace and memory directory. The flags were checked against the `claude --help` of Claude Code 2.1.281 and the constructed command is tested, but the dream itself was never run live: that would mean reading real transcripts. (`dreaming eval` was run live, on synthetic suites only, under isolation that is proved per run.) Older Claude Code releases may not support every flag; a run then fails with the CLI's error rather than running unconfined.
- **Restricted mode ignores your settings files.** Authentication configured only through settings (an `apiKeyHelper`, for example) does not apply to the dreaming agent; use your normal login or `ANTHROPIC_API_KEY`.
- **Claude Code only, for now.** The agent sits behind a small adapter interface (`src/agent/adapter.ts`: build the command, parse the reply). A Codex adapter (for example `codex exec --sandbox read-only`) is not implemented.
- **The transcript format is not a public API.** Claude Code's session files are parsed defensively and malformed lines are counted and reported, but a format change could reduce what is read.
- **Redaction is pattern-based.** It will miss a secret with no recognisable shape that is too short or too regular to look random. Add patterns for your own formats.
- **One memory directory per config.** Sessions from every project under the transcripts root feed it.
- **No retention policy yet.** Backups and failed-run workspaces accumulate under `~/.dreaming` until you delete them.
- **macOS and Linux.** Windows is untested, and `dreaming schedule` refuses to run there.
- **Provenance covers dreaming's own changes.** `dreaming why` knows what the audit log recorded. A memory edited by hand afterwards is reported as changed, but not what changed; a transcript Claude Code has since deleted is reported as gone.
- **The recording's timing is the recording machine's.** The demo plays back at recorded speed with idle gaps capped; on a busy machine the agent and the first frames look slower than they are (the recorder warns when the load is high).
- **An eval measures its suite.** The demo suite was written around the demo's memories; for your own project you write the tasks and checks (a template repo, a prompt, a script that exits 0 for a pass). Five runs per arm per task only detect large effects, and the verdict says so rather than guessing.
- **Evals cost what Claude costs.** Each run is a real `claude -p` session under your login; the eval reports tokens, time and the API-price cost, and stops at 30 runs.
- **The contradiction model is small.** Precision about 0.82 on the labelled set, which was also used to choose the two-word rule; expect false alarms about the same words in different contexts. It runs in WebAssembly, single-threaded, on the CPU.
- **Not a memory system.** dreaming does not store, retrieve or rank memories; it curates the files your agent already uses.

## Contributing

```sh
npm ci
npm run check     # typecheck, lint, test, npm audit --audit-level=high
npm run demo
```

CI runs the same steps on Linux (Node 22 and 24) and macOS (Node 22), plus the demo, and renders the recorded screens in Chromium, WebKit and Firefox.

The recordings and every screenshot in `shots/` come from the real CLI (`shots/v2` is kept as v2 left it):

```sh
npm run record:v3       # shots/v3: eval.svg, loop.svg and stills/<state>-<size>.svg, from a pseudo-terminal
npm run shoot -- v3     # each still as a 2x PNG, and og.png (1200×630) for the repository's social preview
npm run test:browsers   # every SVG in Chromium, then WebKit, then Firefox; two workers, muted (npx playwright install first)
node scripts/record-evals.mjs --yes   # remake demo/recorded: about 90 real claude -p runs under your login; never in CI
```

The eval recordings are replays of `demo/recorded/evals`, labelled as replays on screen; the dream, the simulated failure states (a leaked hook, a logged-out CLI, Ctrl-C) and the review use fake agents that say `fake-claude` on screen; the contradiction check runs the real model when `~/Personal/.models` holds it.

`scripts/record.mjs` runs each scene in a temporary home directory with the fake agent, drives it with keys only once the screen shows what the step waits for, and plays the result through a headless terminal emulator (xterm.js) to draw SVG. In the animated demo each recorded frame is a group shown only for its own slice of the loop, by a stepped CSS animation, so one frame is painted at a time: no script, about 8 KB gzipped, and a still final frame under `prefers-reduced-motion`. There is no web page, so there is no favicon; `og.png` is for the repository's social preview. TypeScript is strict, ESLint forbids type assertions (data crossing a boundary is parsed with zod instead), and each guard (timeout, limit, validator, redaction rule, lock) has a test that makes it trigger.

Two entries in `package.json` are there for the dependency tree rather than the code: `vite` is pinned to 7 because vitest would otherwise install vite 8, which brings in an MPL-2.0 package, and the `minimatch` override moves ESLint's copy past a published advisory. Every package in the tree is MIT, ISC, BSD or Apache-2.0 licensed, except minimatch and one of its dependencies (BlueOak-1.0.0, a permissive licence), which only ESLint uses. The recording tools are development dependencies only: `@xterm/headless` (MIT) and `@playwright/test` (Apache-2.0).

Use synthetic data only. Never add a real transcript, memory file or credential to the repository, including as a test fixture. Build credential-shaped test strings at runtime from pieces, as the existing tests do; `test/repository.test.ts` fails if any committed file trips the redactor. A new agent adapter must come with a test that asserts its command is read-only.

## License

MIT. Copyright (c) 2026 Harry Freeman.
