// cheap-eyes bench: comparison rules, scoring on a crafted suite run through eyes_run
// with mocked model answers, the --max-usd stop, the repo suite, CLI arguments.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { CappedLedger, caseFiles, DEFAULT_SUITE, loadSuite, parseDate, renderMarkdown, runBench, scoreExtract, scoreSchema, suiteRoots, valueMatches } from '../src/bench.js';
import { Ledger } from '../src/budget.js';
import { parseConfig } from '../src/config.js';
import { readSource } from '../src/input/extract.js';
import { clearCatalogCache } from '../src/openrouter.js';
import { eyesRun } from '../src/run.js';
import { parseSchema } from '../src/schema.js';
import { CLI_ARGS, isolatedEnv, tmpDir, writeJson } from './helpers.js';

const KEY = 'sk-' + 'or-v1-FAKE0000000000000000000000000000000000000000000000000000'; // fake, scan-secrets:allow
const ZDR = ['v/a', 'v/b'].map((id) => ({ model_id: id, provider_name: 'P', context_length: 200000, max_completion_tokens: null, pricing: { prompt: '0.0000002', completion: '0.0000004', request: '0' } }));

beforeEach(() => clearCatalogCache());

// ---- comparison rules ----

test('values: numbers by any reading, dates as dates, text by case-insensitive containment', () => {
  assert.equal(valueMatches(12.5, '12,500'), true, 'one reading of "12,500" is 12.5');
  assert.equal(valueMatches(12500, '12,500'), true);
  assert.equal(valueMatches(3605044, '3 605 044,00'), true);
  assert.equal(valueMatches(-40, '−40'), true);
  assert.equal(valueMatches(1000000, 1000001), false);
  assert.equal(valueMatches('2026-11-27', '27 ноября 2026 года'), true);
  assert.equal(valueMatches('2019-02-21', 'the 21st day of February 2019'), true);
  assert.equal(valueMatches('2026-02-17', '17.02.2026'), true);
  assert.equal(valueMatches('2026-11-27', '2026-11-28'), false);
  assert.equal(valueMatches('Example Trading', 'example trading LLC'), true);
  assert.equal(valueMatches('Example Trading LLC', 'Example Trading'), true, 'containment either way');
  assert.equal(valueMatches('Example Trading', 'Sample Foods'), false);
  assert.equal(valueMatches(true, true), true);
  assert.equal(valueMatches('x', null), false);
  assert.equal(valueMatches(30, [30, 45]), true, 'a conflict answer matches when any value does');
  assert.equal(parseDate('Supplier margin is 75%'), null, 'no month inside other words');
  assert.equal(parseDate('2026-02-17 11:00'), '2026-02-17T11:00');
});

test('text matches on word boundaries; a shorter answer keeps at least half of the expected text', () => {
  assert.equal(valueMatches('Москва', 'г. Москва'), true);
  assert.equal(valueMatches('ООО Ромашка', 'Ромашка'), true);
  assert.equal(valueMatches('ООО Ромашка', 'О'), false);
  assert.equal(valueMatches('ООО Ромашка', 'ООО'), false, 'a fragment under half of the expected text');
  assert.equal(valueMatches('да', 'Вода'), false, 'not inside a word');
  assert.equal(valueMatches('Example Trading', 'Example Trading LLC'), true);
  assert.equal(valueMatches('Trading', 'Example Trading LLC'), true);
  assert.equal(valueMatches('Trad', 'Example Trading LLC'), false);
  // Quotes do not count; dashes and minus signs are one "-".
  assert.equal(valueMatches('ООО «Ромашка»', 'ООО Ромашка'), true);
  assert.equal(valueMatches('ООО "Ромашка"', 'ООО Ромашка'), true);
  assert.equal(valueMatches('ООО Ромашка', 'ООО „Ромашка“'), true);
  assert.equal(valueMatches('2–3 дня', '2-3 дня'), true);
  assert.equal(valueMatches('ООО «Ромашка»', '«О»'), false);
});

