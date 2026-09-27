# Configuration

The config file: where it is looked for, every field and its default, the environment
variables, the commands, and where the server keeps its files on each system. Read this
when writing a config or when `check-config` reports an error. The Home Assistant app
writes this file from its options; see [the app documentation](../ha-addon/cheap_eyes/DOCS.md).

## Where the config file is

A JSON file, found in this order (first hit wins):

1. the env var `CHEAP_EYES_CONFIG`;
2. `./cheap-eyes.json` in the current directory;
3. `%APPDATA%\cheap-eyes\config.json` on Windows, `~/.config/cheap-eyes/config.json`
   elsewhere.

Unknown fields are errors that name the field. Every path must be absolute (on Windows
a drive letter or `\\host\share\…`; remember to double backslashes in JSON). A
top-level `$comment` (string or list of strings) is allowed and ignored.
`cheap-eyes.example.json` shows every field.

## Fields

| Field | Default | Meaning |
|---|---|---|
| `read_roots` | required | Folders or single files the server may read. |
| `deny_globs` | `[]` | Added to the built-in list (`.env*`, `*.key`, `*.pem`, `id_*`, `secrets.yaml`, `*.db`, `.git/**`, `node_modules/**`), never replacing it. |
| `state_dir` | per OS | Results store, usage log, export manifest. Default `%LOCALAPPDATA%\cheap-eyes` or `~/.local/state/cheap-eyes`; the env var `CHEAP_EYES_STATE_DIR` wins over both. |
| `results_retention_days` | `14` | Results older than this are pruned. |
| `results_max_mb` | `500` | Above this, the oldest results are pruned. |
| `write_roots` | `[]` | Where exports may go. Empty = export off; the server writes nowhere outside `state_dir`. |
| `export_dir` | none | Copy every result here (must lie inside `write_roots`). |
| `export_retention_days` | `0` | `0` = exports are never deleted; `N` = the server deletes its own unmodified exports older than N days. |
| `models` | `{}` | `{alias: {ids: [...], params: {...}}}` — see [models](models.md). |
| `defaults` | `{}` | Alias per mode: `{extract, draft, edits}`. Each must be an alias defined in `models`. |
| `max_price_usd_per_mtok` | none | `{in, out}`: skip ids whose ZDR price per 1M tokens is higher. |
| `max_context` | live | Optional cap on the context used for chunking. |
| `allow_raw_model_ids` | `false` | Let `eyes_run.model` take a raw OpenRouter id instead of an alias. |
| `daily_budget_usd` | `1.0` | Local cap per UTC day; `null` switches it off explicitly. |
| `max_file_bytes` | 2 MB | Larger files are refused (never truncated). |
| `max_job_bytes` | 5 MB | Cap on one job after filtering. |
| `max_files` | `200` | Cap on files per job. |
| `concurrency` | `3` | Chunks in flight at once. |
| `timeout_s` | `180` | Per model call. |
| `mask.extra_patterns` | `[]` | Your own regexes, masked as `[token]`. |
| `hook.max_bytes` | `30720` | Threshold for the [hook](hook.md). |
| `time.default_tz` | `UTC` | How to read log timestamps that carry no offset. |

## Environment variables

| Variable | |
|---|---|
| `CHEAP_EYES_OPENROUTER_KEY` | The OpenRouter key; never logged, echoed or put in error messages. |
| `CHEAP_EYES_HTTP_TOKEN` | The token for [HTTP mode](installation.md#http-mode). |
| `CHEAP_EYES_CONFIG` | Path of the config file; wins over the other locations. |
| `CHEAP_EYES_STATE_DIR` | The state directory; wins over `state_dir` and the default. |
| `HTTPS_PROXY` + `NODE_USE_ENV_PROXY` | An outbound [proxy](installation.md#proxy). |

## Commands

```text
cheap-eyes                  MCP server on stdio (default)
cheap-eyes serve --http     MCP server over Streamable HTTP
cheap-eyes check-config     validate the config, print the resolved settings; no network
cheap-eyes models [--candidates [--min-context N] [--max-price-in USD]]
                            model table from OpenRouter (USD per 1M tokens)
```

`check-config` prints which config file won, the resolved read roots, the state and
results directories, export settings, retention, model aliases and defaults, the
limits, whether the key and the HTTP token are set, and the proxy state. It never
prints a secret.

## Where files live

| | Windows | Linux / macOS | Docker, Home Assistant |
|---|---|---|---|
| Config file | `%APPDATA%\cheap-eyes\config.json` | `~/.config/cheap-eyes/config.json` | mounted file / written from the app options |
| State directory | `%LOCALAPPDATA%\cheap-eyes` | `~/.local/state/cheap-eyes` | `/data` |

The state directory holds `results/`, the usage log `usage.jsonl` and the export
manifest `exports.jsonl`; it is created on start. What each holds is in
[results](results.md).
