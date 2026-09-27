# Changelog

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
