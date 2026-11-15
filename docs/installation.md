# Installation

The ways to run cheap-eyes, by where your AI lives: Claude Code, Claude Desktop, Home
Assistant, Docker, other MCP clients, claude.ai; then the HTTP mode and the proxy. Read
this when installing, or when moving from one setup to another.

- [What you need](#what-you-need)
- [Claude Code](#claude-code)
- [Claude Desktop](#claude-desktop)
- [Home Assistant app](#home-assistant-app)
- [Docker](#docker)
- [Other MCP clients](#other-mcp-clients)
- [claude.ai](#claudeai)
- [HTTP mode](#http-mode)
- [Proxy](#proxy)

## What you need

- **An OpenRouter account with credits.** cheap-eyes uses your OpenRouter key, in the
  env var `CHEAP_EYES_OPENROUTER_KEY` (deliberately not `OPENROUTER_API_KEY`, which
  other tools pick up). `cheap-eyes init` can create the key through a browser sign-in.
  Give the key a **spending limit** on openrouter.ai: it is the real ceiling (see
  [spending](models.md#spending)).
- **A proxy, only where OpenRouter refuses your network.** OpenRouter answers HTTP 403
  to some regions; see [proxy](#proxy).
- Node.js ≥ 22.17 (22 LTS or 24) for npx; the Claude Desktop extension runs on the
  Node.js built into Claude Desktop; or Docker; or Home Assistant OS / Supervised.
- **For claude.ai only:** the HTTP mode behind your own TLS reverse proxy, reachable
  from the internet.

No settings file is needed: see [configuration](configuration.md).

## Claude Code

```sh
npx -y cheap-eyes init
```

`init` checks that OpenRouter answers (and asks for a proxy when it does not), gets the
key (the existing `CHEAP_EYES_OPENROUTER_KEY`, a browser sign-in, or a pasted key),
picks the models, and offers to run `claude mcp add` for you. Then ask Claude Code:
*"Use eyes_run to list every TODO in the markdown files of this project, with the line
it's on."*

By hand, without `init`:

```sh
claude mcp add --scope user --env CHEAP_EYES_OPENROUTER_KEY=<OPENROUTER_KEY> --transport stdio cheap-eyes -- npx -y cheap-eyes
```

Without `--scope user`, Claude Code adds the server for the current folder only.
Claude Code keeps the key in its own settings file. The server reads the project folder
of each session (`CLAUDE_PROJECT_DIR`); it refuses the home folder and drive roots as a
default, so open Claude Code in a project folder, or name folders with
`cheap-eyes set read_roots <dir>...` (see [default read root](configuration.md#default-read-root)).

A global install (`npm install -g cheap-eyes`) gives a stable `cheap-eyes` command and a
stable path for the [hook](hook.md) (`cheap-eyes hook install`).

## Claude Desktop

Download `cheap-eyes-<version>.mcpb` from the
[latest release](https://github.com/st412m/cheap-eyes/releases/latest) and open it with
Claude Desktop. The extension's settings ask for:

- **OpenRouter key** (required);
- **Folders to read** (required: at least one folder, or the form cannot be saved;
  Claude Desktop has no project folder);
- **Proxy**: leave it empty for a direct connection; fill it only where OpenRouter
  refuses your network (`http://host:port`, with the login in it when the proxy needs
  one);
- **Daily budget (USD)**, default 1.

The models are picked on the first job. `eyes_stats` shows the Node version and the
proxy state the extension runs with.

Instead of the extension, a JSON block in `claude_desktop_config.json` works too (Node.js
must be installed; name the folders as arguments):

```json
{
  "mcpServers": {
    "cheap-eyes": {
      "command": "npx",
      "args": ["-y", "cheap-eyes", "C:\\Users\\me\\Documents\\notes"],
      "env": { "CHEAP_EYES_OPENROUTER_KEY": "<OPENROUTER_KEY>" }
    }
  }
}
```

## Home Assistant app

Home Assistant renamed *add-ons* to *apps* in 2026.2; on older versions the same menus
say *Add-ons* and *Add-on Store*.

1. Add this repository in the app store: menu ⋮ → **Repositories** →
   `https://github.com/st412m/cheap-eyes`.
2. Install **cheap-eyes**. Supervisor builds the image on your machine from the pinned
   `cheap-eyes` release on npm.
3. Set `openrouter_key` and start the app. It generates the HTTP token, writes it into
   the `http_token` option and prints the connector path once in the log.
4. Copy the connector path from the log, or the token from the Configuration tab, into
   your client.

Options, the connector URL and what a leaked token gives are in
[the app documentation](../ha-addon/cheap_eyes/DOCS.md).

## Docker

The image `ghcr.io/st412m/cheap-eyes` (linux/amd64 and linux/arm64) serves the HTTP
mode on port 3400. Settings are environment variables; the folders to read are mounted
under `/input`; the state, the picked models and the token live in the volume `/data`.

```sh
docker run -d --name cheap-eyes -p 127.0.0.1:3400:3400 \
  -e CHEAP_EYES_OPENROUTER_KEY=<OPENROUTER_KEY> \
  -v cheap-eyes-data:/data \
  -v /home/me/notes:/input/notes:ro \
  ghcr.io/st412m/cheap-eyes:0.3.0
docker logs cheap-eyes
```

The log shows the connector path once, when the token is generated;
`docker exec cheap-eyes cheap-eyes token` shows it again. `compose.example.yaml` is the
same setup for Compose: copy it to `compose.yaml`, put the key into `.env` next to it,
then `docker compose up -d`.

Paths in jobs are paths inside the container (`/input/notes/…`, not the host path).
The repository's `Dockerfile` builds the same image yourself, from npm or from an
`npm pack` tarball (`--build-arg CHEAP_EYES_TARBALL=<file>`).

## Other MCP clients

Any client that starts a stdio server takes this block (Node.js must be installed;
`npx -y cheap-eyes init --client other` prints it with your key, without the folder):

```json
{
  "mcpServers": {
    "cheap-eyes": {
      "command": "npx",
      "args": ["-y", "cheap-eyes", "/home/me/notes"],
      "env": { "CHEAP_EYES_OPENROUTER_KEY": "<OPENROUTER_KEY>" }
    }
  }
}
```

The folders after `cheap-eyes` are the read roots. Without them the server reads its
working directory, unless that is the home folder or a root (see
[default read root](configuration.md#default-read-root)). A client that only speaks
HTTP connects to the [HTTP mode](#http-mode).

## claude.ai

claude.ai reaches only servers on the internet, so it needs the HTTP mode (`cheap-eyes
serve --http`, the Docker image or the Home Assistant app) behind **your own reverse
proxy that terminates TLS**; cheap-eyes does not provide one. Add
`https://<host>/private_<token>/mcp` in **claude.ai → Settings → Connectors → Add custom
connector**. The token works as a password; see [security](security.md#http-mode).

## HTTP mode

```sh
cheap-eyes serve --http [--port 3400] [--host 127.0.0.1] [--token-file FILE]
```

Streamable HTTP, a fresh stateless MCP server per request. The token comes from
`--token-file`, the env var `CHEAP_EYES_HTTP_TOKEN`, or `<state dir>/token`; when there
is none, the server generates one (32 random bytes as 64 hex characters), saves it there
and prints, once, the file, the connector path and the Bearer header line.
`cheap-eyes token` prints the two lines again; `cheap-eyes token --new` replaces the
saved token (a running server keeps the old one until it is restarted, and every client
must be updated). Two ways in:

- `https://<host>/private_<token>/mcp`: the secret path. Works as a **claude.ai custom
  connector**.
- `https://<host>/mcp` with an `Authorization` header carrying the bearer token.

The default bind is `127.0.0.1`. For clients on other machines, bind another `--host`
and put a TLS reverse proxy in front. `serve --http` has no default read root: give
`read_roots` through `CHEAP_EYES_READ_ROOTS` or `cheap-eyes set read_roots`. How the
token, wrong paths and the bind address are handled is in
[security](security.md#http-mode).

Claude Code against an HTTP instance:

```sh
claude mcp add --scope user --transport http cheap-eyes https://<host>/private_<token>/mcp
```

Without `--scope user`, Claude Code adds the server for the current folder only.

## Proxy

There is no proxy by default anywhere. If OpenRouter refuses your network (see
[troubleshooting](troubleshooting.md#openrouter-answers-403-access-denied-by-security-policy)),
the calls to OpenRouter need a proxy:

- **`cheap-eyes init`** asks for one when OpenRouter answers 403, and puts it into the
  client command it runs or prints.
- **Claude Desktop extension:** the **Proxy** field of its settings.
- **Home Assistant app:** the `https_proxy` option.
- **Anywhere else** (Claude Code by hand, Docker, `serve --http`): set both variables
  (Node ≥ 22.21 or 24):

```sh
HTTPS_PROXY=http://proxy.example.com:3128
NODE_USE_ENV_PROXY=1
```

Without `NODE_USE_ENV_PROXY=1` Node ignores `HTTPS_PROXY`.

The extension passes its proxy in `CHEAP_EYES_HTTPS_PROXY`, because Node refuses to start
when `HTTPS_PROXY` holds an unfilled placeholder. A stdio server that finds a URL there
switches the proxy on in its own process with `http.setGlobalProxyFromEnv` (Node 24.14
or newer, 25.4 or newer); on an older Node from 22.21 on it starts itself again with
`HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` and relays the client through that copy. When
that copy cannot start, the server stays up in the setup state and every tool call says
why.

The same proxy is used for `https://` URLs in `eyes_run.files`; `http://` URLs use
`HTTP_PROXY` and go direct when only `HTTPS_PROXY` is set. Fetching URLs through a
proxy needs Node ≥ 22.21 (≥ 24.5 on 24); see [URL fetch](security.md#url-fetch).

`check-config`, the start line and `eyes_stats` print the proxy state (`direct`,
`HTTPS_PROXY set`, and how it was switched on), never the proxy URL (it may carry
credentials).
