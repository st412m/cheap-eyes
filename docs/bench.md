# Bench

`cheap-eyes bench` runs a fixed suite of cases with expected answers through
`eyes_run` and reports recall, precision and cost per model and per provider. Read this
to compare models on your own documents before choosing aliases, or to decide whether
a mode is good enough for a job.

## Running it

```text
cheap-eyes bench [--suite DIR] [--models a,b] [--modes extract,schema] [--repeat N]
                 [--out FILE] [--max-usd USD]
```

| Flag | Default | Meaning |
|---|---|---|
| `--suite` | `test/bench/` of the repository | The suite folder holding `suite.json`. |
| `--models` | the `defaults` aliases of the modes in the suite | Aliases (raw ids with `allow_raw_model_ids`). Every case runs with every model. |
| `--modes` | all | Only cases of these modes. |
| `--repeat` | `1` | Runs of every (case, model) pair. |
| `--out` | none | Also write the full report as JSON. |
| `--max-usd` | none | Stop when the next model call could pass this many dollars spent by the bench. |

The built-in suite is in the repository clone only (`test/bench/`); the npm package
does not ship it. For your own documents, make a folder with a `suite.json` and pass
`--suite`.

Every run is a real `eyes_run`: the same pipeline, the same daily budget
(`daily_budget_usd`), the same usage log and results store. `--max-usd` caps the
bench on top of that. When either limit is reached the bench stops, prints the report
of what was done (`STOPPED: --max-usd` or `STOPPED: daily budget`) and exits with 1.

The suite's folders are the read roots of the bench: a case file is named by its file
name (as in an `eyes_run` header), and refs in `expect` use that name. Export is off
during a bench.

## suite.json

```json
{
  "cases": [
    {
      "id": "extract-log-power",
      "mode": "extract",
      "files": ["files/service.log"],
      "task": "Everything about the power supply.",
      "expect": { "lines": ["L3", "L6", "L10"], "allowed": ["L4", "L7", "L11"] }
    },
    {
      "id": "schema-terms",
      "mode": "schema",
      "files": ["files/supply-terms.md"],
      "schema": { "supplier": "string", "delivery_days": "number", "items": [{ "name": "string", "bags": "number" }], "penalty_rate": "string" },
      "expect": {
        "supplier": "Example Trading",
        "delivery_days": { "conflict": [30, 45] },
        "items": [{ "name": "Flour", "bags": 20 }, { "name": "Sugar", "bags": 15 }],
        "penalty_rate": null
      }
    },
    {
      "id": "grep-table",
      "mode": "grep",
      "files": ["../docs/table.html"],
      "grep": { "pattern": "Temperature|Voltage", "context": 0 },
      "expect": { "matches": 2 }
    }
  ]
}
```

A case is `{id, mode, files, task?, schema?, grep?, expect}`. `files` are relative to
the suite folder (`..` is allowed) or URLs. `task` is required for `extract`, `draft`
and `edits`.

| Mode | `expect` |
|---|---|
| `extract` | `{lines: ["name:L12", …], allowed?: [...]}` — required lines and acceptable extra lines; `L12` without a name in a single-file case. |
| `schema` | The truth object: the schema's shape with plain values as leaves (see below). |
| `grep` | `{matches: N}` |
| `draft`, `edits` | Not scored: cost and the check summary only. |

grep cases run without a model, once per repetition, and appear as `(grep)` in the
report.

## Comparison rules (schema)

A leaf of the truth object is compared with the `value` of the answer:

- **Numbers:** the expected number equals any reading of the answer, with spaces,
  commas, dots and the minus sign normalised. `"12,500"` matches both `12.5` and
  `12500`; `"3 605 044,00"` matches `3605044`.
- **Dates:** when both sides read as dates (`2026-11-27`, `27.11.2026`,
  `27 ноября 2026`, `November 27, 2026`), they are compared as dates; the time counts
  when both sides carry one.
- **Text:** after Unicode NFC, whitespace folding and lower case, with quotes
  (`« » „ “ ” " '`) dropped and dashes and minus signs as `-`, one side must contain
  the other on word boundaries. A shorter answer must keep at least half of the
  expected text: `Ромашка` matches `ООО «Ромашка»`, `ООО` does not; `да` never matches
  inside `Вода`.
- **`null`:** the field must be empty. Any value there is an invented value.
- **`{"any": [a, b]}`:** one of the values.
- **`{"conflict": [a, b]}`:** the answer must report a conflict containing both values.
- **Lists:** set recall and precision; an answered item matches an expected one when
  every expected leaf of it matches.

An answered conflict where one value was expected counts for recall if one of its
values matches; for precision every value of the conflict is an answer, and only the
matching ones are right.

## The numbers

Summed over all runs of a model (or provider):

- **recall** = found / required. extract: required lines found. schema: right fields
  + caught conflicts + matched list items, over non-null expected fields + expected
  list items.
- **precision** = right / returned. extract: returned lines that are required or
  allowed, over all returned lines (`NOT IN INPUT` lines are not counted). schema:
  right values over all answered values (each value of a conflict separately, a
  caught conflict as one) + answered list items.
- **invented on null** = values given for fields expected to be `null`, over those
  fields.
- **conflicts** = conflicts caught, over conflicts expected.
- **grep exact** = grep cases with the exact match count.
- cost (from `usage.cost`), tokens in / out, seconds.

The provider is the `provider` field of OpenRouter's response; when a response does
not carry it, the run counts as `unknown`.

## Method

The built-in suite is synthetic: the format fixtures of the repository and three short
text files, with expected answers written by hand from those files. It shows that
the pipeline, the checks and the scoring work, not how good a model is on your
documents. For that, build a private suite the same way: take documents you work
with, write the truth independently of any model (by reading the documents, not by
correcting a model's answer), keep `null` fields for facts the documents do not hold,
and run every model you consider with `--repeat 2` or more. Recall and precision show
different failures — a model can quote only real lines (high precision) and still
miss half of what was asked (low recall). Costs come from OpenRouter's `usage.cost`.
