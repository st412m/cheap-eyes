# Models and spending

How models are named and chosen, where their live facts come from, what your
OpenRouter account allows, how to pick new ones, and how spending is capped. Read this
when setting up aliases, when a model id is refused, or when a job is refused for
budget.

## Aliases

**Nothing is pinned in code.** Models live only in your config (or the app options):
switching models means editing the config and restarting, never a new release.

```json
"models": {
  "fast": { "ids": ["qwen/qwen3.6-35b-a3b", "inclusionai/ling-3.0-flash-vl"], "params": { "reasoning": { "effort": "none" } } },
  "long": { "ids": ["deepseek/deepseek-v4.1-flash"], "params": { "reasoning": { "effort": "none" } } }
}
```

These ids were valid on 2026-09-26 and **will age**. `ids` are tried in order; `params`
is merged into the request as is, but only sampling and reasoning keys pass
(`reasoning`, `temperature`, `top_p`, `top_k`, `min_p`, `top_a`, `seed`,
`frequency_penalty`, `presence_penalty`, `repetition_penalty`, `stop`). Ids with a
routing suffix (`:online`, `:nitro`, `:floor`, `:exacto`, `:thinking`, `:extended`) are
refused. `reasoning: {effort: "none"}` matters for cheap models: reasoning tokens eat
the output cap, and a chunk that spent it all comes back empty (the header says so).

`defaults` names the alias each mode uses when a call names none; `eyes_run.model`
picks another alias per call.

## Live facts

Context length, output limit and price are live facts, not config: they come from
OpenRouter's ZDR endpoint list (`GET /api/v1/endpoints/zdr`), cached for 6 hours.

## Account availability

Whether your account may use an id comes from `GET /api/v1/models/user` ("models
filtered by user provider preferences, privacy settings, and guardrails"), read with
your key and cached with the ZDR list: an id missing there is `blocked by account`. If
that call fails, availability is shown as unknown and no id is treated as blocked.
(`dry_run` fetches only the public ZDR list, so it does not check the account.)

## Resolution and fallback

Per call the server takes the first id of the alias that is not blocked by the
account, has a ZDR endpoint, fits the chunk and is within `max_price_usd_per_mtok`;
blocked ids are skipped without a model call, and if a call fails after retries it
tries the next id. No usable id is an error with the reason — never a silent
downgrade. When every id is blocked, the error names them: *blocked by the account's
guardrails or privacy settings — allow it at openrouter.ai → Guardrails*.

## Choosing models

```sh
cheap-eyes models --candidates --min-context 100000 --max-price-in 0.5
```

prints first the default alias per mode (`defaults: extract -> long, draft -> fast,
edits -> fast, schema -> long (extract default)`) and whether the account list could be read, then, per alias, the
resolved id, `blocked by account` per id where it applies, ZDR endpoint count, minimum
context, price in/out per 1M tokens and — from your own usage log — jobs, average cost
and the **check pass rate** (extract: verbatim `ok` share; draft: share of lines
without flags; edits: valid share). The mechanical checks double as a benchmark on
your real work. Candidates are up to 10 ZDR text models not in your config that your
account may use, cheapest first; they are suggestions only. The same table is
`eyes_stats {models: true}`. `cheap-eyes models` reads the account list only when
`CHEAP_EYES_OPENROUTER_KEY` is set; without it availability is unknown.

The pass rate shows invented quotes, not missed ones. To compare models on recall and
precision against expected answers, run [`cheap-eyes bench`](bench.md) on a suite of
your own documents.

## Spending

With cheap models a job costs fractions of a cent.

- **The real ceiling is the key.** Create a dedicated OpenRouter key with its own
  daily limit for cheap-eyes.
- **`daily_budget_usd`** (default 1.0 USD per UTC day) is the second line. Before each
  model call the server reserves the worst case — estimated input tokens × input price
  plus `max_tokens` × output price — and refuses when spent + reserved would pass the
  budget; afterwards it settles to the real `usage.cost`. Parallel chunks and async
  jobs cannot overshoot together. The ledger lives inside one server process: two
  stdio sessions each keep their own, which is why the key limit is the ceiling.
- A model id without a known price is refused, never treated as free.

`eyes_stats` shows today's spend, the budget state and the key's remaining limit.
