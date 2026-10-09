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

| | |
|---|---|
| Runtime | Node.js ≥ 22.17, or Docker, or Home Assistant OS / Supervised |
| Architecture (Home Assistant app) | amd64, aarch64 |
| Network | outbound HTTPS to `openrouter.ai`, and to the web pages you name in a job; for claude.ai, a TLS reverse proxy reachable from the internet |
| Disk | about 56 MB installed, 33 MB of it `pdfjs-dist` with its CMaps and fonts; the optional `@napi-rs/canvas` adds a native binary of about 37 MB that text extraction does not need (`npm install --omit=optional` skips it) |
| OpenRouter | an API key with its own daily limit |

## Installation

### Claude Code / Claude Desktop (npx)

1. Write a config file at `~/.config/cheap-eyes/config.json`, or
   `%APPDATA%\cheap-eyes\config.json` on Windows (see [Configuration](#configuration)).
2. Check it (no network, no secrets printed): `npx -y cheap-eyes check-config`
3. Add the server to Claude Code:

   ```sh
   claude mcp add --env CHEAP_EYES_OPENROUTER_KEY=<OPENROUTER_KEY> --transport stdio cheap-eyes -- npx -y cheap-eyes
   ```

4. Try it: *"Use eyes_run to list every TODO in /home/me/notes/\*\*/\*.md, with the
   line it's on."*

Claude Desktop, `.mcp.json` and a global install:
[installation](https://github.com/st412m/cheap-eyes/blob/main/docs/installation.md#npx--stdio).

### Home Assistant app

Home Assistant renamed *add-ons* to *apps* in 2026.2; on older versions the same menus
say *Add-ons* and *Add-on Store*.

1. Add this repository:

   [![Open your Home Assistant instance and show the add app repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fst412m%2Fcheap-eyes)

   Or by hand: **Settings → Apps → App Store → ⋮ → Repositories → + Add**, paste
   `https://github.com/st412m/cheap-eyes`, select **Add**.
2. Find **cheap-eyes** in the store and select **Install**.
3. In **Configuration**, set `openrouter_key`, an `http_token` of at least 32
   characters (`openssl rand -hex 32` gives one) and your `read_roots`.
4. Select **Start**. The app serves MCP on port 3400.

Options and the connector URL:
[app documentation](https://github.com/st412m/cheap-eyes/blob/main/ha-addon/cheap_eyes/DOCS.md).

### Docker / HTTP

`cheap-eyes serve --http` runs the same server over Streamable HTTP with a token; the
repository's `Dockerfile` and `compose.example.yaml` wrap it. See
[installation](https://github.com/st412m/cheap-eyes/blob/main/docs/installation.md#http-mode).

## Configuration

A JSON config file. The fields to set first:

| Field | What it is |
|---|---|
| `read_roots` | The folders (or single files) the server may read. Absolute paths. |
| `models` | Aliases: an alias like `fast` is a short name for a list of model ids. |
| `defaults` | The alias each mode uses when a call names none. |
| `daily_budget_usd` | Local spending cap per UTC day, default `1.0`. |

```json
{
  "read_roots": ["/home/me/notes"],
  "models": { "fast": { "ids": ["qwen/qwen3.6-35b-a3b"], "params": { "reasoning": { "effort": "none" } } } },
  "defaults": { "extract": "fast", "draft": "fast", "edits": "fast" }
}
```

The key goes in the env var `CHEAP_EYES_OPENROUTER_KEY`, never in the file. Every
field, env var and file location:
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

No model is pinned in code. You name models in your config under aliases (`fast`,
`long`, …), and switching means editing the config and restarting. Each alias lists
model ids in priority order; if one can't be used, the next is tried. The example ids
were valid on 2026-09-26 and will age. To pick new ones:

```sh
cheap-eyes models --candidates
```

This lists cheap Zero Data Retention models, and shows how well each of your aliases
passed its checks on your own jobs. If your OpenRouter account's Guardrails don't allow
a model, cheap-eyes skips it and marks it `blocked by account`. Allow it at
openrouter.ai → Guardrails if you want it used.

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
  some regions; route the calls through a proxy.
- **A model is `blocked by account`.** Allow it at openrouter.ai → Guardrails, or put
  another id in the alias.
- **The server won't start and names an alias.** A value in `defaults` is not defined
  in `models`.
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
- In HTTP mode the token works as a password. It needs at least 32 characters and is
  never logged; put TLS in front.

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

## Releasing

For the maintainer. One version goes into `package.json`, `server.json` (`version`
and `packages[0].version`), the app's `config.yaml` and `Dockerfile`, the root
`Dockerfile` and `compose.example.yaml`; `node tools/check-release.mjs` checks it, and CI
runs it.

1. `npm publish`
2. `mcp-publisher login github`
3. `mcp-publisher publish` — reads `server.json`; the registry name
   `io.github.st412m/cheap-eyes` matches `mcpName` in `package.json`.
4. The Home Assistant app installs the package from npm, so its new version goes out
   only after step 1.
5. Push.

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
