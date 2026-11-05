# Development

```sh
npm ci
npm run check     # typecheck, lint, test, npm audit --audit-level=high
npm run demo
```

CI runs the same steps on Linux (Node 22 and 24) and macOS (Node 22), plus the demo, and renders the recorded screens in Chromium, WebKit and Firefox. Everything in CI runs offline against synthetic data and fake agents. Two checks never run there, by design: the real-model contradiction test, which runs only when `DREAMING_NLI_MODEL_DIR` points at the downloaded model (and `DREAMING_NLI_RUNTIME_FROM` at a project with the runtime packages, if they are installed elsewhere) and shows as skipped otherwise; and `scripts/record-evals.mjs`, which makes real `claude -p` calls.

TypeScript is strict, ESLint forbids type assertions (data crossing a boundary is parsed with zod instead), and each guard (timeout, limit, validator, redaction rule, lock) has a test that makes it trigger.

## Recordings

The recordings and every screenshot in `shots/` come from the real CLI, run in a pseudo-terminal:

```sh
npm run record          # both sets, from a pseudo-terminal: SVG casts and stills
npm run record:core     # shots/core: the dream, the review, why, status and help (demo.svg)
npm run record:measure  # shots/measure: eval, check and models, and the review's measurements (eval.svg, loop.svg)
npm run shoot           # each still as a 2x PNG, and shots/og.png (1200×630), the social preview
npm run test:browsers   # every SVG in Chromium, then WebKit, then Firefox; two workers, muted (npx playwright install first)
node scripts/record-evals.mjs --yes   # remake demo/recorded: about 90 real claude -p runs under your login; never in CI
```

Each scene runs in a temporary home directory, is driven with keys only once the screen shows what the step waits for, and is played through a headless terminal emulator (xterm.js) to draw SVG. The eval recordings are replays of `demo/recorded/evals`, labelled as replays on screen; the dream, the simulated failure states (a leaked hook, a logged-out CLI, Ctrl-C) and the review use fake agents that say `fake-claude` on screen; the contradiction check runs the real model when it is installed (`$DREAMING_MODELS`, else `~/.dreaming/models`) and those scenes are skipped otherwise.

In an animated recording each frame is a group shown only for its own slice of the loop, by a stepped CSS animation, so one frame is painted at a time: no script, and a still final frame under `prefers-reduced-motion`. The text is IBM Plex Mono, embedded in each SVG as a data URI, because an SVG shown as an `<img>` (as GitHub shows these) may not fetch a font. That is most of each file's weight (`eval.svg` is 39.7 KB gzipped, 30.6 KB of it the two font files). Every run of text is locked to the terminal grid, so a font, or a symbol from the fallback face, cannot move the layout. `shots/og.png` is a page set in IBM Plex Sans and Sans Condensed from `fonts/plex.css`, with both faces preloaded, and `npm run shoot` refuses to write it if a face did not load or anything shifted.

## Dependencies

Two entries in `package.json` are there for the dependency tree rather than the code: `vite` is pinned to 7 because vitest would otherwise install vite 8, which brings in an MPL-2.0 package, and the `minimatch` override moves ESLint's copy past a published advisory. Every package in the tree is MIT, ISC, BSD or Apache-2.0 licensed, except minimatch and one of its dependencies (BlueOak-1.0.0, a permissive licence), which only ESLint uses. The recording tools are development dependencies only. [THIRD_PARTY.md](../THIRD_PARTY.md) lists everything with its licence.

## Contributing

Use synthetic data only. Never add a real transcript, memory file or credential to the repository, including as a test fixture. Build credential-shaped test strings at runtime from pieces, as the existing tests do; `test/repository.test.ts` fails if any committed file trips the redactor. A new agent adapter must come with a test that asserts its command is read-only.
