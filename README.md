# cheap-eyes

**Cheap eyes for an expensive agent.**

An AI agent's context is expensive. When it reads a big log, a long doc, a web page or a
whole code tree, it burns that context on lines it mostly doesn't need. cheap-eyes is
an MCP server that hands the reading to a cheap model. It then checks every line of that
model's answer against the source, so the agent gets back a short answer it can trust.

## What it looks like

A real header from the server (trimmed), with a stubbed model answer. The agent asked
for every ERROR line after 08:10 in an app log, plus the traceback that follows it:

```text
eyes_run result: 2026-09-26_152246-extract-889090
model: alias fast -> qwen/qwen3.6-35b-a3b (used: qwen/qwen3.6-35b-a3b)
tokens in 412 / out 96; cost $0.000080; 2 ms
check (extract): refs ok 4 / bad 1 — ok 4, ok~ 0, partial 0, not-in-input 0
  L9 [bad] text differs from the source line
--- untrusted model output ---
L3| 2026-09-20 08:14:09.031 ERROR [sync] upload failed: timeout after 30 s
L4| 2026-09-20 08:14:09.032 Traceback (most recent call last):
L6| TimeoutError: timed out
L8| 2026-09-20 08:15:31.550 ERROR [sync] upload failed: HTTP 503 from api.example.com
L9| 2026-09-20 08:16:00.000 ERROR [sync] retry 2/3 failed
--- end ---
```

The model quoted five lines. In the real log, line 9 says `INFO [sync] retry 2/3 ok`,
so the model made up an error. The check compared each quote with the source line and
flagged L9 as `bad`. The agent sees that before it relies on the answer.

## Why you can trust the answer

- **The model has no tools.** It can't open files, browse or call anything. It sees
  only the numbered lines cheap-eyes chose to send.
- **Secrets are masked before anything leaves your machine.** Passwords, tokens and
  keys become `[token]`, `[key]` and so on, in the files and in the task.
- **Only Zero Data Retention providers.** Those are providers that don't store your
  prompts. cheap-eyes talks only to OpenRouter and asks for them on every call.
- **Every quote and line reference is checked mechanically** against the lines that
  were sent. Wrong values and uncited claims are flagged.
- **What the check does not prove:** that the answer is complete or relevant. It
  proves what was quoted is real, not that nothing was missed.

## Requirements

- **An OpenRouter account with credits.** cheap-eyes calls models through your
  OpenRouter key; `cheap-eyes init` can create one through a browser sign-in. Give the
  key a spending limit on openrouter.ai: that is the real ceiling.
- **A proxy, only where OpenRouter refuses your network.** OpenRouter answers HTTP 403
  to some regions; then the calls need a proxy in another region (`init`, the extension
  and the Home Assistant app ask for it).
- **A TLS reverse proxy, only for claude.ai.** claude.ai reaches servers on the
  internet only, so it needs the HTTP mode behind your own TLS proxy. Claude Code,
  Claude Desktop and other local clients need nothing of the kind.

| | |
|---|---|
| Runtime | Node.js ≥ 22.17 (Claude Desktop runs the extension on its own Node.js), or Docker, or Home Assistant OS / Supervised |
| Architecture (Home Assistant app, Docker image) | amd64, aarch64 |
| Network | outbound HTTPS to `openrouter.ai`, and to the web pages you name in a job |
| Disk | about 56 MB installed, 33 MB of it `pdfjs-dist` with its CMaps and fonts; the optional `@napi-rs/canvas` adds a native binary of about 37 MB that text extraction does not need (`npm install --omit=optional` skips it; the extension and the images leave it out) |

## Installation

No settings file, no model ids, no token to make by hand: the server picks and pins its
models on the first job, and the HTTP mode generates its own token.

**Claude Code.** Run this in a terminal and answer the questions:

```sh
npx -y cheap-eyes init
```

It checks the network (and asks for a proxy where needed), signs you in to OpenRouter
in the browser or takes a key, picks the models and runs `claude mcp add` for you. Then
ask: *"Use eyes_run to list every TODO in the markdown files of this project, with the
line it's on."*

