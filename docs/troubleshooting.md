# Troubleshooting

Symptoms seen in real use and what they mean: refusals from OpenRouter, a missing key,
a server in its setup state, missing read roots, the model pick, blocked models, a
connector that gets 404, a stale tool list, budget refusals, documents that yield no
text, and refused URLs. Start here when a call fails or a client misbehaves. Every
refusal that names a setting ends with what to do in your setup: the extension
settings in Claude Desktop, the app options in Home Assistant, the environment of the
Docker container, an environment variable, the client's arguments, or
`cheap-eyes set`.

## OpenRouter answers 403 "Access denied by security policy"

OpenRouter refuses requests from some regions. On the public catalogue calls the
refusal reads *OpenRouter refuses requests from this network (some regions are
blocked). A proxy is needed:* followed by where to set one here:

- Claude Desktop extension: *fill the Proxy field in the extension settings in Claude
  Desktop*;
- Home Assistant app: *fill the https_proxy option in the app options in Home
  Assistant*;
- Docker: *set HTTPS_PROXY=<proxy URL> and NODE_USE_ENV_PROXY=1 in the environment of
  the container*;
- elsewhere: *set HTTPS_PROXY=<proxy URL> and NODE_USE_ENV_PROXY=1 in the environment of
  the server*, or, when `HTTPS_PROXY` is set but Node ignores it, *the proxy is not in
  use: …* with the reason.

