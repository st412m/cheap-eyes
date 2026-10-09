# Changelog

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
