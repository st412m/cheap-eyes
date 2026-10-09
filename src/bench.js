// cheap-eyes bench: a fixed suite with expected answers, run through eyes_run (same
// pipeline, same daily budget), scored per case, summed per model and per provider.
// suite.json: [{ id, mode, files[], task?, schema?, grep?, expect }], paths relative to
// the suite directory (or URLs). See docs/bench.md for the rules.
import fs from 'node:fs';
import path from 'node:path';
import { foldSpace } from 'doclines';
import { BudgetError } from './budget.js';
import { InputError } from './errors.js';
import { URL_RE } from './input/url.js';
import { numberReadings, parseNumberish } from './schema.js';
import { MODES } from './tools.js';

export const DEFAULT_SUITE = path.join(import.meta.dirname, '..', 'test', 'bench');

// ---- the suite ----

export function loadSuite(dir) {
  const file = path.join(dir, 'suite.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new InputError(`suite: cannot read ${file} (${e.code ?? e.message})`);
  }
  const cases = Array.isArray(raw) ? raw : raw?.cases;
  if (!Array.isArray(cases) || cases.length === 0) throw new InputError(`suite: ${file} must hold a list of cases`);
  const ids = new Set();
  for (const [i, c] of cases.entries()) {
    const at = `suite case ${c?.id ?? `#${i + 1}`}`;
    if (!c || typeof c.id !== 'string' || c.id === '') throw new InputError(`suite case #${i + 1}: "id" is required`);
    if (ids.has(c.id)) throw new InputError(`${at}: duplicate id`);
    ids.add(c.id);
    if (!MODES.includes(c.mode)) throw new InputError(`${at}: mode must be one of ${MODES.join(', ')}`);
    if (!Array.isArray(c.files) || c.files.length === 0 || c.files.some((f) => typeof f !== 'string' || f === '')) throw new InputError(`${at}: "files" must be a non-empty list`);
    if ((c.mode === 'extract' || c.mode === 'draft' || c.mode === 'edits') && typeof c.task !== 'string') throw new InputError(`${at}: mode ${c.mode} needs "task"`);
    if (c.mode === 'schema' && (c.schema === undefined || !c.expect || typeof c.expect !== 'object')) throw new InputError(`${at}: mode schema needs "schema" and "expect" (the truth object)`);
    if (c.mode === 'grep' && (!c.grep || !Number.isInteger(c.expect?.matches))) throw new InputError(`${at}: mode grep needs "grep" and "expect": {"matches": N}`);
    if (c.mode === 'extract' && !Array.isArray(c.expect?.lines)) throw new InputError(`${at}: mode extract needs "expect": {"lines": ["name:L12", …]}`);
  }
  return { dir: path.resolve(dir), cases };
}

// Case files as eyes_run gets them: URLs as they are, paths resolved against the suite.
export function caseFiles(suite, c) {
  return c.files.map((f) => (URL_RE.test(f) ? f : path.resolve(suite.dir, f)));
}

// Read roots for a bench run: the folders the case files sit in (names are then the
// file names; a clash falls back to "folder/name").
export function suiteRoots(suite) {
  const roots = new Set();
  for (const c of suite.cases) for (const f of caseFiles(suite, c)) if (!URL_RE.test(f)) roots.add(path.dirname(f));
  return [...roots];
}

// ---- comparison rules ----

// Whole month words, English and Russian (nominative and genitive), or their short forms.
const MONTHS = [
  'january|jan|январь|января|янв', 'february|feb|февраль|февраля|фев', 'march|mar|март|марта|мар', 'april|apr|апрель|апреля|апр',
  'may|май|мая', 'june|jun|июнь|июня|июн', 'july|jul|июль|июля|июл', 'august|aug|август|августа|авг',
  'september|sept|sep|сентябрь|сентября|сен', 'october|oct|октябрь|октября|окт', 'november|nov|ноябрь|ноября|ноя', 'december|dec|декабрь|декабря|дек',
].map((w) => new RegExp(`(?<![a-zа-яё])(?:${w})(?![a-zа-яё])`));
const pad = (n) => String(n).padStart(2, '0');