test('dates: both sides parsed as dates, whatever form the expected value has', () => {
  assert.equal(valueMatches('27 ноября 2026', '2026-11-27'), true);
  assert.equal(valueMatches('27.11.2026', 'November 27, 2026'), true);
  assert.equal(valueMatches('27.11.2026', '2026-11-28'), false);
  assert.equal(valueMatches('2026-02-17 11:00', '17.02.2026 11:00'), true);
  assert.equal(valueMatches('2026-02-17 11:00', '17.02.2026 12:30'), false, 'times differ when both have one');
  assert.equal(valueMatches('2026-02-17 11:00', '17.02.2026'), true, 'one side without a time: the date decides');
});

test('a conflict answer to a single expected value: recall when one value is right, precision per value', () => {
  const one = scoreSchema({ d: 30 }, { d: { value: [30, 45], conflict: true, refs: [], quotes: [] } });
  assert.deepEqual([one.hit, one.need, one.right, one.answered], [1, 1, 1, 2]);
  const none = scoreSchema({ d: 30 }, { d: { value: [44, 45], conflict: true, refs: [], quotes: [] } });
  assert.deepEqual([none.hit, none.right, none.answered, none.wrong], [0, 0, 2, 1]);
  // A conflict where one was expected is still one right value.
  const caught = scoreSchema({ d: { conflict: [30, 45] } }, { d: { value: [30, 45], conflict: true, refs: [], quotes: [] } });
  assert.deepEqual([caught.hit, caught.right, caught.answered], [1, 1, 1]);
});

test('schema score: null (invented), any, conflict (caught / missed), nested objects, lists by set recall/precision', () => {
  const expect = { a: 'Example', n: null, any: { any: [12, '12 months'] }, c: { conflict: [30, 45] }, o: { x: 1, y: 2 }, list: [{ k: 'A' }, { k: 'B' }, { k: 'C' }] };
  const good = scoreSchema(expect, {
    a: { value: 'example ltd', ref: 'L1', quote: 'q' },
    n: { value: null, reason: 'NOT IN INPUT' },
    any: { value: '12 months', ref: 'L2', quote: 'q' },
    c: { value: [30, 45], conflict: true, refs: [], quotes: [] },
    o: { x: { value: 1 }, y: { value: 3 } },
    list: [{ k: { value: 'a' } }, { k: { value: 'B' } }, { k: { value: 'Z' } }, { k: { value: 'Y' } }],
  });
  assert.deepEqual(
    { correct: good.correct, wrong: good.wrong, invented: good.invented, null_ok: good.null_ok, conflicts_caught: good.conflicts_caught, list: [good.list_matched, good.list_expected, good.list_answered] },
    { correct: 3, wrong: 1, invented: 0, null_ok: 1, conflicts_caught: 1, list: [2, 3, 4] },
  );
  assert.equal(good.need, 5 + 3, 'non-null scalar fields + expected list items');
  assert.equal(good.hit, 3 + 1 + 2);
  assert.equal(good.answered, 3 + 1 + 1 + 4, 'correct + wrong + conflicts + list items answered');
  const bad = scoreSchema(expect, { a: { value: null }, n: { value: 'made up' }, c: { value: 30 } });
  assert.equal(bad.invented, 1);
  assert.equal(bad.missed, 4, 'a, any, o.x and o.y are missed');
  assert.equal(bad.wrong, 1, 'a conflict answered as one value is wrong');
  assert.equal(bad.answered, 2, 'the invented value and the missed conflict');
  assert.deepEqual(bad.details.find((d) => d.path === 'c'), { path: 'c', result: 'conflict_missed', expected: { conflict: [30, 45] }, answered: 30 });
});

