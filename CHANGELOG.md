# Changelog

## 0.3.0 — 2026-11-15

- **No settings file needed.** Every field has a default; a missing settings file is no
  longer an error. Settings come from arguments, then environment variables, then the
  file, then defaults; `check-config` names the source of every value that did not come
  from the file. New variables `CHEAP_EYES_READ_ROOTS`, `CHEAP_EYES_DAILY_BUDGET_USD`
  and `CHEAP_EYES_SETTINGS_UI`; an empty value counts as not set. The stdio server takes
  its read roots as arguments (`cheap-eyes <dir>...`).
- **Default read root.** Without read roots from any source, a stdio server reads the
  project folder (`CLAUDE_PROJECT_DIR`, else its working directory), never the home
  folder, a folder that contains it, or a drive root. With no read root the server still
  starts and URL jobs work. `serve --http` has no default.
- **`cheap-eyes set <key> [<value>...]`** writes one setting into the settings file
  (validated first; no value removes the key); it never takes the key or the token.
- **Models picked and pinned.** With no models in the settings, the first model job
  picks them: ZDR models the account allows, within the price cap (in $1 / out $4 per 1M
  tokens unless one is set), cheapest first, each tried on a built-in test job until two
  pass; the pick is pinned in `<state dir>/models.json` and used as the alias `auto`.
  Free variants are not picked. Probes are paid calls within the daily budget, logged
  as `tool: "probe"` and shown on their own line in `eyes_stats`. A pinned id that
  becomes unusable is skipped; when none is left the server picks again. `cheap-eyes
  models --pick` picks on request. The pick proves a model works, not that it reads
  best: `cheap-eyes bench` and `cheap-eyes set models.<alias> <id>` choose by quality.
- **Price cap in the request.** With a cap in force an id counts when one of its ZDR
  endpoints fits it, every request carries it as `provider.max_price`, and the budget
  reservation uses at most the cap. The model table shows lowest–highest prices.
- **`cheap-eyes init`.** A wizard on a terminal: network (asks for a proxy on HTTP 403
  and continues through it), key (browser sign-in to OpenRouter with PKCE, or paste;
  warns about a key without a spending limit), folders, the model pick, and the client
  (runs `claude mcp add` for Claude Code, or prints the JSON block). `check-config
  --live` adds the checks against OpenRouter.
- **Generated HTTP token.** `serve --http` no longer refuses to start without a token:
  it generates one into `<state dir>/token` and prints the connector path once.
  `cheap-eyes token` prints it again; `cheap-eyes token --new` replaces it.
- **Refusals name the action** for the setup in use: the extension settings in Claude
  Desktop, the app options in Home Assistant, the environment of the Docker container,
  an environment variable, the client's arguments, or `cheap-eyes set`. A stdio server
  with settings that cannot be used starts in a setup state: the tools are listed, and
  every call answers with the error and the fix.
- **Claude Desktop extension.** `cheap-eyes-<version>.mcpb` on each release: the
  OpenRouter key, the folders, a proxy field and the daily budget in its settings. The
  proxy is switched on in the same process with `http.setGlobalProxyFromEnv` where Node
  has it (24.14+, 25.4+); on an older Node from 22.21 on the server starts itself again
  through the proxy, and stays up in the setup state with the reason when that fails.
- **Docker image** `ghcr.io/st412m/cheap-eyes` (linux/amd64, linux/arm64): settings as
  environment variables, folders under `/input`, state and token in `/data`.
- **`cheap-eyes hook install [--project]`** and **`hook remove`** add and take out the
  Claude Code hook.
- `eyes_stats`, the start line and `check-config` show the Node version and the proxy
  state (never the proxy URL).
- `cheap-eyes.example.json` is gone; a short example lives in `docs/configuration.md`.

## 0.2.1 — 2026-10-26

- Security updates: `@modelcontextprotocol/server` 2.4.0 and `@modelcontextprotocol/node`
  2.1.2 (GHSA-46jr-4wx8-v453, GHSA-jm63-cq47-j5jp, GHSA-rvq5-wwqv-78pq), zod 4.6.7
  (GHSA-mrhx-c7xc-m3w5), doclines 0.1.1 with postal-mime 4.1.4 (GHSA-f2hq-32vh-53cc),
  hono 4.13.14 (GHSA-5r4p-p66f-jhc7).
- HTTP mode: a request body over 1 MiB is answered 413 before it is parsed (was 4 MiB).
- A tool call whose arguments hold more than 2000 array elements and object members in
  total is refused before validation, over stdio and HTTP.
- Markers: after lines skipped by a filter, at the top of a chunk that starts inside a
  section and in the second half of a re-split chunk, a line is preceded by the markers
  of all sections it is in, outermost first (`--- attachment: spec.pdf ---`, then
  `--- page 4 ---`), not only the innermost one.
- Mail: EML text follows postal-mime 4.1.4: body text dropped in some malformed messages
  is extracted; a `message/rfc822` attachment keeps the line endings of the message, so
  its size in the attachment list can differ.

