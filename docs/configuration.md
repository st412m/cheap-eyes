# Configuration

Everything works without a settings file: every field has a default, the read root of
a stdio server defaults to the project folder, and the models are picked on the first
job. This page covers where settings come from, `cheap-eyes set`, the settings file and
every field, the environment variables, the commands, and where the server keeps its
files. Read it when you want to change a default or when `check-config` reports an
error. The Home Assistant app writes its settings from its options; see
[the app documentation](../ha-addon/cheap_eyes/DOCS.md).

## Where settings come from

First source wins, per field:

1. **Arguments.** A stdio server takes its read roots as arguments:
   `cheap-eyes /home/me/notes /home/me/logs`. A folder argument must contain a path
   separator; a folder named like a command is passed as `./serve`.
2. **Environment variables** (below). An empty value counts as not set.
3. **The settings file.**
4. **Defaults** (the table of fields).

`cheap-eyes check-config` prints every value in force and, for each one that did not
come from the file, its source: `arguments`, `env CHEAP_EYES_READ_ROOTS`, `default`.

## Default read root

When no source names `read_roots`, a stdio server reads the project folder:

1. `CLAUDE_PROJECT_DIR` (Claude Code sets it for the servers it starts), when it is an
   absolute path of an existing folder;
2. otherwise the working directory of the process.

The folder is resolved (symlinks followed) and refused as a default when it is the home
folder, a folder that contains the home folder, or a filesystem or drive root. Then
there is no read root: the server still starts, URL jobs work, and a file path is
refused with how to add a folder. The start line and `check-config` say
`read roots: <path> (default: project folder)` or `read roots: none`, with the reason
when the project folder was refused. `serve --http` has no default: no read roots given
means none.

## `cheap-eyes set`

```sh
cheap-eyes set read_roots /home/me/notes /home/me/logs
cheap-eyes set daily_budget_usd 2
cheap-eyes set max_price_usd_per_mtok 0.5 2
cheap-eyes set read_roots
```

`set <key> <value>...` writes one setting into the settings file (it creates the folder
and the file); `set <key>` with no value removes the key, so the default applies again.
Without a global install, run the same through `npx -y cheap-eyes set …`.

- Settable: every scalar field, `read_roots`, `write_roots` and `deny_globs` (one
  argument per item; the whole list each time), `defaults.<mode>`, `time.default_tz`,
  `hook.max_bytes`, `max_price_usd_per_mtok <in> <out>` (both halves; `.in` and `.out`
  change one half of an existing cap), and `models.<alias>` (ids separated by commas;
  reasoning `none`).
- The result is validated before it is written; on an error nothing is written and
  the message names the field.
- A folder that does not exist is written with a warning that names it.
- It says where it wrote, that a running server uses the change after a restart (over
  stdio: restart the client), and warns when an environment variable or the arguments
  override the key.
- It never takes the OpenRouter key or the HTTP token.
- When `CHEAP_EYES_CONFIG` or `./cheap-eyes.json` is the file in force, `set` writes
  that file and says so.

## The settings file

A JSON file, found in this order (first hit wins):

1. the env var `CHEAP_EYES_CONFIG` (set and missing is an error);
2. `./cheap-eyes.json` in the current directory;
3. `%APPDATA%\cheap-eyes\config.json` on Windows, `~/.config/cheap-eyes/config.json`
   elsewhere (the file `cheap-eyes set` writes).

Unknown fields are errors that name the field. Every path must be absolute (on Windows
a drive letter or `\\host\share\…`; remember to double backslashes in JSON). A
top-level `$comment` (string or list of strings) is allowed and ignored.

A short example (the model id is a placeholder; the pick of [models](models.md) needs
none):

```json
{
  "read_roots": ["/home/me/notes", "/home/me/logs"],
  "daily_budget_usd": 2,
  "max_price_usd_per_mtok": { "in": 0.5, "out": 2 },
  "models": { "fast": { "ids": ["<openrouter model id>"], "params": { "reasoning": { "effort": "none" } } } },
  "defaults": { "extract": "fast", "draft": "fast", "edits": "fast" }
}
```