test('extract score: recall over required lines, precision over required ∪ allowed; NOT IN INPUT lines do not count', () => {
  const items = [
    { file: 'a.log', line: 3, status: 'ok' },
    { file: 'a.log', line: 4, status: 'ok' },
    { file: 'a.log', line: 8, status: 'ok' },
    { file: 'a.log', line: 99, status: 'bad' },
    { status: 'not_in_input' },
  ];
  const s = scoreExtract({ lines: ['L3', 'a.log:L6'], allowed: ['L4'] }, items, 'a.log');
  assert.deepEqual(s, { hit: 1, need: 2, answered: 4, in_allowed: 2, missing: ['a.log:L6'], extra: ['a.log:L8', 'a.log:L99'] });
});

test('suite: validated on load; the repo suite covers every format and both scored modes', async () => {
  const d = tmpDir();
  const bad = (cases, re) => {
    writeJson(path.join(d, 'suite.json'), { cases });
    assert.throws(() => loadSuite(d), re);
  };
  bad([{ id: 'a', mode: 'extract', files: ['x'], task: 't' }], /needs "expect": \{"lines"/);
  bad([{ id: 'a', mode: 'grep', files: ['x'], grep: { pattern: 'p' }, expect: {} }], /needs "grep" and "expect": \{"matches": N\}/);
  bad([{ id: 'a', mode: 'other', files: ['x'] }], /mode must be one of/);
  bad([{ id: 'a', mode: 'draft', files: ['x'], task: 't' }, { id: 'a', mode: 'draft', files: ['x'], task: 't' }], /duplicate id/);

  const suite = loadSuite(DEFAULT_SUITE);
  assert.ok(suite.cases.length >= 6 && suite.cases.length <= 10);
  const formats = new Set();
  for (const c of suite.cases) {
    for (const f of caseFiles(suite, c)) {
      const r = await readSource(f, { config: { max_file_bytes: 2e6, max_doc_bytes: 5e7, extract_timeout_s: 60 } });
      formats.add(r.format);
      // Every expected line exists; schema cases parse.
      for (const ref of [...(c.expect.lines ?? []), ...(c.expect.allowed ?? [])]) assert.ok(Number(/L(\d+)$/.exec(ref)[1]) <= r.lines.length, `${c.id}: ${ref}`);
    }
    if (c.mode === 'schema') parseSchema(c.schema);
  }
  assert.deepEqual([...formats].sort(), ['doc', 'docx', 'html', 'pdf', 'rtf', 'text']);
  assert.ok(suite.cases.some((c) => c.mode === 'extract') && suite.cases.some((c) => c.mode === 'schema'));
  // The grep case's expectation holds on the real pipeline (no model, no network).
  const config = parseConfig({ read_roots: suiteRoots(suite) });
  const g = suite.cases.find((c) => c.mode === 'grep');
  const res = await eyesRun({ mode: 'grep', files: caseFiles(suite, g), grep: g.grep }, { config, resultsDir: path.join(d, 'results'), stateDir: { path: d } }, { key: null, fetch: async () => assert.fail('network') });
  assert.equal(res.counts.matches, g.expect.matches);
});

// ---- a crafted suite through eyes_run ----

const LOG = fs.readFileSync(path.join(DEFAULT_SUITE, 'files', 'service.log'), 'utf8');
const TERMS = fs.readFileSync(path.join(DEFAULT_SUITE, 'files', 'supply-terms.md'), 'utf8');
const SUITE = {
  cases: [
    { id: 'log', mode: 'extract', files: ['service.log'], task: 'power', expect: { lines: ['L3', 'L6', 'L10'], allowed: ['L4', 'L7', 'L11'] } },
    {
      id: 'terms',
      mode: 'schema',
      files: ['terms.md'],
      schema: { supplier: 'string', delivery_days: 'number', warranty_months: 'number', items: [{ name: 'string', bags: 'number' }], penalty_rate: 'string' },
      expect: { supplier: 'Example Trading', delivery_days: { conflict: [30, 45] }, warranty_months: { any: [12, '12 months'] }, items: [{ name: 'Flour', bags: 20 }, { name: 'Sugar', bags: 15 }, { name: 'Salt', bags: 4 }], penalty_rate: null },
    },
    { id: 'grep', mode: 'grep', files: ['service.log'], grep: { pattern: 'power:' }, expect: { matches: 3 } },
  ],
};

const lineOf = (n) => `L${n}| ${LOG.split('\n')[n - 1]}`;
const v = (value, ref = 'L1', quote = 'x') => ({ value, ref, quote });
const ANSWERS = {
  'v/a': {
    extract: [3, 6, 4, 8].map(lineOf).join('\n'),
    schema: {
      supplier: v('Example Trading LLC'),
      delivery_days: { value: [30, 45], conflict: true, refs: ['L5', 'L14'], quotes: ['30 days', '45 days'] },
      warranty_months: v(12),
      items: [{ name: v('Flour'), bags: v(20) }, { name: v('Sugar'), bags: v(15) }],
      penalty_rate: { value: null, reason: 'NOT IN INPUT' },
    },
  },
  'v/b': {
    extract: [3, 6, 10].map(lineOf).join('\n'),
    schema: {
      supplier: v('Sample Foods'),
      delivery_days: v(30),
      warranty_months: v('12 months'),
      items: [{ name: v('Flour'), bags: v(20) }, { name: v('Sugar'), bags: v('15') }, { name: v('salt'), bags: v(4) }],
      penalty_rate: v('1% per day'),
    },
  },
};

function benchSetup(cost = 0.001) {
  const d = tmpDir();
  const dir = path.join(d, 'suite');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'service.log'), LOG);
  fs.writeFileSync(path.join(dir, 'terms.md'), TERMS);
  writeJson(path.join(dir, 'suite.json'), SUITE);
  const suite = loadSuite(dir);
  const config = parseConfig({ read_roots: suiteRoots(suite), models: { fast: { ids: ['v/a'] }, slow: { ids: ['v/b'] } }, defaults: { extract: 'fast' } });
  const stateDir = path.join(d, 'state');
  const ctx = { config, stateDir: { path: stateDir }, resultsDir: path.join(stateDir, 'results') };
  const chats = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/endpoints/zdr')) return json({ data: ZDR });
    if (!u.endsWith('/chat/completions')) throw new Error(`unexpected ${u}`);
    const body = JSON.parse(init.body);
    chats.push(body);
    const mode = /Mode: (\w+)\./.exec(body.messages[0].content)[1];
    const a = ANSWERS[body.model][mode];
    const content = typeof a === 'string' ? a : JSON.stringify(a);
    return json({ id: 'g', model: body.model, provider: body.model === 'v/a' ? 'Prov1' : 'Prov2', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 20, cost } });
  };
  return { suite, ctx, stateDir, fetch, chats };
}