## 0.2.0 — 2026-10-09

- **Documents.** `eyes_run` reads HTML, PDF (with a text layer), Word (DOCX, DOCM,
  DOTX, DOTM, DOC), RTF, PowerPoint (PPTX, PPTM, POTX, POTM, PPSX, PPT), OpenDocument
  text and presentations (ODT, OTT, ODP, OTP), EPUB, FB2 and mail (EML, MSG, with
  their attachments) as text, detected from the content; extraction is done by the
  `doclines` package. Tables come out one row per line, cells joined by ` | `. Refs and
  `extract` lines show the place of a line: `L123 (p.12)`, `L40 (slide 3)`,
  `L7 (chapter 2)`, `L12 (attachment: offer.pdf, p.2)`; JSON items carry it as `place`,
  and PDF pages also as `page`. A word split by a soft hyphen at a line end is joined.
  Spreadsheets (Excel, OpenDocument) are refused: tables need exact lookups, which grep
  or code does. Scanned PDFs, password-protected files, images and archives are refused
  with the reason before any model call. New limits `max_doc_bytes` (50 MB) and
  `extract_timeout_s` (60).
- **URLs.** `files` takes `http(s)` URLs; the server fetches the page itself, refuses
  private and local addresses (also against DNS rebinding), follows at most 5 redirects
  and reads only the content types of the formats above. New options `url_input`,
  `url_timeout_s`, `max_url_bytes`, and an optional `url_contact` for sites that refuse
  fetches without a contact.
- **Mode `grep`.** Matching windows with line numbers and places; no model, no cost.
- **Mode `schema`.** A JSON schema in, the same JSON out with a line ref and a verbatim
  quote for every value; chunks are merged, conflicting values reported, every field
  checked (`ok`, quote mismatch, bad ref, value not in quote, null, conflict). New
  config key `defaults.schema` (falls back to `defaults.extract`).
- **Source text with every result** for documents, URLs and schema jobs:
  `eyes_result {source}` pages and greps the text the model saw, so a quote can be
  verified without file access.
- **`cheap-eyes bench`.** Runs a suite with expected answers and reports recall,
  precision, invented values, conflicts and cost per model and per provider;
  `--max-usd` stops it early.
- **Longer answers.** Default `max_tokens` per mode: `extract` 16000, `schema` 8000,
  `draft` and `edits` 4096. A chunk cut by the output limit in `extract`, `edits` or
  `schema` is split in two and retried once.
- **Shorter reports.** `eyes_result {check: true}` lists only the items that are not
  `ok` (`check: "all"` for every item); lines over 400 characters are cut in paged
  views unless `full: true`.
- Quote checks treat soft hyphens and NBSP as whitespace-level differences (`ok~`).
- A file name in a ref may be the short form (`report.pdf:L5` for `docs/report.pdf`)
  when it matches one input file.
- Every tool has a title and all four MCP hints (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`).
- Listed in the MCP Registry as `io.github.st412m/cheap-eyes`.

## 0.1.0 — 2026-09-27

First release: the npm package `cheap-eyes` and the Home Assistant app in
`ha-addon/cheap_eyes/`.

- MCP server with exactly three tools: `eyes_run`, `eyes_result`, `eyes_stats`; stdio by
  default, Streamable HTTP with `serve --http` (secret path or bearer token, at least
  32 characters; OAuth discovery answers 404).
- Input pipeline without the model: `realpath` guard over `read_roots`, deny globs,
  `.gitignore`-aware globs, UTF-8/UTF-16 input, line range, log time window, grep in a
  worker with a timeout, chunking by the model's live context.
- Secret masking, always on, for file lines and the task: token shapes, key–value
  secrets, URL credentials, PEM blocks, YAML block values, custom patterns.
- OpenRouter only, Zero Data Retention endpoints only, prompt compression off; model
  ids live in config, context and price come from the live ZDR list; ids the account's
  guardrails or privacy settings do not allow (`GET /models/user`) are skipped and
  marked `blocked by account`; server-side fallback to the next id; daily budget with
  worst-case reservation.
- Mechanical checks per mode — `extract` (verbatim lines), `draft` (refs and hard
  tokens), `edits` (`old` exists once, masks untouched; never applied) — stored with
  every result and summarised in `eyes_stats` as a per-model pass rate.
- Results store served through `eyes_result` (paged, grep, check report, async jobs,
  cancel); optional export into `write_roots` with an exclusive-create guard and a
  manifest; retention for results and, optionally, exports.
- `cheap-eyes check-config`, `cheap-eyes models [--candidates]`.
- Optional Claude Code `PreToolUse` hook that denies whole-file reads of large text
  files.
- Home Assistant app, standalone `Dockerfile` and `compose.example.yaml`.
- `tools/scan-secrets.mjs` and CI: secret and private-address scan; tests on Node 22
  and 24, Linux and Windows.