A stdio server that finds the file broken still starts, in a setup state: the client
gets the tool list, and every call answers with the error and what to fix.
`check-config` exits 1, and `serve --http` refuses to start.

## Fields

| Field | Default | Meaning |
|---|---|---|
| `read_roots` | none (stdio: the project folder) | Folders or single files the server may read. |
| `deny_globs` | `[]` | Added to the built-in list (`.env*`, `*.key`, `*.pem`, `id_*`, `secrets.yaml`, `*.db`, `.git/**`, `node_modules/**`), never replacing it. |
| `state_dir` | per OS | Results store, usage log, export manifest, the picked models, the HTTP token. Default `%LOCALAPPDATA%\cheap-eyes` or `~/.local/state/cheap-eyes`; the env var `CHEAP_EYES_STATE_DIR` wins over both. |
| `results_retention_days` | `14` | Results older than this are pruned. |
| `results_max_mb` | `500` | Above this, the oldest results are pruned. |
| `write_roots` | `[]` | Where exports may go. Empty = export off; the server writes nowhere outside `state_dir`. |
| `export_dir` | none | Copy every result here (must lie inside `write_roots`). |
| `export_retention_days` | `0` | `0` = exports are never deleted; `N` = the server deletes its own unmodified exports older than N days. |
| `models` | `{}` | Empty: the server picks models. Or `{alias: {ids: [...], params: {...}}}`; see [models](models.md). |
| `defaults` | `{}` | Alias per mode: `{extract, draft, edits, schema}`. Each must be an alias defined in `models`; `schema` falls back to the `extract` alias. |
| `max_price_usd_per_mtok` | none (picked models: in 1, out 4) | `{in, out}` in USD per 1M tokens: an id counts only when one of its ZDR endpoints fits, and every request carries it as `provider.max_price`. |
| `max_context` | live | Optional cap on the context used for chunking. |
| `allow_raw_model_ids` | `false` | Let `eyes_run.model` take a raw OpenRouter id instead of an alias. |
| `daily_budget_usd` | `1.0` | Local cap per UTC day; `null` switches it off explicitly. |
| `max_file_bytes` | 2 MB | Plain text files over this are refused (never truncated); for every other format it caps the extracted text. |
| `max_doc_bytes` | 50 MB | Raw size of a file of any format but plain text before extraction; the decoded attachments of a message together get a separate `max_doc_bytes` of their own. |
| `extract_timeout_s` | `60` | One extraction; it runs in a worker thread and is stopped after this. |
| `max_job_bytes` | 5 MB | Cap on one job after filtering. |
| `max_files` | `200` | Cap on files per job. |
| `concurrency` | `3` | Chunks in flight at once. |
| `timeout_s` | `180` | Per model call. |
| `url_input` | `true` | Allow `http(s)` URLs in `eyes_run.files`; `false` refuses them. |
| `url_contact` | empty | Optional, leave empty. Only for sites that refuse automated fetches without a contact (HTTP 403). The value is sent to every site the server fetches; it does not need to be a real address, e.g. `cheap-eyes@example.com`. 1–100 printable ASCII characters without `(`, `)` or `;`. Anything else is a settings error. It is shown by `check-config` and never goes into the usage log or a result. |
| `url_timeout_s` | `30` | One URL fetch, redirects included. |
| `max_url_bytes` | 10 MB | One fetched URL, counted while streaming; over it the URL is refused. |
| `mask.extra_patterns` | `[]` | Your own regexes, masked as `[token]`. |
| `hook.max_bytes` | `30720` | Threshold for the [hook](hook.md). |
| `time.default_tz` | `UTC` | How to read log timestamps that carry no offset. |

## Environment variables

