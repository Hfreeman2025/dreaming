# Third-party models and libraries

Everything dreaming downloads or loads that it did not write, with its licence and where it comes from.

## Model

| Name                                                                                                  | Revision                                   | Licence                                                                                                  | Size                                                                                      | Source                                                                                      |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `Xenova/nli-deberta-v3-xsmall` (ONNX conversion of `cross-encoder/nli-deberta-v3-xsmall`), q8 weights | `2a4f614a701367a02d51389039afc998faeda637` | Apache-2.0, declared by the upstream model: <https://huggingface.co/cross-encoder/nli-deberta-v3-xsmall> | 95,905,926 bytes in 7 files; the weights `onnx/model_quantized.onnx` are 87,246,587 bytes | <https://huggingface.co/Xenova/nli-deberta-v3-xsmall> (files fetched by immutable revision) |

SHA-256 of `onnx/model_quantized.onnx`: `3fac2500c45c75af42c7711de0d1b93d59577456100208be0dc1f9e8811946b6`. Every file's size, hash and URL is pinned in `src/contradict/models.ts`; a download is hash-checked before it is used.

## Libraries for the local contradiction check (optional dependencies)

| Name                      | Version | Licence    | Unpacked size     | Source                                         |
| ------------------------- | ------- | ---------- | ----------------- | ---------------------------------------------- |
| `onnxruntime-web`         | 1.31.1  | MIT        | 150,622,959 bytes | <https://github.com/microsoft/onnxruntime>     |
| `@huggingface/tokenizers` | 0.2.0   | Apache-2.0 | 360,962 bytes     | <https://github.com/huggingface/tokenizers.js> |

Both are imported only by `src/contradict/nli.ts`, on first use; dreaming installs, starts and reviews without them.

Their own dependencies are all MIT, Apache-2.0, BSD-3-Clause or ISC: `onnxruntime-common` (MIT), `protobufjs` (BSD-3-Clause), `long` (Apache-2.0), `flatbuffers` (Apache-2.0), `guid-typescript` (ISC), `platform` (MIT).

## Runtime dependencies

| Name   | Version | Licence      | Installed size | Source                               |
| ------ | ------- | ------------ | -------------- | ------------------------------------ |
| `zod`  | 4.6.7   | MIT          | 8.4 MB         | <https://github.com/colinhacks/zod>  |
| `yaml` | 2.9.1   | ISC          | 1.3 MB         | <https://github.com/eemeli/yaml>     |
| `diff` | 9.0.0   | BSD-3-Clause | 1.0 MB         | <https://github.com/kpdecker/jsdiff> |

## Development only (tests and recordings; not installed with the package)

| Name               | Version | Licence    | Source                                    |
| ------------------ | ------- | ---------- | ----------------------------------------- |
| `@xterm/headless`  | 6.0.0   | MIT        | <https://github.com/xtermjs/xterm.js>     |
| `@playwright/test` | 1.64.1  | Apache-2.0 | <https://github.com/microsoft/playwright> |

The rest of the development tree (TypeScript, ESLint, Prettier, Vitest and their dependencies) is MIT, ISC, BSD or Apache-2.0, except `minimatch` and one of its dependencies (BlueOak-1.0.0, a permissive licence), which only ESLint uses.

## Fonts (in the repository, under `fonts/`)

IBM Plex, version 5.3.0 of the `@fontsource` packages, latin subset, WOFF2, unmodified. Licence: SIL Open Font License 1.1, Copyright 2019 IBM Corp.; the full text is in `fonts/OFL.txt`. Fetched from `https://cdn.jsdelivr.net/npm/@fontsource/<package>@5.3.0/files/<file>`; nothing is fetched at runtime, and `fonts/plex.css` declares every face with `font-display: swap`.

| Package                               | File                                             | Bytes  | Used here                                         |
| ------------------------------------- | ------------------------------------------------ | ------ | ------------------------------------------------- |
| `@fontsource/ibm-plex-mono`           | `ibm-plex-mono-latin-400-normal.woff2`           | 14,708 | every recording, embedded in each SVG             |
| `@fontsource/ibm-plex-mono`           | `ibm-plex-mono-latin-600-normal.woff2`           | 15,620 | bold in the recordings, embedded where it is used |
| `@fontsource/ibm-plex-sans-condensed` | `ibm-plex-sans-condensed-latin-600-normal.woff2` | 19,816 | the name on the social card (preloaded)           |
| `@fontsource/ibm-plex-sans`           | `ibm-plex-sans-latin-400-normal.woff2`           | 22,588 | the sentence on the social card (preloaded)       |
| `@fontsource/ibm-plex-sans-condensed` | `ibm-plex-sans-condensed-latin-500-normal.woff2` | 19,952 | not yet; kept so the family is complete           |
| `@fontsource/ibm-plex-sans`           | `ibm-plex-sans-latin-400-italic.woff2`           | 24,356 | not yet                                           |
| `@fontsource/ibm-plex-sans`           | `ibm-plex-sans-latin-500-normal.woff2`           | 24,184 | not yet                                           |
| `@fontsource/ibm-plex-sans`           | `ibm-plex-sans-latin-600-normal.woff2`           | 24,252 | not yet                                           |

The latin subset maps 229 code points. The recordings use 15 characters it lacks (✓ ✗ ○ ● ▶ ▲ ▼ ■ ≠ → ← ─ ━ ┃ ┼), which come from the system monospace.

## Services

`dreaming eval` runs the `claude` CLI you already have, under your own login, on synthetic task suites; dreaming itself calls no hosted model API and needs no key.
