# Models and spending

How the server picks models when you name none, how to name them yourself, where their
live facts come from, what your OpenRouter account allows, the price cap, and how
spending is capped. Read this when the first job picks a model, when you want to choose
models by quality, when a model id is refused, or when a job is refused for budget.

## Picked models

**No model id is written in code.** When the settings name no models (the default),
the server picks them itself and pins the pick:

1. **Candidates**, from live data: the zero-data-retention (ZDR) models your account
   allows (`GET /api/v1/models/user`; when that call fails, the public text models,
   with the note `account availability unknown`), with a known price, a context of at
   least 32 000 tokens, an output limit of at least 16 000 (or none given), and at least
   one ZDR endpoint within the price cap. Cheapest first.
2. **Probe**: each candidate gets a built-in test job (about 60 numbered lines of a
   made-up log and a fixed `extract` task with known answers) through the normal request
   (ZDR, `reasoning: {effort: "none"}`). It passes when every expected line comes back,
   the check is all `ok`, nothing extra is returned and the answer is not cut. A probe
   is a paid call (capped at 2048 output tokens and 60 s, no retries), reserved in the
   daily budget and written to the usage log as `tool: "probe"`.
3. **Pin**: candidates are probed in order until two pass or five were tried; the ids
   that passed go into `<state dir>/models.json` with the date, the cap and the result
   and time of every probe. The pick acts as the alias `auto` for every mode.

The pick happens on the first model job (that call takes longer: two to five probe
calls), in `cheap-eyes init`, or on request with `cheap-eyes models --pick`. The result
header names the model: `model: auto picked <id> (probe ok, $<cost>)` the first time,
then `model: auto -> <id> (pinned <date>)`.

The pin does not move on its own. A pinned id that becomes unusable (no ZDR endpoint,
blocked by the account, over the cap, price unknown) is skipped for the next pinned id;
when none is left the server picks again and the header says
`model: auto re-picked: <old> -> <new> (<reason>)`. `dry_run` never probes: without a
pin it says `model: auto (not picked yet)`. When no candidate passes, the refusal names
each tried id with its reason.

### What the pick does not do

**The pick takes the cheapest model within the cap that passes the built-in test job.**
That proves the model works here (it accepts the parameters, returns exact lines, does
not invent any on the test), not that it reads your documents best: a more expensive
model may find more. **Free variants are not picked**: an id ending in `:free`, or an
endpoint that charges $0 for both input and output, does not count, because they are
rate-limited and come and go. You may still name one yourself.

To choose by quality, compare models on your own documents with
[`cheap-eyes bench`](bench.md), then name the one you want:

```sh
cheap-eyes models --candidates
cheap-eyes set models.fast <id>
cheap-eyes set defaults.extract fast
cheap-eyes set defaults.draft fast
cheap-eyes set defaults.edits fast
```

As soon as the settings name a model, the pick is no longer used: the aliases and
`defaults` decide. `cheap-eyes set models.fast` with no value removes the alias again.

## Aliases

An alias is a short name for a list of OpenRouter ids. In a settings file:

```json
"models": {
  "fast": { "ids": ["<id>", "<another id>"], "params": { "reasoning": { "effort": "none" } } }
},
"defaults": { "extract": "fast", "draft": "fast", "edits": "fast" }
```

`ids` are tried in order; `params` is merged into the request as is, but only sampling
and reasoning keys pass (`reasoning`, `temperature`, `top_p`, `top_k`, `min_p`,
`top_a`, `seed`, `frequency_penalty`, `presence_penalty`, `repetition_penalty`,
`stop`). `cheap-eyes set models.<alias> <id>,<id>` writes the ids with reasoning
`none`; other `params` are edited in the file by hand. Ids with a routing suffix
(`:online`, `:nitro`, `:floor`, `:exacto`, `:thinking`, `:extended`) are refused.
`reasoning: {effort: "none"}` matters for cheap models: reasoning tokens eat the output
cap, and a chunk that spent it all comes back empty (the header says so).

`defaults` names the alias each mode uses when a call names none; `eyes_run.model`
picks another alias per call (or `auto`, the pick).

## Price cap

`max_price_usd_per_mtok` (`{in, out}`, USD per 1M tokens) is optional. Picked models use
in $1 / out $4 when it is not set. With a cap in force:

- an id counts only when one of its ZDR endpoints has both its input and its output
  price within the cap (an endpoint without a price never fits);
- every request carries the cap as `provider.max_price`, so OpenRouter routes only to
  endpoints within it, together with `zdr: true`;
- the budget reservation uses the highest ZDR price of the id, but not more than the
  cap.

`cheap-eyes set max_price_usd_per_mtok 0.5 2` sets both halves; `.in` and `.out` change
one half of an existing cap.

## Live facts

Context length, output limit and price are live facts, not settings: they come from
OpenRouter's ZDR endpoint list (`GET /api/v1/endpoints/zdr`), cached for 6 hours. The
model table shows the lowest–highest price when the ZDR endpoints of an id differ.

## Account availability

Whether your account may use an id comes from `GET /api/v1/models/user` ("models
filtered by user provider preferences, privacy settings, and guardrails"), read with
your key and cached with the ZDR list: an id missing there is `blocked by account`. If
that call fails, availability is shown as unknown and no id is treated as blocked.
(`dry_run` fetches only the public ZDR list, so it does not check the account.)

## Resolution and fallback

Per call the server takes the first id of the alias (or the pin) that is not blocked by
the account, has a ZDR endpoint, fits the chunk and fits the price cap; blocked ids are
skipped without a model call, and if a call fails after retries it tries the next id.
No usable id is an error with the reason, never a silent downgrade. When every id is
blocked, the error names them: *blocked by the account's guardrails or privacy
settings — allow it at openrouter.ai → Guardrails*.

## Choosing models

```sh
cheap-eyes models --candidates --min-context 100000 --max-price-in 0.5
```

prints first the default alias per mode (or the pin with its probes) and whether the
account list could be read, then, per alias, the resolved id, `blocked by account` per
id where it applies, ZDR endpoint count, minimum context, price in/out per 1M tokens
and, from your own usage log, jobs, average cost and the **check pass rate** (extract:
verbatim `ok` share; draft: share of lines without flags; edits: valid share). The
mechanical checks double as a benchmark on your real work. Candidates are up to 10 ZDR
text models not in your settings that your account may use, cheapest first; they are
suggestions only. The same table is `eyes_stats {models: true}`. `cheap-eyes models`
reads the account list only when `CHEAP_EYES_OPENROUTER_KEY` is set; without it
availability is unknown.

The pass rate shows invented quotes, not missed ones. To compare models on recall and
precision against expected answers, run [`cheap-eyes bench`](bench.md) on a suite of
your own documents.

## Spending

With cheap models a job costs fractions of a cent.

- **The real ceiling is the key.** Create a dedicated OpenRouter key for cheap-eyes
  and give it a spending limit on openrouter.ai (`cheap-eyes init` warns when the key
  has none and links to its settings).
- **`daily_budget_usd`** (default 1.0 USD per UTC day) is the second line. Before each
  model call the server reserves the worst case (estimated input tokens × input price
  plus `max_tokens` × output price) and refuses when spent + reserved would pass the
  budget; afterwards it settles to the real `usage.cost`. Parallel chunks and async
  jobs cannot overshoot together. The ledger lives inside one server process: two
  stdio sessions each keep their own, which is why the key limit is the ceiling.
- Probes of the pick count against the budget like jobs; `eyes_stats` shows them on a
  line of their own.
- A model id without a known price is refused, never treated as free.

`eyes_stats` shows today's spend, the budget state and the key's remaining limit.