| Variable | |
|---|---|
| `CHEAP_EYES_OPENROUTER_KEY` | The OpenRouter key; never logged, echoed or put in error messages. |
| `CHEAP_EYES_READ_ROOTS` | `read_roots`: absolute paths joined by `;` on Windows, `:` elsewhere. |
| `CHEAP_EYES_DAILY_BUDGET_USD` | `daily_budget_usd`: a positive number, or `off`. |
| `CHEAP_EYES_CONFIG` | Path of the settings file; wins over the other locations. |
| `CHEAP_EYES_STATE_DIR` | The state directory; wins over `state_dir` and the default. |
| `CHEAP_EYES_HTTP_TOKEN` | The token for [HTTP mode](installation.md#http-mode); wins over the saved one. |
| `CHEAP_EYES_SETTINGS_UI` | Set by a launcher (the Claude Desktop extension, the Docker image, the Home Assistant app): names where a person changes settings, so refusals point there. |
| `CHEAP_EYES_HTTPS_PROXY` | A proxy passed by a stdio launcher that cannot set `HTTPS_PROXY` itself (the Claude Desktop extension); see [proxy](installation.md#proxy). |
| `HTTPS_PROXY` / `HTTP_PROXY` + `NODE_USE_ENV_PROXY` | An outbound [proxy](installation.md#proxy) for OpenRouter and for fetched URLs (`HTTP_PROXY` for `http://` URLs). |

## Commands

```text
cheap-eyes [<dir>...]       MCP server on stdio (default); the folders are the read roots
cheap-eyes serve --http [--port 3400] [--host 127.0.0.1] [--token-file F]
                            MCP server over Streamable HTTP
cheap-eyes token [--new]    print the connector path and the Bearer line; --new replaces the token
cheap-eyes set <key> [<value>...]
                            write a setting into the settings file; no value: the default
cheap-eyes init [--client C] [--roots <dir>...] [--proxy URL] [--no-browser] [--yes]
                            set-up on a terminal: network, key, folders, models, client
cheap-eyes hook install [--project] | hook remove [--project]
                            the Claude Code hook; see hook.md
cheap-eyes check-config [--live]
                            validate the settings, print what is in force; --live adds
                            the checks against OpenRouter
cheap-eyes models [--candidates [--min-context N] [--max-price-in USD]]
                            model table from OpenRouter (USD per 1M tokens)
cheap-eyes models --pick    with no models in the settings: probe candidates and pin the pick
cheap-eyes bench [--suite DIR] [--models a,b] [--modes extract,schema] [--repeat N]
                 [--out FILE] [--max-usd USD]
                            run a suite with expected answers; see bench.md
```

`check-config` prints which settings file won (or `settings file: none (cheap-eyes set
writes <path>)`), the resolved read roots, the state and results directories, export
settings, retention, the models (aliases and defaults, or the pin), the price cap, the
limits (documents and URL input included), whether the key and the HTTP token are set,
the proxy state and the Node version. It never prints a secret and makes no network
call. `check-config --live` adds: OpenRouter reachable, the key's status and limit, how
many models the account allows, whether each pinned id is still usable, and the proxy
in use; it exits 1 when one of them fails.

### `cheap-eyes init`

A wizard on a terminal that prints what it found before each question:

1. the Node version and the proxy state;
2. whether OpenRouter answers from this network; on HTTP 403 it asks for a proxy and
   continues through it (`--proxy URL` skips the question);
3. the key: `CHEAP_EYES_OPENROUTER_KEY` when set, otherwise a browser sign-in to
   OpenRouter that creates a key (`--no-browser`: you paste the code), or a pasted key;
   it warns when the key has no spending limit;
4. the folders (for Claude Code the default is the project folder of each session);
5. the models: the pick with the probe;
6. the client: for Claude Code it offers to run `claude mcp add` itself; for Claude
   Desktop it points to the extension; for other clients it prints the JSON block; for
   HTTP the `serve` command;
7. the `check-config --live` summary and a prompt to try.

It writes no secret anywhere: the key ends up only in the client's own settings.
Without a terminal it needs `--yes` and the answers as flags.

## Where files live

| | Windows | Linux / macOS | Docker, Home Assistant |
|---|---|---|---|
| Settings file | `%APPDATA%\cheap-eyes\config.json` | `~/.config/cheap-eyes/config.json` | none (Docker: environment variables), or written from the app options |
| State directory | `%LOCALAPPDATA%\cheap-eyes` | `~/.local/state/cheap-eyes` | `/data` |

The state directory holds `results/`, the usage log `usage.jsonl`, the export manifest
`exports.jsonl`, the picked models `models.json` and the HTTP token `token`; it is
created on start. What each holds is in [results](results.md).