With a proxy already in use the text says the proxy is refused too: use one in another
region. Elsewhere the error shows up in the failing call, for example `HTTP 403: Access
denied by security policy` in the `eyes_run` error, or `models: unavailable (…)` and
`key: status unavailable (…)` in `eyes_stats`. See [proxy](installation.md#proxy).

## The proxy of the extension could not be switched on

Every tool call answers *the proxy in CHEAP_EYES_HTTPS_PROXY could not be switched on:*
with the reason. On a Node without `http.setGlobalProxyFromEnv` (before 24.14) the
server starts itself again with the proxy; when that copy cannot start, or ends before
it answers, the server stays up in this state instead of exiting. Run cheap-eyes on
Node 24.14 or newer, or empty the Proxy field to connect directly. `eyes_stats` and the
start line show the Node version and the proxy state.

## "OpenRouter key is not set"

The key comes only from `CHEAP_EYES_OPENROUTER_KEY`; an empty value or an unfilled
placeholder counts as not set. The refusal names where to set it here (the extension
settings, the container environment, the variable where the server is started) and
`cheap-eyes init`. `eyes_stats` lists it first under `missing:`.

## Every tool call answers with a settings error (setup state)

A stdio server whose settings cannot be used (a broken settings file, a bad value in an
environment variable) still starts, so the client lists its tools; every call answers
*settings cannot be used:* with the error and *to fix:* with the action. `cheap-eyes
check-config` prints the same and exits 1. `serve --http` refuses to start instead, so
a supervisor or container log shows it.

## A file is refused: no read roots, or outside read roots

*outside read roots: <path>; read roots: <list or none>. To add one: …* The action
depends on the setup: `cheap-eyes set read_roots <dir>...`, the client's arguments, the
extension's folders, a mount under `/input` in Docker. When the project folder was not
taken as a default, the text says why (it is the home folder, contains it, or is a
drive root): open the client in a project folder, or name folders. URLs work without
any read root. See [default read root](configuration.md#default-read-root).

## The model pick fails, or a pinned model stops working

- *no model to pick: …* No candidate fits: no ZDR text model the account allows has
  the context, the output limit and a paid endpoint within the cap. The text says when
  free variants matched (they are not picked). Allow more models at openrouter.ai →
  Guardrails, raise `max_price_usd_per_mtok`, or name a model.
- *no model passed the probe: <id>: <reason>; …* Each tried id failed the built-in test
  job (a missing line, an extra line, a cut answer, an error, 60 s passed). Name a model
  yourself: `cheap-eyes models --candidates`, then `cheap-eyes set models.<alias> <id>`.
- *models are being picked … waited 120 s.* Two servers started their first job at
  once; one waits for the other's pick, and after two minutes the waiting call is
  refused. Try again in a few minutes; the text names the lock file to delete when no
  other cheap-eyes is running.
- `model: auto re-picked: <old> -> <new> (<reason>)` in a header: the pinned ids became
  unusable and the server picked again. `cheap-eyes models --pick` picks again on
  request.

See [picked models](models.md#picked-models).

## A model is "blocked by account"

`eyes_stats {models: true}` marks an id `blocked by account`, or a call is refused with
*blocked by the account's guardrails or privacy settings — allow it at openrouter.ai →
Guardrails*. Your OpenRouter account's Guardrails (or privacy settings) don't allow
that model, even if it has ZDR endpoints. Allow it at openrouter.ai → Guardrails, or
put another id in the alias. The server skips blocked ids and uses the next id of the
alias without calling the blocked one. See
[account availability](models.md#account-availability).

## eyes_stats says "account: availability unknown (…)"

The call to `GET /api/v1/models/user` failed; the reason is in the brackets. Calls
still go ahead: no id is treated as blocked. If a model then fails with a guardrail
error, the server tries the next id of the alias. `cheap-eyes models` run without
`CHEAP_EYES_OPENROUTER_KEY` always shows this line, because the account list needs
the key.

## The settings name an unknown alias

Every value in `defaults` must be an alias defined in `models`. Otherwise the settings
are rejected and the message names the field and the alias, for example:

```text
/home/me/.config/cheap-eyes/config.json: invalid config
  field "defaults.extract": alias "fats" is not defined in models
```

A stdio server answers every call with it (setup state); `serve --http` and the Home
Assistant app stop at start. Fix the alias in the settings (or in the app's **Default
alias per mode** option). `cheap-eyes check-config` shows the same message.

## The connector gets 404

The token or the path in the connector URL is wrong. By design the server answers a
wrong path with a bare 404, with no `WWW-Authenticate` header and no OAuth discovery,
so the client never learns that a token exists. Check that the URL is exactly
`https://<host>/private_<token>/mcp`; `cheap-eyes token` prints the path in force. A
wrong bearer token on `/mcp` gets 401 instead. See [HTTP mode](security.md#http-mode).

## The client shows old tools or parameters after an update

A client can keep the tool list it fetched earlier. Refresh the connector's tool list
in the client (or remove the connector and add it again), then start a new chat.

## A job is refused over budget, or the key limit is reached

- **Local budget.** The call fails with `daily budget exceeded: spent $… + reserved $…
  + this call up to $… > daily_budget_usd $…`, then where the value comes from (the
  settings file, a variable, the default) and how to change it here. The day is a UTC
  day. Raise `daily_budget_usd`, wait for the next UTC day, or pick a cheaper alias.
  See [spending](models.md#spending).
- **Key limit.** When the key's own limit on OpenRouter is used up, OpenRouter refuses
  the call and the `eyes_run` error carries its HTTP status and message (the API
  reference lists 402 for insufficient credits or quota). Raise the limit on
  openrouter.ai.

In both cases `eyes_stats` shows today's spend, the local budget and reservations,
the probes of the model pick, and the key's `limit`, `limit_remaining` and
`usage_daily`.

## A PDF gives no text, or "no usable text layer (scanned PDF?)"

The PDF is a scan: its pages are images with no text layer, and cheap-eyes does no OCR.
A PDF whose pages average under 20 characters of text is refused; one with only some
empty pages is read, and the header lists them: `pages without text layer: 3, 7–9`.
Run the file through an OCR tool first, or give the text another way. See
[refused formats](formats.md#refused-formats).

## "unsupported format: …" or "encrypted document"

The file is a format cheap-eyes does not read (a spreadsheet, an image, an archive, an
old Office format) or needs a password to open. The format is detected from the
content, so renaming the file does not help. For a spreadsheet use grep or code;
otherwise save the file as PDF, DOCX or text. A glob skips such files and lists them in
the header. See [refused formats](formats.md#refused-formats).

## A URL is refused

The message names the reason:

- `URL refused: <host> resolves to a private, loopback or otherwise blocked address` —
  the guard refuses local and private addresses, by design; read such a page from a
  file instead.
- `port <n> … (only 80 and 443)`, `URL scheme refused`, `URL with credentials refused`.
- `content type <type> … is not read` — the server sent a type outside the allowlist
  (a PDF served as `application/octet-stream`, for example). Download it and pass the
  file.
- `sent more than max_url_bytes`, `URL timed out` — raise `max_url_bytes` or
  `url_timeout_s`.
- `URL input is off` — `url_input` is `false`.
- `HTTP 403 from <host> (some sites require a contact in User-Agent: set url_contact)`
  — the site refuses automated fetches without a contact. Set `url_contact`, e.g.
  `cheap-eyes set url_contact cheap-eyes@example.com`, and restart. The value is sent to
  every site the server fetches and does not need to be a real address. Without the
  hint, the site refuses the request for another reason.
- `a proxy is configured, but Node … cannot send URL fetches through it` — update Node
  to 22.21 or later (24.5 or later on 24).

See [URL fetch](security.md#url-fetch).
