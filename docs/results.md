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

Each job is `<id>.md` + `<id>.check.json`, id `YYYY-MM-DD_HHMMSS-<mode>-<hash>` (UTC).

## The usage log

The usage log `usage.jsonl` next to the results store holds times, aliases, model ids,
file names and sizes, tokens, cost and check counts — no task text, no content, no
model output. `eyes_stats` and the model table read it.

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
