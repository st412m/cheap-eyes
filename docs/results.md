# Results, export and cleanup

Where the server keeps every result, what it logs, how to export a copy into your own
folders, and how old results and exports are cleaned up. Read this when choosing an
export folder or a retention setting.

## The results store

A remote client may have no file access at all (claude.ai reads no files unless you
also run a filesystem MCP), so the server keeps every result itself and serves it back
through [`eyes_result`](tools.md#eyes_result). Writing into your folders is optional.

| Install | Results store |
|---|---|
| npx / global, Windows | `%LOCALAPPDATA%\cheap-eyes\results\` |
| npx / global, Linux/macOS | `~/.local/state/cheap-eyes/results/` |
| Docker | `/data/results` in the `/data` volume |
| Home Assistant app | `/data/results` inside the app (excluded from HA backups) |

Each job is `<id>.md` + `<id>.check.json`, id `YYYY-MM-DD_HHMMSS-<mode>-<hash>` (UTC),
plus `<id>.sources/` when it keeps [source copies](#source-copies).

## Source copies

For every input that is not plain text, every URL, and every input of a `schema`
job, the result keeps the text the model was given, so a quote can be checked later
without the original file or page:

| File | What it holds |
|---|---|
| `<n>.txt` | The extracted, normalised, masked text, numbered exactly as sent (`L12\| …`), with the page and section marker lines. |
| `<n>.json` | The marker lines, the page table of a PDF (`page_starts`) and the sections (`sections`: `kind`, `n`, `label`, `start`, `end`, 1-based lines, `end` inclusive) that give the places in refs. |
| `index.json` | Per source: `name`, `kind` (`file` or `url`), the path or the URL (query values masked), the final URL after redirects, content type, format, size, sha256 of the raw input, fetch time, pages, lines. |

`eyes_result {id, source: "<name>"}` pages and greps it (see
[tools](tools.md#eyes_result)). Plain local text files of `extract`, `draft` and
`edits` jobs get no copy: the file itself is the source. Source copies are pruned with
their result and count toward `results_max_mb`.

## The usage log

The usage log `usage.jsonl` next to the results store holds times, aliases, model ids,
file names and sizes (for a URL only the host), tokens, cost and check counts — no task
text, no content, no model output. Bench runs are logged like any `eyes_run`. `eyes_stats` and the model table read it.

## Export

Off by default. With `write_roots` set, a call's `export_to` or the config's
`export_dir` puts a copy of the result and its check report there. The target must lie
inside `write_roots` after `realpath`; symlinks, dotfiles and anything under
`.vault-trash/` are refused; new files are created exclusively and recorded in
`exports.jsonl`; `overwrite: true` works only for a file this server wrote. The server
writes nowhere else.

## Cleanup

Cleanup is your choice. The results store is the server's own cache and is always
pruned (`results_retention_days`, then oldest first above `results_max_mb`; at start
and hourly). Exports are yours: with `export_retention_days: 0` (default) the server
never deletes them; with `N` it deletes its own exports older than N days, and only
if their size and mtime still match the manifest — a file anyone edited is kept.
Nothing else is ever deleted.