**Claude Desktop.** Download `cheap-eyes-<version>.mcpb` from the
[latest release](https://github.com/st412m/cheap-eyes/releases/latest) and open it with
Claude Desktop. Its settings ask for the OpenRouter key, at least one folder to read
(the form cannot be saved without one) and a **Proxy** field, to leave empty unless
OpenRouter refuses your network.

**Home Assistant.** Add this repository, install **cheap-eyes**, set `openrouter_key`,
start it, and copy the connector path from the log (or the token from the
Configuration tab):

[![Open your Home Assistant instance and show the add app repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fst412m%2Fcheap-eyes)

Or by hand: **Settings → Apps → App Store → ⋮ → Repositories → + Add**, paste
`https://github.com/st412m/cheap-eyes`. Home Assistant called apps *add-ons* before
2026.2. Options: [app documentation](https://github.com/st412m/cheap-eyes/blob/main/ha-addon/cheap_eyes/DOCS.md).

**Docker.** `ghcr.io/st412m/cheap-eyes` serves the HTTP mode on port 3400; the key goes
in the environment, folders are mounted under `/input`, and the log shows the connector
path once:

```sh
docker run -d --name cheap-eyes -p 127.0.0.1:3400:3400 -e CHEAP_EYES_OPENROUTER_KEY=<OPENROUTER_KEY> -v cheap-eyes-data:/data -v /home/me/notes:/input/notes:ro ghcr.io/st412m/cheap-eyes:0.3.0
```

`compose.example.yaml` is the same for Compose.

**Other MCP clients.** A stdio server started as `npx -y cheap-eyes <folder>...` with
`CHEAP_EYES_OPENROUTER_KEY` in its environment; `npx -y cheap-eyes init --client other`
prints the JSON block.

**claude.ai.** Honestly: it needs the HTTP mode (`cheap-eyes serve --http`, the Docker
image or the Home Assistant app) behind your own reverse proxy that terminates TLS, and
then `https://<host>/private_<token>/mcp` as a custom connector (see
[Connecting to claude.ai](#connecting-to-claudeai)).

Every way in detail, the HTTP mode and the proxy:
[installation](https://github.com/st412m/cheap-eyes/blob/main/docs/installation.md).

## Configuration

Everything works without a file. A stdio server reads the project folder (refused when
it is the home folder or a drive root), the models are picked on the first job, the
daily budget is $1. For the rest, `cheap-eyes set` writes the settings file:

```sh
npx -y cheap-eyes set read_roots /home/me/notes /home/me/logs
npx -y cheap-eyes set daily_budget_usd 2
npx -y cheap-eyes check-config
```

`check-config` prints every value in force and where it came from (the file, an
environment variable, the arguments, a default). The key goes in the env var
`CHEAP_EYES_OPENROUTER_KEY`, never in a file. Every field, variable and file location:
[configuration](https://github.com/st412m/cheap-eyes/blob/main/docs/configuration.md).

## Connecting to claude.ai

Run the HTTP server (or the Home Assistant app) and publish it through a reverse proxy
that terminates TLS. The endpoint is:

```text
https://<your-host>/private_<your-token>/mcp
```

Add it in **claude.ai → Settings → Connectors → Add custom connector**. A wrong path
gets a bare 404, and there is no OAuth by design. See
[security](https://github.com/st412m/cheap-eyes/blob/main/docs/security.md#http-mode).

## Using it

You talk to your agent as usual. It calls cheap-eyes when a job fits. Pick the mode by
what you want back:

- **extract** when you need exact lines: errors in a log, a config value, every
  mention of something. Invented lines are flagged.
- **draft** when you want notes or a summary. Every line must cite its source lines.
  Values that aren't in those lines, and lines with no citation, are flagged.
- **edits** when you want fixes proposed. You get JSON edits whose old text is checked
  against the file. cheap-eyes never applies them.
- **schema** when you want fields filled: a JSON schema in, the same JSON out with a
  line ref and a verbatim quote for every value. Conflicting values are reported, not
  resolved.
- **grep** when you know the exact pattern: matching windows, no model, $0.

Files can be text, HTML, PDF (with a text layer), Word (DOCX, DOC), RTF, PowerPoint
(PPTX, PPT), OpenDocument text and presentations (ODT, ODP), EPUB, FB2 and mail (EML,
MSG, attachments included), or an `http(s)` URL that the server fetches itself.
Spreadsheets and scans are refused with the reason. Refs name the page, slide, chapter
or attachment of a line: `L40 (slide 3)`, `L12 (attachment: offer.pdf, p.2)`
([formats](https://github.com/st412m/cheap-eyes/blob/main/docs/formats.md)).

Prompts you might type (the files must lie inside your `read_roots`):

- *"Use eyes_run to pull every ERROR from /var/log/app/app.log since 08:00 today, with
  the tracebacks."*
- *"Have cheap-eyes draft a summary of /home/me/notes/deploy.md: versions, ports,
  backup times."*
- *"Use eyes_run in edits mode to fix the dead links in /home/me/notes/\*.md."*
- *"Use eyes_run in schema mode on /home/me/docs/tender.pdf: customer, maximum price,
  deadline, and the list of items with quantities."*

What each check catches and misses:
[checks](https://github.com/st412m/cheap-eyes/blob/main/docs/checks.md).

## When to use cheap-eyes and when grep

cheap-eyes pays off for **reading by meaning over large text**: logs, archives, long
documents, web pages, "everything about X", chronologies. For **exact lookups** — a key,
which blocks contain X, a list by a field, a value in a table — and for files under
about 30 KB, grep, a ranged read or code is cheaper and more reliable. That is why
spreadsheets are not read at all.

On a benchmark of 2026-09-30 with independent ground truth:

- An 887 KB log archive, task "everything about power": recall 96 %, precision 100 %,
  $0.08, about 12k tokens of the agent's context instead of about 227k for reading it
  whole.
- A structural task over Home Assistant automations ("who sends to Telegram"):
  precision 41 % with a green check. The check catches invented lines, not wrongly
  chosen ones.

A snippet for `CLAUDE.md` or your Claude settings:

```
Reading by meaning over large text (logs, archives, long documents, web pages, "everything about X") → cheap-eyes eyes_run (extract/draft; fields → schema). Exact values, structure, small files (< ~30 KB) → grep / ranged read (no model: eyes_run mode grep). Verify any value from cheap-eyes against the source (eyes_result source) before relying on it.
```

To compare models on your own documents, run
[`cheap-eyes bench`](https://github.com/st412m/cheap-eyes/blob/main/docs/bench.md).

## Tools

- `eyes_run` — does the job and returns a short, checked header.
- `eyes_result` — reads a stored result: pages, grep, the check report, the source text
  the model was given; cancels a running job.
- `eyes_stats` — spend today and all time, your key's status; on request, the model
  table.

Inputs and outputs: [tools](https://github.com/st412m/cheap-eyes/blob/main/docs/tools.md).

## Models and cost

No model id is written in code. When you name none, the server picks them on the first
job: it takes the cheapest Zero Data Retention models your account allows within a
price cap (in $1 / out $4 per 1M tokens unless you set one), gives each a built-in test
job, and pins the two that pass first. **That proves a model works here, not that it
reads best:** the cheapest model that passes wins, and free variants are not picked.
To choose by quality, compare models on your own documents with
[`cheap-eyes bench`](https://github.com/st412m/cheap-eyes/blob/main/docs/bench.md), then
name one:

```sh
cheap-eyes models --candidates
cheap-eyes set models.fast <id>
cheap-eyes set defaults.extract fast
```

`models --candidates` lists cheap Zero Data Retention models and shows how well each
model in use passed its checks on your own jobs. If your OpenRouter account's
Guardrails don't allow a model, cheap-eyes skips it and marks it `blocked by account`.
Allow it at openrouter.ai → Guardrails if you want it used.

With cheap models a job costs fractions of a cent. Your key's own daily limit on
OpenRouter is the real ceiling. On top of that, `daily_budget_usd` (default $1 a day)
stops calls before they would go over. More:
[models and spending](https://github.com/st412m/cheap-eyes/blob/main/docs/models.md).

## Limitations

- **The check proves quotes are real, not that the answer is complete.** A relevant
  line the model skipped is not flagged.
- **No OCR.** Scanned PDFs are refused with the reason; layout and images are lost in
  extraction.
- **No spreadsheets.** Excel and OpenDocument spreadsheets are refused: questions about
  a table are exact lookups, which grep or code answers and a model reading the table
  as text gets wrong.
- **Size caps.** A text file (or the text extracted from a document) over 2 MB is
  refused, never truncated; a document over 50 MB and a URL over 10 MB likewise; a job
  is capped at 5 MB after filtering and 200 files.
- **No reduce pass for `draft`.** With several chunks, each chunk's notes come back
  under their own header.
- **The hook covers Claude Code's `Read` tool only.** Shell commands are not
  intercepted.

## Troubleshooting

- **OpenRouter answers 403 "Access denied by security policy".** OpenRouter refuses
  some regions; route the calls through a proxy. The refusal names where to set it in
  your setup.
- **Every tool call answers with a settings error.** The server started in its setup
  state because a setting cannot be used; the message names the setting and the fix.
- **No model passes the pick.** The refusal names each tried id and why; allow more
  models at openrouter.ai → Guardrails, raise the price cap, or name a model with
  `cheap-eyes set models.<alias> <id>`.
- **A model is `blocked by account`.** Allow it at openrouter.ai → Guardrails, or put
  another id in the alias.
- **The client shows old tools after an update.** Refresh the connector's tool list
  and start a new chat.

More: [troubleshooting](https://github.com/st412m/cheap-eyes/blob/main/docs/troubleshooting.md).

## Security

- The model gets no tools; everything it returns is framed as untrusted output.
- Only files inside `read_roots` are read, after resolving symlinks; `.env*`, keys,
  `secrets.yaml`, databases and `.git` are always refused.
- Secrets are masked before anything leaves the machine; model calls go only to
  `openrouter.ai`, with Zero Data Retention required.
- URLs in a job are fetched by the server with private and local addresses refused,
  also against DNS rebinding.
- The server writes nowhere outside its own state folder unless you opt into export.
- A stdio server reads the project folder by default, never the home folder or a
  drive root.
- In HTTP mode the token works as a password. It needs at least 32 characters; a
  generated one is printed once and by `cheap-eyes token`, never in request logs,
  errors or results. Put TLS in front. Request bodies over 1 MiB are refused.

More: [security](https://github.com/st412m/cheap-eyes/blob/main/docs/security.md).

## Links

- [Documentation](https://github.com/st412m/cheap-eyes/tree/main/docs) —
  [installation](https://github.com/st412m/cheap-eyes/blob/main/docs/installation.md),
  [configuration](https://github.com/st412m/cheap-eyes/blob/main/docs/configuration.md),
  [tools](https://github.com/st412m/cheap-eyes/blob/main/docs/tools.md),
  [checks](https://github.com/st412m/cheap-eyes/blob/main/docs/checks.md),
  [models and spending](https://github.com/st412m/cheap-eyes/blob/main/docs/models.md),
  [results](https://github.com/st412m/cheap-eyes/blob/main/docs/results.md),
  [security](https://github.com/st412m/cheap-eyes/blob/main/docs/security.md),
  [hook](https://github.com/st412m/cheap-eyes/blob/main/docs/hook.md),
  [formats](https://github.com/st412m/cheap-eyes/blob/main/docs/formats.md),
  [bench](https://github.com/st412m/cheap-eyes/blob/main/docs/bench.md),
  [troubleshooting](https://github.com/st412m/cheap-eyes/blob/main/docs/troubleshooting.md),
  [internals](https://github.com/st412m/cheap-eyes/blob/main/docs/internals.md)
- [Home Assistant app](https://github.com/st412m/cheap-eyes/blob/main/ha-addon/cheap_eyes/DOCS.md)
- [Changelog](https://github.com/st412m/cheap-eyes/blob/main/CHANGELOG.md)

## Prior art

Both MIT-licensed; cheap-eyes is written from scratch (see `NOTICE`).

- [BardyLaw/claude-worker-delegation](https://github.com/BardyLaw/claude-worker-delegation)
  — the server reads files by path, short preview, usage log, daily budget, PreToolUse
  hook. cheap-eyes adds what it lacked: a `realpath` path guard, refusal instead of
  silent truncation, masking, line numbers and checking the output.
- [aashahin/claude-opencode-delegate](https://github.com/aashahin/claude-opencode-delegate)
  — async task registry, compact status header.

## License

[MIT](https://github.com/st412m/cheap-eyes/blob/main/LICENSE) — by st412m.
