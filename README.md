# dreaming

[![Harry Freeman](docs/brand/hf-badge.svg)](https://harryfreeman.dev)

dreaming lets a coding agent propose changes to its own long-term memory, and makes each proposal earn its place before a person approves it. Agents such as Claude Code load plain memory files into every session: written by hand they go stale, and written by the agent unsupervised they collect guesses nobody checked. After you log off, dreaming has a headless agent with read-only tools re-read the day's sessions and propose what memory should learn, correct or forget, citing quotes that dreaming checks against the transcripts. It can then **measure** a proposal, by running a task suite with and without it in isolated agent sessions and reporting the change in pass rate, turns and tokens with honest intervals, and **check** it for contradictions with everything else the agent remembers, using a small language-inference model on your machine. In the morning you review it all like a pull request. Only what you approve is written, with a backup and an audit trail.

![A terminal recording of dreaming eval: the replay of a recorded evaluation of one proposed memory. Thirty real agent runs fill a grid task by task, with and without the memory; the interval for the change narrows as runs finish, and the verdict flags that the memory breaks the repository's lint in every run.](shots/measure/eval.svg)

<sub><b>Recorded, replayed.</b> This is <code>dreaming eval --replay</code> on <code>demo/recorded/evals</code>: 30 real <code>claude -p</code> runs (Claude Code 2.1.281, Sonnet 5) made on 2 November 2026 by <code>scripts/record-evals.mjs</code>, on a synthetic repository, shown at 12× through the same renderer the live command uses. The proposed memory, "Sam prefers tabs", cites a quote nobody said; measured, it makes the agent break the repository's two-space lint in every run.</sub>

## Try it

Requires Node.js 22.13 or newer. From a clone:

```sh
npm ci
npm run demo            # the whole loop on synthetic data, with a fake agent
npm run demo -- --try   # the same, with you making the decisions in the full-screen review
```

The demo builds the CLI and runs everything in a temporary directory: synthetic memory files, synthetic sessions (one still active, one with a corrupt line and a pasted credential) and a fake agent in place of Claude. It shows a dry run, a dream that files five proposals (one citing a quote nobody said), the review with the invented evidence blocked, the resulting memory and audit log, `dreaming why`, and a replay of a recorded eval. No model is called and nothing outside the temporary directory is touched.

What each part needs:

- **The demo and the tests** need nothing beyond `npm ci`.
- **`dreaming run` and `dreaming eval`** need the `claude` CLI, logged in. Each dream is one headless Claude Code session, and each eval run is another, under your login, so they cost what Claude costs; an eval states its plan and stops at 30 runs. Without a login, `--dry-run` prints the exact command and calls nothing, and `dreaming eval --replay` plays the recorded evals in `demo/recorded` with no model call.
- **The contradiction check** needs a 95.9 MB model from huggingface.co (`dreaming models install`: it states the size and source, asks, and hash-checks every file) and two optional runtime packages that `npm ci` installs. Without them everything else works, and the dream and the review say the check was skipped and why. `DREAMING_MODELS` points at a model folder you already have.

To use it on your own memory, with Claude Code:

```sh
npm run build && npm link     # puts `dreaming` on your PATH; or run `node dist/cli.js`
dreaming init --memory-dir ~/.claude/projects/<project>/memory
dreaming run --dry-run        # what would be read, and the exact agent command; runs nothing
dreaming run                  # one headless agent session; proposals go to the inbox
dreaming check                # contradictions between the proposals and your memory
dreaming eval <proposal> --suite <dir>   # measure one, on a task suite you write
dreaming review               # decide, see the exact diff, submit
dreaming why <memory>         # where an applied memory came from
dreaming schedule install --at 02:00
```

`<project>` is the project's path with `/` replaced by `-`. Every command, setting and file is described in [docs/reference.md](docs/reference.md).

## How it works

```
 ~/.claude/projects/*/*.jsonl
            |
   discover  changed since each session's watermark, quiet for 5 minutes, oldest first, capped
   digest    user and assistant text plus one-line tool summaries; secrets redacted
   agent     claude -p --restricted with Read, Glob and Grep only; JSON out
   validate  strict schema; anything else fails the run and leaves the watermark alone
   verify    every evidence quote is matched against the message it claims to come from
   check     each proposal against every memory, sentence pairs through a local NLI model
   eval      (on request) a task suite in isolated claude -p runs, with and without it
   review    a pull-request screen; nothing is written until you submit the combined diff
   apply     exact diff -> confirm -> backup -> atomic writes -> one audit line per change
   why       audit log -> the dream, the reason, the quotes, re-checked against the transcripts
```

**The dream.** The agent cannot write: Claude Code's restricted mode, a three-tool allowlist, `dontAsk` permissions and an empty MCP config hold it to reading, and a test asserts the exact command. It returns up to 25 proposals (add, update or delete a memory), each with a reason, a confidence and one to five quotes from named sessions. dreaming does not trust the quotes: each must appear in a single message of the session it cites, starting and ending on word boundaries, and the review shows the transcript's own text for the matched span. A quote that cannot be found blocks the proposal.

**Memory you can measure.** A memory is an instruction the agent will follow in every session from now on, so dreaming treats a proposed one like a code change and runs the tests. A task suite is a template repository, a few everyday tasks, and for each task a check the agent never sees. Every task runs the same number of times in two arms: **without** the proposal (the memory as it is) and **with** it (the same memory with the proposal applied by the same planner the real apply uses). The arms differ in nothing else: same prompts, same model, a fresh copy of the repository, in a seeded random order. The statistics are chosen for small samples:

- each arm's pass rate gets the **Clopper–Pearson exact interval** ([Clopper and Pearson, 1934](https://doi.org/10.1093/biomet/26.4.404));
- the change gets **Newcombe's hybrid score interval** for a difference of proportions ([Newcombe, 1998](<https://doi.org/10.1002/(SICI)1097-0258(19980430)17:8%3C873::AID-SIM779%3E3.0.CO;2-I>), method 10), which behaves at 0/5 and 5/5, where the textbook interval collapses;
- a task counts as moved only when **Fisher's exact test** ([Fisher, 1922](https://doi.org/10.2307/2340521)) is below 0.05/k and its interval, made simultaneous at 1 − 0.05/k by a **Bonferroni** correction ([Dunn, 1961](https://doi.org/10.1080/01621459.1961.10482090)), clears zero;
- turns, tokens and time get a **stratified percentile bootstrap** of the difference in means ([Efron, 1979](https://doi.org/10.1214/aos/1176344552)), seeded, so a replay prints the same numbers.

The approach follows [Miller (2024), "Adding Error Bars to Evals"](https://arxiv.org/abs/2411.00640): report the interval, not the point, and compare arms on the same questions. A memory is flagged **worse** when any task moved down, **helps** when one moved up, and otherwise "no measurable effect", with the intervals.

**Isolation, proved rather than assumed.** Eval runs must not touch your setup or run your hooks. Each run gets safe mode, project-only settings with every hook disabled, no MCP servers, no session persistence, an allowlisted environment, a working directory outside your home, and the memory in a mode-0600 file rather than in any argument. Then it proves it: a positive control first shows that a canary hook does fire when enabled; every run must report zero hook events, leave no canary file and register no hooks; a process audit watches for sound players; and every package-manager command must reach the suite's shims. Any failure stops the eval.

**Contradictions.** A new memory can be right and still leave an old one saying the opposite. Sentences from different files are paired when they share at least two content words, a cheap stand-in for "about the same thing", which contradiction needs ([de Marneffe, Rafferty and Manning, 2008](https://aclanthology.org/P08-1118/)). Each pair goes both ways through a natural-language-inference cross-encoder, [`cross-encoder/nli-deberta-v3-xsmall`](https://huggingface.co/cross-encoder/nli-deberta-v3-xsmall) (DeBERTa-v3, [He, Gao and Chen, 2021](https://arxiv.org/abs/2111.09543), trained on [SNLI](https://nlp.stanford.edu/projects/snli/) and [MultiNLI](https://aclanthology.org/N18-1101/)), in int8 ONNX form, run in WebAssembly on your machine. A pair is shown when either direction puts 0.8 or more on "contradiction", a threshold chosen before measuring. The review shows both sentences side by side, marked inferred.

**The review** is laid out like a pull request: the list of proposals like the changed files, and for the selected one its reason, each quote with its verdict and the transcript's own text, what the eval measured, what the check found, and the line-numbered diff of every file the approval would touch. Nothing is written until you submit the combined diff; a person's later edits are never overwritten, and a failed write rolls everything back. `dreaming why` traces an applied memory back to its dream and re-checks each quote against today's transcript.

![A terminal recording of the loop: a dream with the demo's fake agent, the local contradiction check, the review with its measurements and conflicts, and dreaming why.](shots/measure/loop.svg)

<sub><b>Recorded.</b> The real CLI in a pseudo-terminal, with the demo's fake agent (it says <code>fake-claude</code> on screen), the real local contradiction model, and the recorded eval results.</sub>

The reasoning behind each choice, from the per-session watermark to the redaction rules, is in [docs/design.md](docs/design.md).

## What it measures / proves

**Recorded evals** (the synthetic suite in `demo/suites/tidepool`, real `claude -p` runs with Sonnet 5, 2 November 2026; 30 runs each, 5 per arm per task):

| Proposal                                           | Verdict                     | What moved (98.3% simultaneous CI; exact p)                                                            | Per run, with it                      | Cost, time     |
| -------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------- | -------------- |
| `prefer-pnpm.md`, "use pnpm, never npm"            | no measurable effect        | install-and-test 4/5 → 5/5 (p = 1.0): the baseline already used pnpm, hinted by `release-checklist.md` | 0.4 fewer turns (95% CI −0.8 to −0.1) | $0.72, 3.7 min |
| `prefers-tabs.md`, which cites a quote nobody said | **▼ makes high-tide worse** | high-tide 5/5 → 0/5 (−100 to −24; p = 0.008): "lint fails: indent with spaces, not tabs" in every run  | 7k more tokens (95% CI +3k to +12k)   | $0.82, 6.2 min |
| `deploy-window.md`, "Tuesdays and Thursdays"       | **▲ helps on deploy-day**   | deploy-day 0/5 → 5/5 (+24 to +100; p = 0.008)                                                          | 8k more tokens (95% CI +1k to +15k)   | $0.79, 7.0 min |

**Focused on one task.** Spread over three tasks, `prefer-pnpm.md` shows no measurable effect. With `--tasks install-and-test`, all 30 runs measure that task (15 per arm, 3 November 2026, `demo/recorded/focused`): **5/15 → 15/15, +67 points (95% CI +34 to +85; exact p = 0.0002)**, 1.5 fewer turns per run (95% CI −2.3 to −0.6) and 25.8k fewer tokens (95% CI −39.1k to −10.6k); the time saved (71 s → 59 s) has an interval that still includes zero. It took 11 minutes and $1.35 at API prices.

**Repeatability.** The three evals were run three times, 270 real runs in all. Every batch gave the same three verdicts. The two decision rules (Fisher's test alongside the interval, and the Bonferroni correction) were added after real runs showed why: without them a tabs memory "helped" a package-manager task 0/5 → 3/5 in one batch and "hurt" it 5/5 → 1/5 in another.

**Isolation evidence**, recorded in every eval: the positive control fired before each one (canaries on SessionStart, UserPromptSubmit and SessionEnd); across the 90 shipped runs there were 0 hook events, 0 canary files and 0 registered hooks, no run bypassed the package-manager shims, and 4,573 process samples saw no sound player. The focused eval repeated it: 0 hook events, 0 canaries, no shim bypass, 3,259 samples.

**Contradiction accuracy**, on 62 labelled synthetic memory pairs (26 contradictions, 22 compatible, 14 unrelated; `test/fixtures/contradictions.json`, measured by `scripts/contradiction-accuracy.mjs` into `docs/contradiction-accuracy.json`):

|                                                   | Precision | Recall | F1    |
| ------------------------------------------------- | --------- | ------ | ----- |
| As shipped (two shared words, then the threshold) | 0.821     | 0.885  | 0.852 |
| The first version (one shared word)               | 0.758     | 0.962  | 0.847 |
| The classifier alone, every pair (AUROC 0.872)    | 0.619     | 1.000  | 0.765 |

The two-word rule was chosen after the first version called "Staging key for the tidepool smoke test" a contradiction of "the v1 compatibility tests were removed" (0.99) on the word "test" alone. The labelled set was seen while choosing it, so treat these numbers as optimistic.

**Speed and size.** The CLI starts in about 0.08 s. The model loads in about a second and scores a sentence pair in about 57 ms (median, one thread); checking the demo's five proposals takes about four seconds. The opener recording is 39.7 KB gzipped, 30.6 KB of it the two embedded font files, and plays at the display's frame rate in Chromium, WebKit and Firefox.

**Tests.** 456 unit tests run on synthetic fixtures with a fake agent, so no model is called; every safety claim has one, and [docs/design.md](docs/design.md#what-the-tests-prove) maps each claim to its test. A further test runs the real contradiction model where it is installed and is skipped elsewhere. The browser suite renders every recorded screen in Chromium, WebKit and Firefox, checks that the embedded font is the one drawn, and fails on any console message.

## Limits

- **An eval measures its suite.** The demo suite is three synthetic tasks written around the demo's memories, so its results demonstrate the method, not Claude in general. Five runs per arm per task detect only large effects; narrow the suite with `--tasks` to put all 30 runs where the memory matters. For your own project you write the tasks and checks.
- **A close stand-in, not the same thing.** Both arms get the memory files appended to the system prompt, while Claude Code itself loads the index and reads files on demand.
- **Evals cost what Claude costs**: $0.72 to $1.35 per 30-run eval at API prices in the runs above, under your own login.
- **The audit needs `ps`.** Where it cannot run (inside a macOS sandbox that refuses setuid programs, for example), an eval stops rather than run unaudited.
- **The contradiction model is small.** Expect false alarms about the same words in different contexts, such as "use npm in the legacy billing repo" against "use pnpm in tidepool".
- **Confinement is Claude Code's.** The dream relies on Claude Code's restricted mode to keep the agent's file tools inside the workspace and memory directory. The flags were checked against Claude Code 2.1.281 and the command is tested, but the dream itself has never been run live, because that would mean reading real transcripts; `dreaming eval` was run live, on synthetic suites only. Older releases may reject a flag, and the run then fails instead of running unconfined.
- **Claude Code only, for now.** The agent sits behind a small adapter interface (`src/agent/adapter.ts`); there is no Codex adapter yet.
- **The transcript format is not a public API.** Session files are parsed defensively and malformed lines are reported, but a format change could reduce what is read.
- **Redaction is pattern-based.** It misses a secret with no recognisable shape that is too short or regular to look random; add patterns for your own formats.
- **One memory directory per config**, fed by every project under the transcripts root. Backups and failed-run workspaces accumulate until you delete them.
- **macOS and Linux.** Windows is untested, and `dreaming schedule` refuses to run there.
- **Not a memory system.** dreaming does not store, retrieve or rank memories; it curates the files your agent already uses.

## How it was built

Designed, specified and reviewed by Harry Freeman; built with AI coding agents.

- The brief: a tool that makes AI checkable, with strict TypeScript, validation at every boundary and no fake success, built as a clean room on synthetic data and run locally.
- The second round asked for the morning review laid out like a pull request, and `dreaming why` for any memory's provenance.
- The third asked for memory you can measure: a task suite run with and without a proposed memory, isolated from his own settings and hooks, and a contradiction check beside every proposal.
- The approved build record shows the first two rounds accepted, each built on by the next brief. A later pass set every recording in IBM Plex, the one type family across his pieces.

Development, recording and contribution notes are in [docs/development.md](docs/development.md); the visual identity is in [IDENTITY.md](IDENTITY.md).

## Licence

MIT. Copyright (c) 2026 Harry Freeman; see [LICENSE](LICENSE). The IBM Plex fonts in `fonts/` are under the SIL Open Font License 1.1, and every model and library dreaming uses is listed with its licence in [THIRD_PARTY.md](THIRD_PARTY.md). The badge in `docs/brand/` is Harry Freeman's mark, not covered by the MIT licence; see [its note](docs/brand/LICENSE.md).
