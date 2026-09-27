# Tools

The three MCP tools: their inputs, what they return, how to page through a stored
result, and how async jobs and cancelling work. Read this when calling the tools
directly or when a client shows a parameter you don't recognise.

Tool schemas are sent to the client in every session, so there are exactly three and
their descriptions are short.

## `eyes_run`

Runs one job: reads the files, masks, filters, chunks, calls the model and checks the
answer (the steps are in [internals](internals.md#how-it-works)).

| Input | Meaning |
|---|---|
| `task` | What to look for or write. Masked like file content. |
| `mode` | `extract`, `draft` or `edits` (see [checks](checks.md)). |
| `model` | Alias; default `defaults[mode]`. Raw ids only with `allow_raw_model_ids`. |
| `files` | Absolute paths or globs inside `read_roots`. `#L100-L400` range on a single file. |
| `grep` | `{pattern, context = 3, ignore_case}` — send only matching windows. Runs in a worker with a timeout. |
| `time` | `{since, until, tz}` (ISO 8601) — keep log lines whose timestamp is in the window. Continuation lines (tracebacks) stay with their stamped line; a file with no recognised timestamp is an error. Recognises ISO 8601, `YYYY-MM-DD HH:MM:SS[.mmm]`, syslog `Mon DD HH:MM:SS` and journalctl short-iso. |
| `export_to` | Also copy the result here (inside `write_roots`). |
| `overwrite` | Replace an earlier export of this server at that path. |
| `max_tokens` | Output cap per chunk, default 4096, capped by the model's ZDR limit. Always sent, so the budget reservation is a real ceiling. |
| `dry_run` | Run steps 1–4, store the exact request bodies as the result, call no model (only the public ZDR list is fetched to size the chunks). This is how you audit what would be sent. |
| `async` | Return the result id at once; poll `eyes_result`. |

### The header

`eyes_run` returns a header of at most ~4 KB: result id, alias and model id used, files
and chunks, tokens, cost, masks per pattern, truncated chunks, the check summary with
the first bad items, and the first 20 lines of the result framed as
`--- untrusted model output ---` … `--- end ---`. The full text stays in the results
store; read it with `eyes_result`. Examples are in [checks](checks.md).

## `eyes_result`

`{id, offset?, limit?, grep?, check?, cancel?}`.

- A bare id gives the status (`running`, `done`, `failed`, `cancelled`,
  `interrupted`) and the header.
- `offset`/`limit` pages through the stored result, at most 200 lines and 16 KB per
  call.
- `grep` returns matching lines with their numbers.
- `check: true` returns the check report, bad items first.
- `cancel: true` aborts a running job.

**Line numbers are 1-based everywhere.** `offset` starts at 1 (the default), and page
ranges, grep numbers and `next offset` equal the `result_line` of the check report, so
`{id, offset: <result_line>, limit: 1}` shows the line a check item points to.

Results are files, so ids survive restarts; a job cut by a restart reports
`interrupted`.

### Async jobs and cancelling

With `async: true`, `eyes_run` returns the result id at once and runs the job in the
background. Poll it with `eyes_result {id}`; the status shows `running` and the
progress in chunks until it is done. `eyes_result {id, cancel: true}` aborts it.

## `eyes_stats`

Spend and jobs today (UTC day) and all time, by alias and model id; the local budget
state; the key's status from OpenRouter (`limit`, `limit_remaining`, `limit_reset`,
`usage_daily`). `models: true` adds the [model table](models.md#choosing-models),
starting with the default alias per mode; `candidates: {min_context, max_price_in}`
adds up to 10 cheap ZDR models not in your config that your account may use.
