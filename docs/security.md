# Security

What the model can reach, what leaves your machine and where it goes, which files and
URLs the server may read and write, how secrets are masked, how HTTP mode is guarded,
and what a leaked token gives. Read this before pointing `read_roots` at sensitive folders or
exposing the server beyond your own machine.

## The model has no tools

The model has **no tools at all**: it cannot open files, browse or call anything. It
sees only the masked, numbered lines the server chose to send, so a prompt injection
hidden in a log line has nothing to reach for, and every claim it makes can be traced
to a line the server knows it sent. Everything the model returns is framed as
untrusted output (`--- untrusted model output ---` … `--- end ---`).

## Where data goes

- The server talks to `openrouter.ai` for `eyes_run` calls and the model and key
  lists. The only other requests are the `http(s)` URLs named in `eyes_run.files`,
  fetched by the server itself (see [URL fetch](#url-fetch)); `url_input: false` turns
  them off. Nothing else leaves the machine.
- Every request requires Zero Data Retention endpoints — providers that don't store
  your prompts (`provider: {zdr: true, data_collection: "deny"}`) — and switches
  OpenRouter's prompt compression off. A model id without a ZDR endpoint is refused,
  never silently replaced. OpenRouter only, ZDR endpoints only.
- Your OpenRouter account's own guardrails and privacy settings apply on top; see
  [account availability](models.md#account-availability).
- The API key comes only from the env var `CHEAP_EYES_OPENROUTER_KEY`. It is never
  logged, echoed or put in error messages.

## Read roots and paths

- `files` takes absolute paths or globs that start inside a `read_roots` entry;
  relative paths are refused.
- Each file is resolved with `realpath` and must still lie inside a read root, compared
  by path segments, case-insensitive on Windows, UNC paths (`\\host\share\…`)
  included.
- Any `..` segment is refused.
- Binaries, unsupported formats (see [formats](formats.md#refused-formats)) and files
  over the size limits are refused, never truncated. Every refusal names the path.
- Every format but plain text is extracted in a worker thread with a timeout and a
  heap cap, so a hostile file cannot hang or exhaust the server. ZIP containers are
  read with limits on entries and unpacked size, and XML without DTD processing (no
  entity expansion).
- Globs honour the nearest `.gitignore`.
- A line range `#L100-L400` works on a single file only.

### Deny list

Deny-listed names are refused: the built-in list `.env*`, `*.key`, `*.pem`, `id_*`,
`secrets.yaml`, `*.db`, `.git/**`, `node_modules/**`, plus your own `deny_globs`
(added to the built-in list, never replacing it).

## URL fetch

A URL in `files` is fetched by the server; the agent never sees the raw page.

- **Scheme and port:** `http` and `https` only, ports 80 and 443 only; URLs with a
  user name or password are refused. No cookies, no `Authorization`.
- **Address guard:** before every request and every redirect (at most 5), IP literals
  and every address the host name resolves to are checked against a `net.BlockList`:
  loopback, `0.0.0.0/8`, RFC 1918, CGNAT `100.64.0.0/10`, link-local
  `169.254.0.0/16` (cloud metadata `169.254.169.254` included) and `fe80::/10`, ULA
  `fc00::/7`, multicast, reserved `240.0.0.0/4`, `::` and `::1`, IPv4-mapped IPv6 of
  all of those, the whole IPv4-compatible `::/96`, and the IPv4 address inside NAT64
  (`64:ff9b::/96`, `64:ff9b:1::/48`) and 6to4 (`2002::/16`) addresses. One blocked
  address refuses the URL; the message names the host, not the addresses.
- **Pinned connection:** without a proxy the connection uses only the addresses that
  passed the check (the server's own `lookup`), so a DNS answer that changes between
  the check and the connection (DNS rebinding) cannot reach a private address. The
  `Host` header and the TLS name check stay on the host name.
- **Behind a proxy** (`HTTPS_PROXY` for `https://`, `HTTP_PROXY` for `http://`, with
  `NODE_USE_ENV_PROXY=1`; Node ≥ 22.21 or ≥ 24.5), the proxy resolves the name itself.
  The local check still runs and refuses a name that resolves to a blocked address
  here, but it is best effort: the proxy may resolve differently. A name that does not
  resolve locally is left to the proxy. With a proxy set and an older Node, URL fetches
  are refused rather than sent around the proxy.
- **Limits:** `url_timeout_s` for the whole fetch, `max_url_bytes` counted while
  streaming and after decompression, an allowlist of content types (see
  [tools](tools.md#url-input)).
- **What is kept:** the fetched text is masked like a file. The full URL (every query
  value masked) and the final URL after redirects go to the sources index of the
  result; the usage log holds the host and the size only.

## Secret masking

Masking is always on and cannot be switched off per call. It runs on the file lines
and on the task before anything leaves the machine, and each header counts the hits
per pattern. Grep runs on the masked text, so a pattern cannot be used to probe a
secret. Existing masks such as `[token]` or `<SECRET>` stay as they are.

- **Token shapes:** UUIDs → `[uuid]`; 43-character base64/base64url keys (WireGuard,
  Reality) → `[key]`; exactly 32 hex characters → `[id]` (40-character commit SHAs and
  short hashes survive); mixed-case alphanumerics 28–40 long with a digit →
  `[token]`; `sk-…` keys → `[key]`; GitHub tokens (`ghp_…`, `github_pat_…`), JWTs and
  Telegram bot tokens → `[token]`.
- **Headers:** the value of an `Authorization` header and `Bearer <value>` →
  `[token]`.
- **Key–value secrets** in JSON, YAML, env and INI form: the value is masked when the
  key contains `password`, `passwd`, `pwd`, `secret` or `token` as a segment, or `key`
  together with `api`, `access`, `private`, `secret`, `client` or `auth`
  (`bot_token`, `apiKey` and `api_access_key` are masked; `max_tokens` and
  `cache_key` are not; `PWD` and `OLDPWD` are exempt). A YAML block value (`|`, `>`)
  under such a key is masked line by line.
- **URLs:** credentials before `@` become `scheme://[token]@host`; VLESS/Reality
  query values `pbk=` and `sid=` are masked.
- **PEM blocks** → `[key]`.
- **Your own patterns** from `mask.extra_patterns` → `[token]`.

Masking is pattern-based: it over-masks rather than under-masks, but a secret in an
unusual shape can pass. Add `mask.extra_patterns` for yours, and audit with `dry_run`.

## Writes

With `write_roots` empty (the default) the server writes nowhere outside its
`state_dir`. Export into your folders is opt-in and guarded: see
[export](results.md#export). The server never applies the edits it proposes.

## HTTP mode

- A token of at least 32 characters is required; the server refuses to start without
  one. It may contain only `A-Z a-z 0-9 . _ ~ -`, since it is also a URL path segment.
  It is compared in constant time.
- A wrong path gets a bare 404 without `WWW-Authenticate`. `/.well-known/oauth-*` is
  404 too, so claude.ai sees an authless server and never starts an OAuth flow.
- A wrong bearer token gets 401.
- Neither the token nor the request path is ever logged.
- On the default loopback bind the server also checks the `Host` and `Origin`
  headers; with any other `--host` the token is the only guard, so put a TLS reverse
  proxy in front for remote clients.

## If the token leaks

Whoever has it can, until you change it:

- run `eyes_run` over everything under `read_roots` and read the masked results;
- read the results already stored in the results store;
- write result files into `export_dir`, if set;
- make the server fetch public web pages (not private addresses) and read the masked
  text, unless `url_input` is `false`;
- spend money up to `daily_budget_usd` per day and the key's own limit.

Change the token and restart the server; consider rotating the OpenRouter key.

If the export folder is shared with other tools, the server writes there with its own
rules only: whatever conventions other tools keep in that folder (for example a notes
vault) do not apply. Keep it a scratch folder.