/** "2026-11-27", "27.11.2026", "27 ноября 2026 года", "February 17, 2026" → "2026-11-27" (+ "T11:00"), else null. */
export function parseDate(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  const time = /\b(\d{1,2}):(\d{2})\b/.exec(s);
  const t = time ? `T${pad(time[1])}:${time[2]}` : '';
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}${t}`;
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})\b/.exec(s);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}${t}`;
  const month = MONTHS.findIndex((re) => re.test(s));
  const year = /\b(\d{4})\b/.exec(s);
  const day = /(?:^|[^\d:])(\d{1,2})(?:st|nd|rd|th)?(?![\d:])/.exec(s.replace(/\b\d{4}\b/, ''));
  if (month >= 0 && year && day) return `${year[1]}-${pad(month + 1)}-${pad(day[1])}${t}`;
  return null;
}

// Text for comparing answers (not quotes): quotes dropped, dashes and minus signs as
// "-", whitespace folded, lower case. Names in «» often come back without them.
const fold = (s) =>
  foldSpace(
    String(s)
      .normalize('NFC')
      .replace(/[«»„“”"'‘’‚‹›]/g, ' ')
      .replace(/[–—−‑‐]/g, '-'),
  ).toLowerCase();

// One expected value against one answered value (a conflict answer: any of its values).
export function valueMatches(expected, answered) {
  if (answered === null || answered === undefined) return false;
  if (Array.isArray(answered)) return answered.some((a) => valueMatches(expected, a));
  if (typeof expected === 'boolean') return answered === expected || fold(answered) === String(expected);
  const n = parseNumberish(expected);
  if (n !== null) {
    const readings = numberReadings(typeof answered === 'number' ? answered : String(answered));
    if (readings.length) return readings.some((r) => Math.abs(r - n) < 1e-9);
  }
  // Both sides read as dates: compared as dates, with the time when both carry one.
  const d = typeof expected === 'string' ? parseDate(expected) : null;
  const ad = d && typeof answered === 'string' ? parseDate(answered) : null;
  if (d && ad) return ad.length > 10 && d.length > 10 ? ad === d : ad.slice(0, 10) === d.slice(0, 10);
  const e = fold(expected);
  const a = fold(typeof answered === 'object' ? JSON.stringify(answered) : answered);
  if (e === '' || a === '') return false;
  // Text: one contains the other on word boundaries; a shorter answer must keep at
  // least half of the expected text (a fragment such as "ООО" does not count).
  return containsWords(a, e) || (a.length * 2 >= e.length && containsWords(e, a));
}

// `hay` contains `needle` with no letter or digit right before or after it.
function containsWords(hay, needle) {
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const before = hay.slice(0, i);
    const after = hay.slice(i + needle.length);
    if (!/[\p{L}\p{N}]$/u.test(before) && !/^[\p{L}\p{N}]/u.test(after)) return true;
  }
  return false;
}

const isSpecial = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && (Array.isArray(v.any) || Array.isArray(v.conflict));
const leafValue = (a) => (a && typeof a === 'object' && !Array.isArray(a) && 'value' in a ? a.value : a);

// `values`/`right`: the answered values and the right ones among them (precision).
function emptyScore() {
  return { fields: 0, correct: 0, wrong: 0, missed: 0, invented: 0, null_expected: 0, null_ok: 0, conflicts_expected: 0, conflicts_caught: 0, list_expected: 0, list_answered: 0, list_matched: 0, values: 0, right: 0, details: [] };
}

function scoreLeaf(exp, ans, p, sc) {
  const value = leafValue(ans);
  const isNull = value === null || value === undefined;
  // A conflict answer brings every one of its values to precision.
  const answeredValues = isNull ? [] : ans?.conflict === true && Array.isArray(value) ? value : [value];
  let r;
  sc.fields++;
  sc.values += answeredValues.length;
  if (exp === null) {
    sc.null_expected++;
    r = isNull ? 'null_ok' : 'invented';
  } else if (isSpecial(exp) && exp.conflict) {
    sc.conflicts_expected++;
    // A caught conflict counts as one value, right or not.
    if (ans?.conflict === true && exp.conflict.every((x) => valueMatches(x, value))) {
      r = 'conflict_caught';
      sc.values -= answeredValues.length - 1;
      sc.right++;
    } else r = isNull ? 'missed' : 'conflict_missed';
  } else if (isNull) r = 'missed';
  else {
    const options = isSpecial(exp) ? exp.any : [exp];
    const ok = answeredValues.filter((v) => options.some((x) => valueMatches(x, v))).length;
    sc.right += ok;
    r = ok > 0 ? 'correct' : 'wrong';
  }
  if (r === 'null_ok') sc.null_ok++;
  else if (r === 'invented') sc.invented++;
  else if (r === 'conflict_caught') sc.conflicts_caught++;
  else if (r === 'correct') sc.correct++;
  else if (r === 'missed') sc.missed++;
  else sc.wrong++;
  sc.details.push({ path: p, result: r, ...(r === 'correct' || r === 'null_ok' || r === 'conflict_caught' ? {} : { expected: exp, answered: value ?? null }) });
}

// An answered list item matches an expected one when every expected leaf matches.
function itemMatches(exp, ans) {
  if (exp === null || typeof exp !== 'object' || isSpecial(exp)) {
    const v = leafValue(ans);
    if (exp === null) return v === null || v === undefined;
    return (isSpecial(exp) ? exp.any : [exp]).some((x) => valueMatches(x, v));
  }
  return Object.entries(exp).every(([k, e]) => itemMatches(e, ans?.[k]));
}

function scoreNode(exp, ans, p, sc) {
  if (Array.isArray(exp)) {
    const got = Array.isArray(ans) ? ans : [];
    const used = new Set();
    let matched = 0;
    for (const e of exp) {
      const j = got.findIndex((a, k) => !used.has(k) && itemMatches(e, a));
      if (j >= 0) {
        used.add(j);
        matched++;
      }
    }
    sc.list_expected += exp.length;
    sc.list_answered += got.length;
    sc.list_matched += matched;
    sc.details.push({ path: p, result: 'list', expected: exp.length, answered: got.length, matched });
    return;
  }
  if (exp && typeof exp === 'object' && !isSpecial(exp)) {
    for (const [k, e] of Object.entries(exp)) scoreNode(e, ans?.[k], p ? `${p}.${k}` : k, sc);
    return;
  }
  scoreLeaf(exp, ans, p, sc);
}

/** Schema answer (the merged JSON) against the truth object. */
export function scoreSchema(expect, merged) {
  const sc = emptyScore();
  scoreNode(expect, merged ?? {}, '', sc);
  // Recall: a field counts once (a conflict answer with one right value included).
  const hit = sc.correct + sc.conflicts_caught + sc.list_matched;
  const need = sc.fields - sc.null_expected + sc.list_expected;
  // Precision: every answered value, each value of a conflict answer separately.
  const answered = sc.values + sc.list_answered;
  const right = sc.right + sc.list_matched;
  return { ...sc, hit, need, answered, right };
}

const LINE_REF = /^(?:(.+):)?L(\d+)$/;

/** Extract result lines (check items) against the required and allowed lines. */
export function scoreExtract(expect, items, singleName) {
  const key = (ref) => {
    const m = LINE_REF.exec(String(ref).trim());
    if (!m) throw new InputError(`bench: bad line ref in expect: ${ref} (use "name:L12" or "L12")`);
    return `${m[1] ?? singleName}:L${m[2]}`;
  };
  const required = new Set(expect.lines.map(key));
  const allowed = new Set([...required, ...(expect.allowed ?? []).map(key)]);
  const returned = items.filter((it) => it.status !== 'not_in_input');
  const got = new Set();
  let ok = 0;
  for (const it of returned) {
    const k = it.file && it.line ? `${it.file}:L${it.line}` : null;
    if (k && allowed.has(k)) ok++;
    if (k) got.add(k);
  }
  const found = [...required].filter((k) => got.has(k));
  return {
    hit: found.length,
    need: required.size,
    answered: returned.length,
    in_allowed: ok,
    missing: [...required].filter((k) => !got.has(k)),
    extra: [...got].filter((k) => !allowed.has(k)),
  };
}

// ---- running ----

// The bench's own cap on top of the daily budget: reservations beyond --max-usd fail.
export class CappedLedger {
  constructor(inner, maxUsd) {
    this.inner = inner;
    this.maxUsd = maxUsd;
    this.spent = 0;
    this.reserved = new Map();
    this.hit = null;
  }

  ensure() {
    return this.inner.ensure();
  }

  reserve(amount, budget) {
    const open = [...this.reserved.values()].reduce((s, v) => s + v, 0);
    if (this.maxUsd !== null && this.spent + open + amount > this.maxUsd) {
      this.hit = '--max-usd';
      throw new BudgetError(`bench --max-usd $${this.maxUsd} reached (spent $${this.spent.toFixed(6)}, next call may cost up to $${amount.toFixed(6)})`);
    }
    let h;
    try {
      h = this.inner.reserve(amount, budget);
    } catch (e) {
      if (e instanceof BudgetError) this.hit = 'daily budget';
      throw e;
    }
    this.reserved.set(h, amount);
    return h;
  }

  settle(h, cost) {
    this.reserved.delete(h);
    this.spent += cost;
    return this.inner.settle(h, cost);
  }
}

function providerOf(outs) {
  const p = [...new Set((outs ?? []).map((o) => o.provider ?? 'unknown'))];
  return p.length ? p.sort().join('+') : 'unknown';
}

function scoreRun(c, res) {
  if (c.mode === 'grep') return { matches: res.counts.matches, expected: c.expect.matches, pass: res.counts.matches === c.expect.matches };
  if (c.mode === 'extract') return scoreExtract(c.expect, res.checks.items, res.input.multi ? null : res.input.files[0].name);
  if (c.mode === 'schema') return scoreSchema(c.expect, JSON.parse(res.text.replace(/^```json\n|\n```\n?$/g, '')));
  // draft and edits are not scored: check flags and cost only.
  return { check: res.checks.summary };
}

/**
 * Run every (case, model, repetition); grep cases run once per repetition (no model).
 * `run(args)` is eyes_run bound to the bench context. Stops at the first budget refusal
 * and returns what was done.
 */
export async function runBench({ suite, models, modes, repeat = 1, run, ledger, log = () => {} }) {
  const cases = suite.cases.filter((c) => !modes || modes.includes(c.mode));
  const runs = [];
  let aborted = null;
  outer: for (let rep = 1; rep <= repeat; rep++) {
    for (const c of cases) {
      for (const model of c.mode === 'grep' ? [null] : models) {
        const args = {
          mode: c.mode,
          files: caseFiles(suite, c),
          ...(c.task !== undefined ? { task: c.task } : {}),
          ...(c.schema !== undefined ? { schema: c.schema } : {}),
          ...(c.grep !== undefined ? { grep: c.grep } : {}),
          ...(model ? { model } : {}),
        };
        const t0 = Date.now();
        const row = { case: c.id, mode: c.mode, model: model ?? '(grep)', rep };
        try {
          const res = await run(args);
          Object.assign(row, {
            status: 'done',
            result_id: res.id,
            provider: c.mode === 'grep' ? 'none' : providerOf(res.outs),
            models_used: res.rec.models_used,
            cost: res.rec.cost,
            tokens_in: res.rec.tokens_in,
            tokens_out: res.rec.tokens_out,
            seconds: (res.rec.ms ?? Date.now() - t0) / 1000,
            score: scoreRun(c, res),
          });
        } catch (e) {
          if (!(e instanceof InputError) && !(e instanceof BudgetError)) throw e;
          Object.assign(row, { status: 'failed', error: e.message, provider: 'unknown', cost: Number(/spent \$([\d.]+)/.exec(e.message)?.[1] ?? 0), tokens_in: 0, tokens_out: 0, seconds: (Date.now() - t0) / 1000 });
        }
        runs.push(row);
        log(`${row.status === 'done' ? 'ok ' : 'ERR'} ${c.id} ${row.model} #${rep}${row.error ? `: ${row.error}` : ''}`);
        if (ledger?.hit) {
          aborted = ledger.hit;
          break outer;
        }
      }
    }
  }
  return { runs, aborted, groups: summarize(runs) };
}

function ratio(a, b) {
  return b ? a / b : null;
}

function addTo(map, key, r) {
  const g = (map[key] ??= { runs: 0, failed: 0, hit: 0, need: 0, answered: 0, in_allowed: 0, invented: 0, null_expected: 0, conflicts_caught: 0, conflicts_expected: 0, grep_pass: 0, grep_runs: 0, cost: 0, tokens_in: 0, tokens_out: 0, seconds: 0 });
  g.runs++;
  g.cost += r.cost ?? 0;
  g.tokens_in += r.tokens_in ?? 0;
  g.tokens_out += r.tokens_out ?? 0;
  g.seconds += r.seconds ?? 0;
  if (r.status !== 'done') {
    g.failed++;
    return;
  }
  const s = r.score;
  if (r.mode === 'grep') {
    g.grep_runs++;
    if (s.pass) g.grep_pass++;
    return;
  }
  if (r.mode === 'extract' || r.mode === 'schema') {
    g.hit += s.hit;
    g.need += s.need;
    g.answered += s.answered;
    // Precision: extract counts lines in required ∪ allowed, schema counts right values.
    g.in_allowed += r.mode === 'extract' ? s.in_allowed : s.right;
  }
  if (r.mode === 'schema') {
    g.invented += s.invented;
    g.null_expected += s.null_expected;
    g.conflicts_caught += s.conflicts_caught;
    g.conflicts_expected += s.conflicts_expected;
  }
}

// Micro-averaged over runs: recall = found / required, precision = right / returned.
export function summarize(runs) {
  const byModel = {};
  const byProvider = {};
  for (const r of runs) {
    addTo(byModel, r.model, r);
    addTo(byProvider, r.provider ?? 'unknown', r);
  }
  const finish = (m) =>
    Object.fromEntries(
      Object.entries(m).map(([k, g]) => [k, { ...g, recall: ratio(g.hit, g.need), precision: ratio(g.in_allowed, g.answered), invented_rate: ratio(g.invented, g.null_expected) }]),
    );
  return { by_model: finish(byModel), by_provider: finish(byProvider) };
}

const pct = (v) => (v === null || v === undefined ? '-' : `${Math.round(v * 100)}%`);

function table(title, groups) {
  const rows = Object.entries(groups);
  const out = [`### ${title}`, '', '| | runs | failed | recall | precision | invented on null | conflicts | grep exact | cost $ | tokens in / out | seconds |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const [k, g] of rows) {
    out.push(
      `| ${k} | ${g.runs} | ${g.failed} | ${pct(g.recall)} | ${pct(g.precision)} | ${g.null_expected ? `${g.invented}/${g.null_expected}` : '-'} | ${g.conflicts_expected ? `${g.conflicts_caught}/${g.conflicts_expected}` : '-'} | ${g.grep_runs ? `${g.grep_pass}/${g.grep_runs}` : '-'} | ${g.cost.toFixed(4)} | ${g.tokens_in} / ${g.tokens_out} | ${g.seconds.toFixed(1)} |`,
    );
  }
  return out.join('\n');
}

export function renderMarkdown(report) {
  const head = [`## cheap-eyes bench: ${report.suite}`, '', `models: ${report.models.join(', ') || '-'}; modes: ${report.modes?.join(', ') ?? 'all'}; repeat: ${report.repeat}; runs: ${report.runs.length}${report.aborted ? `; STOPPED: ${report.aborted}` : ''}`];
  const failed = report.runs.filter((r) => r.status !== 'done');
  const tail = failed.length ? ['', 'Failed runs:', ...failed.map((r) => `- ${r.case} ${r.model} #${r.rep}: ${r.error}`)] : [];
  return [...head, '', table('By model', report.groups.by_model), '', table('By provider', report.groups.by_provider), ...tail].join('\n') + '\n';
}
