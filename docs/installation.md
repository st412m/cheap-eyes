# Installation

The ways to run cheap-eyes: on stdio for Claude Code and Claude Desktop, as an HTTP
server, in Docker, as a Home Assistant app, and behind an outbound proxy. Read this
when installing, or when moving from one setup to another.

- [What you need](#what-you-need)
- [Claude Code and Claude Desktop (npx / stdio)](#npx--stdio)
- [HTTP mode](#http-mode)
- [Docker](#docker)
- [Home Assistant app](#home-assistant-app)
- [Proxy](#proxy)

## What you need

- Node.js ≥ 22.17 (22 LTS or 24), or Docker, or Home Assistant OS / Supervised.
- An OpenRouter API key in the env var `CHEAP_EYES_OPENROUTER_KEY` — deliberately not
  `OPENROUTER_API_KEY`, which other tools pick up. Use a **dedicated key with its own
  daily limit** (see [spending](models.md#spending)).
- A config file (see [configuration](configuration.md)). The smallest useful one:

```json
{
  "read_roots": ["/home/me/notes"],
  "models": { "fast": { "ids": ["qwen/qwen3.6-35b-a3b"], "params": { "reasoning": { "effort": "none" } } } },
  "defaults": { "extract": "fast", "draft": "fast", "edits": "fast" }
}
```

Then check it — no network, no secrets printed:

```sh
npx -y cheap-eyes check-config
```

## npx / stdio

The default mode is an MCP server on stdio, for Claude Code, Claude Desktop or any
local MCP client.

Claude Code:

```sh
claude mcp add --env CHEAP_EYES_OPENROUTER_KEY=<OPENROUTER_KEY> --transport stdio cheap-eyes -- npx -y cheap-eyes
```

Claude Desktop (`claude_desktop_config.json`) or a project `.mcp.json`:

```json
{
  "mcpServers": {
    "cheap-eyes": {
      "command": "npx",
      "args": ["-y", "cheap-eyes"],
      "env": { "CHEAP_EYES_OPENROUTER_KEY": "<OPENROUTER_KEY>" }
    }
  }
}
```

A global install (`npm install -g cheap-eyes`) gives a stable `cheap-eyes` command and a
stable path for the [hook](hook.md).

## HTTP mode

```sh
cheap-eyes serve --http [--port 3400] [--host 127.0.0.1] [--token-file FILE]
```

Streamable HTTP, a fresh stateless MCP server per request. A token of at least 32
characters is required, from `--token-file` or the env var `CHEAP_EYES_HTTP_TOKEN`; the
server refuses to start without one. Two ways in:

- `https://<host>/private_<token>/mcp` — the secret path. Works as a **claude.ai custom
  connector** (**Settings → Connectors → Add custom connector**).
- `https://<host>/mcp` with an `Authorization` header carrying the bearer token.

The default bind is `127.0.0.1`. For clients on other machines, bind another `--host`
and put a TLS reverse proxy in front. How the token, wrong paths and the bind address
are handled is in [security](security.md#http-mode).

Claude Code against an HTTP instance:

```sh
claude mcp add --transport http cheap-eyes https://<host>/private_<token>/mcp
```

## Docker

The repository's `Dockerfile` builds a small image (Node 22 on Alpine, pinned tag; the
`cheap-eyes` release from npm; runs as the unprivileged `node` user) that serves HTTP
on port 3400 with its state in the volume `/data`. `compose.example.yaml` shows a
complete setup: the config file mounted read-only, input folders mounted `:ro`, an
optional export volume, the key and token from `.env`.

Copy it to `compose.yaml` (git-ignored), write `.env` and `cheap-eyes.json` next to it,
then:

```sh
docker compose up -d --build
```

Paths in the config are paths inside the container (`/input/notes`, not the host
path). Nothing is published to a registry; you build the image yourself.

## Home Assistant app

Home Assistant renamed *add-ons* to *apps* in 2026.2; on older versions the same menus
say *Add-ons* and *Add-on Store*.

1. Add this repository in the app store: menu ⋮ → **Repositories** →
   `https://github.com/st412m/cheap-eyes`.
2. Install **cheap-eyes**. Supervisor builds the image on your machine from the pinned
   `cheap-eyes` release on npm.
3. Fill in the options and start the app. It runs the HTTP mode on port 3400.

Options, the connector URL and what a leaked token gives are in
[the app documentation](../ha-addon/cheap_eyes/DOCS.md).

## Proxy

There is no proxy by default anywhere. If you need one for the calls to OpenRouter —
for example because OpenRouter refuses your region (see
[troubleshooting](troubleshooting.md#openrouter-answers-403-access-denied-by-security-policy)) —
set both variables (Node ≥ 22.21 or 24):

```sh
HTTPS_PROXY=http://proxy.example.com:3128
NODE_USE_ENV_PROXY=1
```

The same proxy is used for `https://` URLs in `eyes_run.files`; `http://` URLs use
`HTTP_PROXY` and go direct when only `HTTPS_PROXY` is set. Fetching URLs through a
proxy needs Node ≥ 22.21 (≥ 24.5 on 24); see [URL fetch](security.md#url-fetch).

Without `NODE_USE_ENV_PROXY=1` Node ignores `HTTPS_PROXY`. `check-config` prints
`proxy: HTTPS_PROXY set` or `proxy: direct`, never the proxy URL (it may carry
credentials). The Home Assistant app has an `https_proxy` option that sets both;
`compose.example.yaml` has them commented out.
