# Internals

How a job runs from files to a checked result, and how to develop and test
cheap-eyes. Read this before sending a patch.

## How it works

The server, not the model, reads the files, masks secrets, numbers lines, filters and
chunks the input, calls the model and then mechanically checks the answer against the
source: every quote, every line reference, every concrete value. The agent gets back a
short, checked result instead of thousands of lines in its own context.

The core is generic — it knows nothing about any particular wiki, app or home setup —
and talks to the OpenRouter API directly; there is no agent loop.

For every `eyes_run` call:

1. **Files.** Absolute paths or globs inside your `read_roots` (see
   [read roots and paths](security.md#read-roots-and-paths)), or URLs fetched behind
   the [address guard](security.md#url-fetch).
2. **Read.** The format is detected from the content by the doclines package. Plain
   text: UTF-8 or UTF-16 (by BOM), lines as in the file. Every other format: extracted
   to lines in a worker thread with a timeout, normalised, section markers kept (see
   [formats](formats.md)).
   Original line numbers are kept; then an optional line range (`file.log#L100-L400`),
   time window (log timestamps) and grep (matching windows only, gaps marked).
3. **Mask.** Secrets become `[uuid]`, `[key]`, `[id]`, `[token]` — always, not
   switchable per call — in the file lines *and* in the task (see
   [secret masking](security.md#secret-masking)). Grep runs on the masked text.
4. **Number and chunk.** Lines go out as `L123| text` (`name:L123| text` for several
   files). Large inputs are split into chunks that fit the model's live context, with a
   small overlap; lines and file headers are never split.
5. **Call** `POST https://openrouter.ai/api/v1/chat/completions` with Zero Data
   Retention required (`provider: {zdr: true, data_collection: "deny"}`) and prompt
   compression off. Retries on 429/5xx, then the next model id of the alias. A chunk
   cut by `finish_reason: "length"` in `extract`, `edits` or `schema` is split in two
   and retried once. Mode `grep` stops before this step.
6. **Check** the answer against the lines that were in that chunk (see
   [checks](checks.md)), store the result, return a header of at most ~4 KB (see
   [tools](tools.md#the-header)).

## Development

```sh
npm install
npm test                          # node --test; no network: fetch throws in spawned servers
node tools/scan-secrets.mjs       # repository hygiene, also run by CI
node tools/check-release.mjs      # one version everywhere, server.json limits; also run by CI
CHEAP_EYES_LIVE=1 CHEAP_EYES_OPENROUTER_KEY=<OPENROUTER_KEY> npm test   # adds the live tests
```

The live tests make real calls to OpenRouter and spend a fraction of a cent. They run
only with both variables set.

`tools/scan-secrets.mjs` fails on anything the masker would mask and on private LAN
addresses; `test/fixtures/` is skipped, and the rules for code files and the
`scan-secrets:allow` markers are described at the top of the script. The LAN check
has no opt-out: code and tests that need such an address build it from octets.

Format fixtures (`test/fixtures/formats/`, with `fixtures.json` listing what each must
and must not yield) are generated outside the repository and committed as binary
files; `test/bench/` is the synthetic [bench](bench.md) suite.

`tools/check-release.mjs` checks that `package.json`, `server.json` (its version and
`packages[0].version`), the app's `config.yaml` and `Dockerfile`, the root `Dockerfile`
and `compose.example.yaml` carry one version, and that `server.json` stays within the
MCP Registry limits.
