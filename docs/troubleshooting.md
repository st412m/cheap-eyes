# Troubleshooting

Symptoms seen in real use and what they mean: refusals from OpenRouter, blocked
models, a server that won't start, a connector that gets 404, a stale tool list, and
budget refusals. Start here when a call fails or a client misbehaves.

## OpenRouter answers 403 "Access denied by security policy"

OpenRouter refuses requests from some regions. The error comes back in the failing
call — for example `HTTP 403: Access denied by security policy` in the `eyes_run`
error, or `models: unavailable (…)` and `key: status unavailable (…)` in
`eyes_stats`. Route the calls through a proxy: see [proxy](installation.md#proxy) (the
Home Assistant app has an `https_proxy` option).

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

## The server or the app refuses to start: unknown alias

Every value in `defaults` must be an alias defined in `models`. Otherwise the config
is rejected at start and the message names the field and the alias, for example:

```text
cheap-eyes: /data/config.json: invalid config
  field "defaults.extract": alias "fats" is not defined in models
```

Fix the alias in the config (or in the app's **Default alias per mode** option) and
start again. `cheap-eyes check-config` shows the same message without starting.

## The connector gets 404

The token or the path in the connector URL is wrong. By design the server answers a
wrong path with a bare 404, with no `WWW-Authenticate` header and no OAuth discovery,
so the client never learns that a token exists. Check that the URL is exactly
`https://<host>/private_<token>/mcp`. A wrong bearer token on `/mcp` gets 401 instead.
See [HTTP mode](security.md#http-mode).

## The client shows old tools or parameters after an update

A client can keep the tool list it fetched earlier. Refresh the connector's tool list
in the client (or remove the connector and add it again), then start a new chat.

## A job is refused over budget, or the key limit is reached

- **Local budget.** The call fails with `daily budget exceeded: spent $… + reserved $…
  + this call up to $… > daily_budget_usd $…`. The day is a UTC day. Raise
  `daily_budget_usd`, wait for the next UTC day, or pick a cheaper alias. See
  [spending](models.md#spending).
- **Key limit.** When the key's own limit on OpenRouter is used up, OpenRouter refuses
  the call and the `eyes_run` error carries its HTTP status and message (the API
  reference lists 402 for insufficient credits or quota). Raise the limit on
  openrouter.ai.

In both cases `eyes_stats` shows today's spend, the local budget and reservations, and
the key's `limit`, `limit_remaining` and `usage_daily`.