test('bench: scores per model and per provider on mocked answers; Markdown and JSON report', async () => {
  const s = benchSetup();
  const ledger = new CappedLedger(new Ledger(s.stateDir), null);
  const report = await runBench({ suite: s.suite, models: ['fast', 'slow'], repeat: 2, ledger, run: (args) => eyesRun(args, s.ctx, { key: KEY, fetch: s.fetch, ledger, sleep: async () => {} }) });
  assert.equal(report.aborted, null);
  assert.equal(report.runs.length, 2 * (2 + 2 + 1), 'grep runs once per repetition, without a model');
  assert.equal(s.chats.length, 8);
  const fast = report.groups.by_model.fast;
  const slow = report.groups.by_model.slow;
  // fast: extract 2/3 found, 3 of 4 returned allowed; schema 5/6 found, 5/5 right.
  assert.deepEqual([fast.hit, fast.need, fast.in_allowed, fast.answered], [2 * (2 + 5), 2 * (3 + 6), 2 * (3 + 5), 2 * (4 + 5)]);
  assert.equal(fast.invented, 0);
  assert.deepEqual([fast.conflicts_caught, fast.conflicts_expected], [2, 2]);
  // slow: extract 3/3; schema: warranty right, supplier wrong, conflict missed, 1% invented, 3/3 items.
  assert.deepEqual([slow.hit, slow.need, slow.in_allowed, slow.answered], [2 * (3 + 4), 2 * (3 + 6), 2 * (3 + 4), 2 * (3 + 7)]);
  assert.deepEqual([slow.invented, slow.null_expected, slow.conflicts_caught], [2, 2, 0]);
  assert.ok(Math.abs(fast.cost - 0.004) < 1e-9);
  assert.deepEqual(Object.keys(report.groups.by_provider).sort(), ['Prov1', 'Prov2', 'none']);
  assert.equal(report.groups.by_model['(grep)'].grep_pass, 2);
  const md = renderMarkdown({ suite: 'crafted', models: ['fast', 'slow'], modes: null, repeat: 2, ...report });
  assert.match(md, /\| fast \| 4 \| 0 \| 78% \| 89% \| 0\/2 \| 2\/2 \| - \| 0\.0040 \| 400 \/ 80 \| \d+\.\d \|/);
  assert.match(md, /\| slow \| 4 \| 0 \| 78% \| 70% \| 2\/2 \| 0\/2 \| - \|/);
  assert.match(md, /### By provider[\s\S]*\| Prov1 \| 4 \|/);
  // The usage log and the results store hold the bench runs like any eyes_run.
  assert.equal(fs.readFileSync(path.join(s.stateDir, 'usage.jsonl'), 'utf8').trim().split('\n').length, 10);
});

test('bench: --max-usd stops the run at the next reservation and the report keeps what was done', async () => {
  const s = benchSetup(0.004);
  const ledger = new CappedLedger(new Ledger(s.stateDir), 0.008);
  const report = await runBench({ suite: s.suite, models: ['fast', 'slow'], ledger, run: (args) => eyesRun(args, s.ctx, { key: KEY, fetch: s.fetch, ledger, sleep: async () => {} }) });
  assert.equal(report.aborted, '--max-usd');
  assert.equal(report.runs.length, 2);
  assert.equal(report.runs[0].status, 'done');
  assert.equal(report.runs[1].status, 'failed');
  assert.match(report.runs[1].error, /bench --max-usd \$0\.008 reached/);
  assert.equal(s.chats.length, 1, 'the second call was never sent');
  assert.match(renderMarkdown({ suite: 'x', models: ['fast', 'slow'], repeat: 1, ...report }), /STOPPED: --max-usd[\s\S]*Failed runs:\n- log slow #1: /);
});

// ---- CLI ----

test('cli bench: argument checks, no key, a missing default suite never runs a model', () => {
  const base = tmpDir();
  const root = path.join(base, 'notes');
  fs.mkdirSync(root);
  const cfg = writeJson(path.join(base, 'cfg.json'), { read_roots: [root], models: { fast: { ids: ['v/a'] } }, defaults: { extract: 'fast' } });
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...isolatedEnv(path.join(base, 'home'), { CHEAP_EYES_CONFIG: cfg, CHEAP_EYES_STATE_DIR: path.join(base, 'state') }) };
  const run = (args) => {
    const r = spawnSync(process.execPath, [...CLI_ARGS, 'bench', ...args], { env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  assert.match(run(['--repeat', '0']).err, /--repeat must be a positive integer/);
  assert.equal(run(['--max-usd', '-1']).code, 2);
  assert.match(run(['--modes', 'extract,nope']).err, /--modes: one of/);
  assert.match(run(['--models', 'ghost']).err, /unknown model alias: ghost/);
  const nokey = run([]);
  assert.equal(nokey.code, 1);
  assert.match(nokey.err, /OpenRouter key is not set/);
  // grep only: no model and no key needed; the table goes to stdout, JSON to --out.
  const out = path.join(base, 'bench.json');
  const g = run(['--modes', 'grep', '--out', out]);
  assert.equal(g.code, 0, g.err);
  assert.match(g.out, /^## cheap-eyes bench: .*\n\nmodels: -; modes: grep; repeat: 1; runs: 1\n/);
  assert.match(g.out, /\| \(grep\) \| 1 \| 0 \| - \| - \| - \| - \| 1\/1 \| 0\.0000 \|/);
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(json.runs[0].score.pass, true);
});
