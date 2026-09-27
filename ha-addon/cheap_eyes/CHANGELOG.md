# Changelog

## 0.1.0 — 2026-09-27

First release.

- Gives your AI agent three tools: `eyes_run` hands bulk reading of your files (logs,
  docs, notes, code) to a cheap model, `eyes_result` reads a stored result back, and
  `eyes_stats` shows spend, your key's status and the models in use.
- Every answer is checked against the source: invented quotes, wrong values and
  claims without a line reference are flagged before the agent relies on them.
- Secrets are masked before anything leaves Home Assistant: passwords, tokens and
  keys become `[token]`, `[key]` and similar.
- Only OpenRouter, and only providers with Zero Data Retention, which don't store your
  prompts.
- Results stay in the app and are served back through `eyes_result`, so the agent
  needs no file access; copying them into a folder is optional.
- Options for your key, models and daily budget, plus `https_proxy` for networks where
  OpenRouter needs a proxy. Models your OpenRouter Guardrails don't allow are skipped
  and marked `blocked by account`.

Full changelog: [CHANGELOG.md](https://github.com/st412m/cheap-eyes/blob/main/CHANGELOG.md)
