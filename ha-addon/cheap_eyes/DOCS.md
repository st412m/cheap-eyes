# cheap-eyes

An MCP server over Streamable HTTP that hands bulk reading of your files (docs, logs,
code, notes, documents, presentations, mail) and of web pages to cheap OpenRouter
models, masks secrets before anything leaves the machine, and checks every quote and
line reference in the answer against the source.
This page covers running the app. The full reference is on GitHub:
[documentation index](https://github.com/st412m/cheap-eyes/tree/main/docs).

## Configuration

| Option | Default | What it does |
|---|---|---|
| `openrouter_key` | empty | OpenRouter API key. Use a **dedicated key with its own daily limit** set on openrouter.ai: that limit is the real spending ceiling. Every model call fails until it is set. |
| `http_token` | empty | At least 32 random characters, e.g. from `openssl rand -hex 32`. Anyone who has it can use the server. The app refuses to start without it. |
| `models` | `fast`, `long` | Aliases: `alias`, `ids` (comma-separated OpenRouter ids in priority order) and `reasoning` (`none`, `low` or `default` = the model's own). The shipped ids were valid on 2026-09-26 and age. |
| `defaults` | `fast` for `extract`, `draft`, `edits`; `long` for `schema` | Alias per mode (`extract`, `draft`, `edits`, `schema`) when a call names none. Each value must be an alias defined in `models` (e.g. `fast`); an unknown alias stops the app at start. An empty `schema` uses the `extract` alias. |
| `max_price_usd_per_mtok` | none | Optional cap: ids whose ZDR price (USD per 1M tokens) is higher are skipped. Set both `in` and `out`, or neither. |
| `daily_budget_usd` | `1.0` | Second line of defence: the server reserves the worst-case cost before every model call and refuses once the UTC day's spend would pass this. |
| `read_roots` | `/share`, `/media` | Folders (or single files) the server may read, as the app sees them: `/share/...` or `/media/...`. |
| `export_dir` | empty | Empty: export off, the server writes only to its own `/data`. Set: result copies go there, and it is the only folder the server may write to. |
| `results_retention_days` | `14` | How long the results store in `/data/results` keeps results (it is also capped at 500 MB, oldest first). |
| `export_retention_days` | `0` | `0`: exported files are never deleted. `N`: the server deletes its own exports older than N days, only if nobody changed them. |
| `time_default_tz` | `UTC` | IANA zone for log timestamps without an offset. |
| `https_proxy` | empty | Empty: direct connection. Otherwise a proxy URL for the calls to openrouter.ai and for `https://` pages in a job. |
| `url_input` | on | Allow `http(s)` URLs in `eyes_run` files; the app fetches the page itself. Off: URLs are refused. |
| `url_contact` | not set | Optional, leave empty. Only for sites that refuse automated fetches without a contact (HTTP 403). The value is sent to every site the app fetches; it does not need to be a real address, e.g. `cheap-eyes@example.com`. 1–100 printable ASCII characters without `(`, `)` or `;`. |
| `log_level` | `info` | `debug` or `trace` also prints the resolved settings at start (no secrets). |

Restart the app after changing an option.

The endpoint is `/private_<token>/mcp` on port 3400 (MCP over Streamable HTTP). For
claude.ai, publish port 3400 through your own reverse proxy that terminates TLS (not
part of this app) and use `https://<host>/private_<token>/mcp` as the connector URL.
Claude Code: `claude mcp add --transport http cheap-eyes https://<host>/private_<token>/mcp`.
Clients that can send headers may use `https://<host>/mcp` with an `Authorization`
header carrying the bearer token instead. A wrong path gets a bare 404; a wrong bearer
token gets 401.

The app maps `/share` and `/media` read-write (the map is static); what the server may
write is decided by `export_dir` alone. It does not map the Home Assistant config
folder, so `secrets.yaml` is out of reach.

More: [configuration](https://github.com/st412m/cheap-eyes/blob/main/docs/configuration.md),
[installation](https://github.com/st412m/cheap-eyes/blob/main/docs/installation.md).

## Files and web pages

Besides plain text the app reads HTML, PDF (with a text layer), Word (DOCX, DOC), RTF,
PowerPoint (PPTX, PPT), OpenDocument text and presentations (ODT, ODP), EPUB, FB2 and
mail (EML, MSG, attachments included). Spreadsheets are refused: questions about a
table are exact lookups, which grep or code answers. Scanned PDFs and
password-protected files are refused with the reason. Refs name the page, slide,
chapter or attachment of a line: `L123 (p.12)`, `L40 (slide 3)`,
`L12 (attachment: offer.pdf, p.2)`. More:
[formats](https://github.com/st412m/cheap-eyes/blob/main/docs/formats.md).

A `files` entry may be an `http(s)` URL; the app fetches the page itself and the page
never passes through the agent. Private and local addresses (your LAN, Home Assistant
itself, `localhost`) are always refused, also when a name changes its address between
the check and the connection. Only ports 80 and 443, at most 5 redirects, 10 MB per
page.

- With `https_proxy` set, `https://` pages go through the proxy, as the OpenRouter
  calls do; the address check then runs on the app's side only and the proxy resolves
  names itself.
- `http://` pages always go direct (the app sets only `HTTPS_PROXY`), connected to the
  address that passed the check.

More: [URL fetch](https://github.com/st412m/cheap-eyes/blob/main/docs/security.md#url-fetch).

## Where results live

Every job is stored in `/data/results` (`<id>.md` + `<id>.check.json`) and served back
through the `eyes_result` tool: paged lines, grep over the result, the check report.
For documents, web pages and `schema` jobs the text the model was given is kept too
(`<id>.sources/`), and `eyes_result` with `source` pages it, so a quote can be checked.
The agent never needs file access. The results folder is excluded from Home Assistant
backups; the usage log (`/data/usage.jsonl`, no content) and the export manifest are
kept.

With `export_dir` set, a copy of each result and its check report also goes there.
The server creates new files only (never overwrites a file it did not write itself),
refuses symlinks and dotfiles, and records what it wrote in `/data/exports.jsonl`.

More: [results](https://github.com/st412m/cheap-eyes/blob/main/docs/results.md).

## Models and Guardrails

The app pins no model: aliases live in the `models` option. Each alias lists ids in
priority order; the server uses the first one that is usable and falls back to the
next. `eyes_stats {models: true}` shows the default alias per mode, the resolved id
per alias with live context and price, and each alias's check pass rate.

Every request asks for Zero Data Retention endpoints (`provider.zdr: true`,
`data_collection: "deny"`); a model id without a ZDR endpoint is refused, never
silently replaced. Your key's account settings apply too: an id your OpenRouter
guardrails or privacy settings do not allow is skipped (the next id of the alias is
tried) and marked `blocked by account` in `eyes_stats {models: true}`. Allow it at
openrouter.ai → Guardrails if you want it used.

More: [models and spending](https://github.com/st412m/cheap-eyes/blob/main/docs/models.md).

## Security

- The model has no tools. Data goes only to `openrouter.ai`, only for `eyes_run`
  calls: the model sees masked, numbered lines of the files and pages named in the
  call and the masked task, nothing else. The only other requests are the URLs named
  in a job.
- Masking is always on: UUIDs, API keys and tokens, key–value secrets (`password`,
  `api_key` …), URL credentials, PEM blocks and more become `[uuid]`, `[key]`, `[id]`,
  `[token]`.

### If the token leaks

Whoever has it can, until you change it:

- run `eyes_run` over everything under `read_roots` and read the masked results;
- read the results already stored in `/data/results`;
- write result files into `export_dir`, if set;
- make the app fetch public web pages (never private or local addresses) and read the
  masked text, unless `url_input` is off;
- spend money up to `daily_budget_usd` per day and the key's own limit.

Change `http_token` and restart the app; consider rotating the OpenRouter key.

If `export_dir` points into `/media` or `/share`, the server writes there with its own
rules only: whatever conventions other tools keep in that folder (for example a notes
vault) do not apply. Keep it a scratch folder.

More: [security](https://github.com/st412m/cheap-eyes/blob/main/docs/security.md).

## If something looks wrong

- **OpenRouter answers 403 "Access denied by security policy".** OpenRouter refuses
  some regions. Set `https_proxy` and restart.
- **A model is `blocked by account`.** Allow it at openrouter.ai → Guardrails, or put
  another id in the alias.
- **`account: availability unknown (…)` in `eyes_stats`.** The account's model list
  could not be read; calls still go ahead.
- **The app stops at start and the log names an alias.** A value in `defaults` is not
  defined in `models`.
- **The connector gets 404.** The token or the path in the URL is wrong. There is no
  `WWW-Authenticate` header and no OAuth by design.
- **The client shows old tools or parameters after an update.** Refresh the
  connector's tool list, then start a new chat.
- **A call is refused with `daily budget exceeded`, or the key limit is reached.**
  `eyes_stats` shows today's spend, the budget and the key's remaining limit.
- **`no usable text layer (scanned PDF?)`.** The PDF is a scan; there is no OCR.
- **`unsupported format: …` or `encrypted document`.** Spreadsheets, images, archives
  and password-protected files are not read. For a table use grep or code; for other
  files save them as PDF, DOCX or text.
- **`URL refused: … private, loopback or otherwise blocked address`.** Pages on your
  LAN or on Home Assistant itself are never fetched; read them from a file.
- **`URL refused: HTTP 403 from <host> (some sites require a contact in User-Agent: set url_contact)`.**
  The site refuses automated fetches without a contact. Set `url_contact` (any address,
  e.g. `cheap-eyes@example.com`; it is sent to every site the app fetches) and restart.

More: [troubleshooting](https://github.com/st412m/cheap-eyes/blob/main/docs/troubleshooting.md).

## Links

- [Changelog](https://github.com/st412m/cheap-eyes/blob/main/CHANGELOG.md)
- [Internals](https://github.com/st412m/cheap-eyes/blob/main/docs/internals.md)
- [License (MIT)](https://github.com/st412m/cheap-eyes/blob/main/LICENSE)
