# Tools

The three MCP tools: their inputs, what they return, how to page through a stored
result and its source text, and how async jobs and cancelling work. Read this when
calling the tools directly or when a client shows a parameter you don't recognise.

Tool schemas are sent to the client in every session, so there are exactly three and
their descriptions are short. Each tool carries a title and all four MCP hints:

| Tool | Title | readOnly | destructive | idempotent | openWorld |
|---|---|---|---|---|---|
| `eyes_run` | Run cheap reading job | false (writes results, exports) | false | false (each call is a new job and spend) | true (OpenRouter, URLs) |
| `eyes_result` | Read job result | false (`cancel`) | false | true | false |
| `eyes_stats` | Usage and models | true | false | true | true (OpenRouter key and model lists) |

## `eyes_run`

Runs one job: reads the files, masks, filters, chunks, calls the model and checks the
answer (the steps are in [internals](internals.md#how-it-works)).

| Input | Meaning |
|---|---|
| `task` | What to look for or write. Masked like file content. Required for `extract`, `draft`, `edits`; optional for `grep` (a label in the header) and `schema` (extra instructions). |
| `mode` | `extract`, `draft`, `edits`, `grep` or `schema` (see [checks](checks.md) and below). |
| `schema` | Mode `schema` only: the fields to fill (see [mode schema](#mode-schema)). |
| `model` | Alias; default `defaults[mode]` (`schema` falls back to `defaults.extract`). Raw ids only with `allow_raw_model_ids`. |
| `files` | Absolute paths or globs inside `read_roots`, or `http(s)` URLs. `#L100-L400` range on a single file. HTML, PDF, Word, RTF, PowerPoint, OpenDocument text and presentations, EPUB, FB2 and mail are read as text; spreadsheets are refused: see [formats](formats.md). |
| `grep` | `{pattern, context = 3, ignore_case}` — send only matching windows. Runs in a worker with a timeout. Required for mode `grep`. |
| `time` | `{since, until, tz}` (ISO 8601) — keep log lines whose timestamp is in the window. Continuation lines (tracebacks) stay with their stamped line; a file with no recognised timestamp is an error. Recognises ISO 8601, `YYYY-MM-DD HH:MM:SS[.mmm]`, syslog `Mon DD HH:MM:SS` and journalctl short-iso. |
| `export_to` | Also copy the result here (inside `write_roots`). |
| `overwrite` | Replace an earlier export of this server at that path. |
| `max_tokens` | Output cap per chunk, capped by the model's ZDR limit. Default per mode: `extract` 16000, `schema` 8000, `draft` and `edits` 4096. Always sent, so the budget reservation is a real ceiling. |
| `dry_run` | Run steps 1–4, store the exact request bodies as the result, call no model (only the public ZDR list is fetched to size the chunks). This is how you audit what would be sent. |
| `async` | Return the result id at once; poll `eyes_result`. |

In mode `grep`, `dry_run` is refused and `async` is ignored (the job finishes at
once).

### A chunk cut short

When a model stops a chunk on `finish_reason: "length"` in `extract`, `edits` or
`schema`, the server splits that chunk in two by lines (with the usual 5-line
overlap) and runs both halves once. A half that is cut again is marked truncated. The
header says `re-split after truncation: N chunk(s)`; the cut answer is dropped, its
cost counts. An explicit `max_tokens` replaces the per-mode default but keeps the
re-split.

### URL input

A `files` entry starting with `http://` or `https://` is fetched by the server; the
page never passes through the agent's context. Other schemes (`file://`, `ftp://`)
and a `#L…` range on a URL are refused. With `url_input: false` in the config every
URL is refused.

- Only ports 80 and 443; no cookies, no credentials, `User-Agent:
  cheap-eyes/<version> (+https://github.com/st412m/cheap-eyes)`, or with config
  `url_contact` set `cheap-eyes/<version> <url_contact>`, on every request and
  redirect.
- At most 5 redirects, each one checked again; `url_timeout_s` (30) for the whole
  fetch; `max_url_bytes` (10 MB) counted while streaming, after decompression too —
  over it the URL is refused, never truncated.
- Private, loopback, link-local and other local addresses are refused, before the
  request and at connect time: see [URL fetch](security.md#url-fetch).
- Content types read: `text/html`, `application/xhtml+xml`, `text/plain`,
  `text/markdown`, `text/csv`, `application/json`, `application/pdf`, the Word types
  (DOCX, DOCM, DOTX, DOTM, DOC), `application/rtf`, `text/rtf`, the PowerPoint types
  (PPTX, PPTM, POTX, POTM, PPSX, PPT), the OpenDocument text and presentation types
  (ODT, OTT, ODP, OTP), `application/epub+zip`, `application/x-fictionbook+xml`,
  `message/rfc822` and `application/vnd.ms-outlook`. Anything else is refused by type:
  spreadsheet types, archives, a PDF served as `application/octet-stream`. Then the
  format is detected from the content as for files; the extension of the final URL
  path and the content type break ties (`message/rfc822` makes a message).
- The name in refs is `host/path` without the query, at most 80 characters (cut in
  the middle with `…`); two URLs with the same name become `url/host/path`, then
  `#u2/host/path`.
- Masking applies as to files. The full URL (query values masked) and the final URL
  after redirects are kept in the [sources index](results.md#source-copies); the usage
  log records the host and the size only.
- Fetching costs nothing; the model call is reserved as usual.

### Mode `grep`

No model, no OpenRouter call, no key needed, cost 0. The same input pipeline runs
(formats, URLs, range, time window, masking before grep); the result is the matched
windows as a model would see them, with a `=== file: name ===` header for every file,
`L123|` prefixes and the place on lines inside a page, slide, chapter or attachment
(`L123 (p.12)|`, `L40 (slide 3)|`; see [formats](formats.md#places-in-refs)). The header gives the
matches per file and the total lines, and frames the first 20 lines as
`--- source text (masked) ---`. The result is stored and paged like any other; it has
no check report. The usage log records it with cost 0 and `model: null`.

### Mode `schema`

Fills a JSON schema from the input, with a ref and a verbatim quote for every field.

The schema is a JSON object (or a JSON string of one). A leaf is a description,
optionally starting with a type hint (`string`, `number`, `integer`, `boolean`, `date`,
`datetime`, `time`) before `—`. Nested objects are allowed; a list is a one-element
array holding the item template. At most 60 leaves (a list template counts once) and
depth 4 (each key and each list level is a step).

```json
{
  "customer": "string — the buying organisation",
  "max_contract_price_rub": "number — НМЦК",
  "contract_execution_deadline": "date",
  "items": [{ "name": "string", "quantity": "number" }]
}
```

The answer mirrors the schema. Every leaf is `{"value": …, "ref": "L123", "quote":
"…"}` (`"name:L5"` with several files, `"L10-L14"` for a range), or `{"value": null,
"reason": "NOT IN INPUT"}`. An unfilled template placeholder (`[insert …]`, `____`,
`XX.XX.XXXX`) counts as absent; the rule is in the prompt, the server does not filter
values. Two different values for one field come back as
`{"value": [v1, v2], "conflict": true, "refs": [...], "quotes": [...]}`.

Each chunk answers the whole schema; the server merges them. For a single field the
first non-null value wins; values that differ after normalisation (whitespace, NFC,
trailing `.` `,` `;` `:` and enclosing quotes ignored, numbers with `,` `.` or space
separators) become a `conflict`, and values equal after it are one value with all
their refs, also when the model reported them as a conflict. Lists are concatenated; an
item is dropped as a duplicate only when its values and its refs are the same, so equal
rows on different lines stay separate. An answer that is not JSON gets one repair (text outside the
outer braces cut, trailing commas removed); if it still fails, the chunk is `failed` in
the check report, never dropped silently. The result is the merged JSON in a
` ```json ` block. Per-field checks are described in [checks](checks.md#schema).

### The header

`eyes_run` returns a header of at most ~4 KB: result id, alias and model id used, files
and chunks, tokens, cost, masks per pattern, truncated and re-split chunks, the check
summary with the first problems, warnings such as `pages without text layer`, and the
first 20 lines of the result framed as `--- untrusted model output ---` … `--- end ---`
(`--- source text (masked) ---` for grep). Refs show the place of their line:
`L123 (p.12)`, `L40 (slide 3)`. The full text stays in the results store; read it with
`eyes_result`.
Examples are in [checks](checks.md).

## `eyes_result`

`{id, offset?, limit?, grep?, check?, source?, full?, cancel?}`.

- A bare id gives the status (`running`, `done`, `failed`, `cancelled`,
  `interrupted`) and the header.
- `offset`/`limit` pages through the stored result, at most 200 lines and 16 KB per
  call.
- `grep` returns matching lines with their numbers.
- `check: true` returns the check summary and the items that are not `ok` (bad,
  flagged, partial, not in input, quote mismatch, bad ref, value not in quote, null,
  conflict, failed), each text field cut to 200 characters. `check: "all"` returns every
  item.
- `source: "<name>"` pages the stored source text of that input instead: the
  extracted, masked text numbered exactly as the model saw it, with its markers.
  `offset` is the line number in that source; `grep` searches it. Framed as
  `--- source text (masked) ---`. Kept for every file that is not plain text, every
  URL, and every input of a `schema` job; see [source copies](results.md#source-copies).
- Lines longer than 400 characters are cut in paged and grep views with
  ` … (+N chars)`; `full: true` shows them whole (the 16 KB cap still applies).
- `cancel: true` aborts a running job.

**Line numbers are 1-based everywhere.** `offset` starts at 1 (the default), and page
ranges, grep numbers and `next offset` equal the `result_line` of the check report, so
`{id, offset: <result_line>, limit: 1}` shows the line a check item points to. To check
a quote, use the item's ref: `{id, source: "<name>", offset: <line>, limit: 3}`.

Results are files, so ids survive restarts; a job cut by a restart reports
`interrupted`.

### Async jobs and cancelling

With `async: true`, `eyes_run` returns the result id at once and runs the job in the
background. Poll it with `eyes_result {id}`; the status shows `running` and the
progress in chunks until it is done. `eyes_result {id, cancel: true}` aborts it.

## `eyes_stats`

Spend and jobs today (UTC day) and all time, by alias and model id (grep jobs as
`(grep, no model)`); the local budget state; the key's status from OpenRouter
(`limit`, `limit_remaining`, `limit_reset`, `usage_daily`). `models: true` adds the
[model table](models.md#choosing-models), starting with the default alias per mode;
`candidates: {min_context, max_price_in}` adds up to 10 cheap ZDR models not in your
config that your account may use.
