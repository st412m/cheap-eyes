# Modes and checks

The modes that call a model, what the server checks in each answer, worked examples,
and what each check does not catch. Read this to pick a mode, or to understand a
`bad` or flagged line in a header.

Mode `grep` calls no model and has no check: its result is the source text itself (see
[tools](tools.md#mode-grep)).

Every mode shares one system prompt: use only the numbered input; end every claim with
line refs present in this input; write `NOT IN INPUT` instead of guessing; no
preamble; leave masks untouched. The checks run on the model's answer against the
lines that were in *that chunk* — not merely somewhere in the file.

The checks prove that quotes, refs and hard tokens match the source. They do not prove
that an answer is complete, relevant or correctly reasoned.

Refs show the place of their line in the header and the check report: `L123 (p.12)`,
`L40 (slide 3)`, `L12 (attachment: offer.pdf, p.2)` (see
[places in refs](formats.md#places-in-refs)). A ref that names an attachment instead of
a file (`offer.pdf:L12`) counts as a ref to the message file when line 12 lies inside
that attachment.

The examples below are real headers from the server with a stubbed model answer.

## extract — verbatim lines

The answer is input lines quoted verbatim, one per line. Each line is `ok` (equal to
the masked source line), `ok~` (equal after collapsing whitespace, NBSP included,
and ignoring soft hyphens U+00AD), `partial` (a prefix ending in `…`) or `bad`.

Input `logs/app.log` (as the model sees it, after masking):

```text
L1| 2026-09-20 08:00:01.120 INFO  [web] listening on 0.0.0.0:8080
L2| 2026-09-20 08:00:02.400 INFO  [db] connected to db.example.com:5432 password=[token]
L3| 2026-09-20 08:14:09.031 ERROR [sync] upload failed: timeout after 30 s
L4| 2026-09-20 08:14:09.032 Traceback (most recent call last):
L5|   File "/opt/app/sync.py", line 88, in push
L6| TimeoutError: timed out
L7| 2026-09-20 08:15:00.000 INFO  [sync] retry 1/3
L8| 2026-09-20 08:15:31.550 ERROR [sync] upload failed: HTTP 503 from api.example.com
L9| 2026-09-20 08:16:00.000 INFO  [sync] retry 2/3 ok
```

`eyes_run {mode: "extract", task: "Every ERROR line and the traceback that follows it",
files: ["/srv/logs/app.log"], time: {since: "2026-09-20T08:10:00"}}` — the time window
drops L1–L2 before anything is sent:

```text
eyes_run result: 2026-09-26_152246-extract-889090
model: alias fast -> qwen/qwen3.6-35b-a3b (used: qwen/qwen3.6-35b-a3b)
mode: extract; files: 1; chunks: 1/1
tokens in 412 / out 96; cost $0.000080; 2 ms
check (extract): refs ok 4 / bad 1 — ok 4, ok~ 0, partial 0, not-in-input 0
  L9 [bad] text differs from the source line
masks: none; in task: none
time: 2026-09-20T08:10:00 → … (UTC)
result lines: 5
--- untrusted model output ---
L3| 2026-09-20 08:14:09.031 ERROR [sync] upload failed: timeout after 30 s
L4| 2026-09-20 08:14:09.032 Traceback (most recent call last):
L6| TimeoutError: timed out
L8| 2026-09-20 08:15:31.550 ERROR [sync] upload failed: HTTP 503 from api.example.com
L9| 2026-09-20 08:16:00.000 ERROR [sync] retry 2/3 failed
--- end ---
```

The model "remembered" L9 as an error; the check caught the invented text.
**Not caught:** completeness and relevance — here it silently skipped L5 of the
traceback. The check proves every quoted line is real, not that every relevant line
was quoted.

## draft — free markdown with refs

Every content line must carry refs like `(L12)`, `(L10-L14)` or `(name:L5)`; headings,
blank lines and code fences are exempt. The check flags lines without refs, refs to
lines not in the chunk, and refs wider than 30 lines (`wide ref`). Hard tokens — IPv4
and IPv6 addresses, `host:port`, versions, dotted host names, entity ids like
`light.kitchen`, absolute paths, backticked identifiers, dates `YYYY-MM-DD`, times
`HH:MM` — must occur in the cited lines (`token not in cited lines: …`); bare numbers
of two or more digits missing from them are a soft flag.

Input `docs/deploy.md`, masked:

```text
L1| # Deploy
L2|
L3| The app runs version 2.4.1 behind the proxy on port 8080.
L4| Backups go to /var/backups/app every night at 03:30.
L5| The token for the upload API is api_token: [token]
L6| Staging lives on staging.example.com.
```

```text
eyes_run result: 2026-09-26_152246-draft-6a1b73
model: alias fast -> qwen/qwen3.6-35b-a3b (used: qwen/qwen3.6-35b-a3b)
mode: draft; files: 1; chunks: 1/1
tokens in 260 / out 70; cost $0.000054; 3 ms
check (draft): refs ok 3 / bad 0 — lines 4: ok 2, flagged 0, bad 2, not-in-input 0
  line 3 [bad] token not in cited lines: 03:00
  line 5 [bad] no ref
masks: kv_secret 1; in task: none
result lines: 5
--- untrusted model output ---
## Deploy
- Version 2.4.1 behind the proxy, port 8080 (L3)
- Nightly backups to /var/backups/app at 03:00 (L4)
- Staging: staging.example.com (L6)
- Monitoring is handled by the ops team
--- end ---
```

The wrong backup time and the unsupported claim are both caught.
**Known false positives:** time-zone conversions ("08:14 UTC is 10:14 CEST"),
reformatted dates ("20 Sep" for `2026-09-20`), computed counts ("3 errors") are
flagged although correct. **Blind spot:** a claim with a valid ref and no hard token
("the sync is reliable (L7)") is not checked for meaning.

`draft` has no reduce pass: with several chunks, each chunk's notes come back under
their own `=== chunk N ===` header.

## edits — proposed line edits

The answer is JSON lines `{"file", "line", "old", "new", "why"}`. A proposal is valid
when the line was in the input and `old` occurs exactly once in it; a proposal whose
`old` or `new` touches a mask is rejected, because the masked text is not what is on
disk. Valid and rejected proposals go to separate lists in the check report.

```text
eyes_run result: 2026-09-26_152246-edits-168ca0
model: alias fast -> qwen/qwen3.6-35b-a3b (used: qwen/qwen3.6-35b-a3b)
mode: edits; files: 1; chunks: 1/1
tokens in 280 / out 80; cost $0.000060; 2 ms
check (edits): refs ok 1 / bad 2 — valid 1, rejected 2 (never applied)
  docs/deploy.md:L5 [bad] touches a mask: the masked text is not what is on disk
  docs/deploy.md:L3 [bad] "old" is not in the source line
masks: kv_secret 1; in task: none
result lines: 3
--- untrusted model output ---
{"file":"docs/deploy.md","line":4,"old":"03:30","new":"04:00","why":"new backup time"}
{"file":"docs/deploy.md","line":5,"old":"[token]","new":"NEW","why":"rotate"}
{"file":"docs/deploy.md","line":3,"old":"8081","new":"8080","why":"port"}
--- end ---
```

**Not checked:** `new` — whether the replacement is right is up to the agent. The
server never applies edits.

## schema — fields with refs and quotes

The answer is one JSON object per chunk (the format is in
[tools](tools.md#mode-schema)); the server merges the chunks and checks every value
against the lines of the chunk it came from:

| Status | Meaning |
|---|---|
| `ok` | The ref points to lines of that chunk's input and the quote occurs in them. |
| `ok~` | The same after folding whitespace, NBSP and soft hyphens; also a quote that starts with the line prefix of a cited line (`L12| `, `L12 (p.3)| ` or any other place in parentheses, `name:L12| `, on each line of a multi-line quote), checked without it. |
| `quote_mismatch` | The quote is not in the cited lines; when it is elsewhere in the chunk, the note names the real line. |
| `bad_ref` | No ref, an unreadable ref, an unknown file, or lines outside the chunk's input. |
| `value_not_in_quote` | Soft: a hard token of the value (a number of two or more digits, a date, a version, an IP, an id) is not in the quote; numbers are compared after normalising separators. |
| `null` | The model says the field is not in the input. The server cannot know whether it really is not — completeness is what [bench](bench.md) measures. |
| `conflict` | Two or more values for one field; each value gets its own item with its own status. |
| `failed` | A chunk's answer was not a JSON object even after one repair attempt. |

The header line reads:

```text
check (schema): fields ok 4 / mismatch 1 / null 1 / conflict 0; bad ref 0, value not in quote 0
  deadline L4 [quote_mismatch] quote found at tender.md:L3
```

followed by the first 10 problems. `ok` items in the stored report keep the ref and
the status only; the quote is in the result.

**Known false positive:** a date the model reformatted (`2026-11-27` for
`27 ноября 2026 года`) is `value_not_in_quote`. **Not caught:** a value taken from the
wrong line that happens to be quoted correctly, and a field left `null` although the
input has it.

## Pass rates

Each check's result is logged per job, so the checks double as a benchmark of each
model on your real work: see [choosing models](models.md#choosing-models).
