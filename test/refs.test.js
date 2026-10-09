// File names in refs (exact or a unique tail) and the page in extract result lines
// from PDF.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { scoreExtract } from '../src/bench.js';
import { Ledger } from '../src/budget.js';
import { checkJob, chunkView, parseQuoteLine } from '../src/checks.js';
import { parseConfig } from '../src/config.js';
import { clearCatalogCache } from '../src/openrouter.js';
import { readCheck } from '../src/results.js';
import { eyesRun, spanText } from '../src/run.js';
import { checkSchemaJob, parseSchema } from '../src/schema.js';
import { tmpDir } from './helpers.js';

const FX = path.join(import.meta.dirname, 'fixtures', 'formats');
const KEY = 'sk-' + 'or-v1-FAKE0000000000000000000000000000000000000000000000000000'; // fake, scan-secrets:allow
const ZDR = [{ model_id: 'v/a', provider_name: 'P', context_length: 200000, max_completion_tokens: null, pricing: { prompt: '0.0000002', completion: '0.0000004', request: '0' } }];

beforeEach(() => clearCatalogCache());

// One chunk carrying lines 1–3 of each named file; line n of file f is "<f> line <n>".
function job(names) {
  const lines = Object.fromEntries(names.map((n) => [n, [[1, 3]]]));
  const chunk = { lines, span: { from: { name: names[0], n: 1 }, to: { name: names.at(-1), n: 3 } } };
  const sources = new Map(names.map((n) => [n, new Map([0, 1, 2].map((i) => [i, `${n} line ${i + 1}`]))]));
  return { chunks: [chunk], sources, singleName: names.length === 1 ? names[0] : null };
}

const NAMES = ['raw/bench/1. Обоснование НМЦК.docx', 'raw/bench/2. Проект ГК.doc', 'notes/c++ v1.2.md', 'a/x.md', 'b/x.md', 'ax.md'];

test('lookup: exact header name, a unique tail at a "/" boundary, ambiguous, unknown', () => {
  const { chunks, sources } = job(NAMES);
  const v = chunkView(chunks[0], sources, null);
  assert.deepEqual(v.lookup('raw/bench/2. Проект ГК.doc'), { name: 'raw/bench/2. Проект ГК.doc' });
  assert.deepEqual(v.lookup('2. Проект ГК.doc'), { name: 'raw/bench/2. Проект ГК.doc' });
  assert.deepEqual(v.lookup('bench/2. Проект ГК.doc'), { name: 'raw/bench/2. Проект ГК.doc' });
  assert.deepEqual(v.lookup('c++ v1.2.md'), { name: 'notes/c++ v1.2.md' });
  assert.deepEqual(v.lookup('x.md'), { ambiguous: true }, 'a/x.md and b/x.md');
  assert.deepEqual(v.lookup('ax.md'), { name: 'ax.md' }, 'exact wins');
  assert.deepEqual(v.lookup('Проект ГК.doc'), { unknown: true }, 'a tail not at a "/" boundary');
  assert.deepEqual(v.lookup('missing.doc'), { unknown: true });
  // "x.md" is a suffix of "ax.md" but not at a "/" boundary.
  const only = job(['ax.md', 'notes/b.md']);
  assert.deepEqual(chunkView(only.chunks[0], only.sources, null).lookup('x.md'), { unknown: true });
});

test('extract: a short unique name resolves, the full header name is kept; ambiguous and unknown names are reported', () => {
  const j = job(NAMES);
  const out = [
    '2. Проект ГК.doc:L2| raw/bench/2. Проект ГК.doc line 2',
    'raw/bench/1. Обоснование НМЦК.docx:L1| raw/bench/1. Обоснование НМЦК.docx line 1',
    'c++ v1.2.md:L3| notes/c++ v1.2.md line 3',
    'x.md:L1| a/x.md line 1',
    'Проект ГК.doc:L1| raw/bench/2. Проект ГК.doc line 1',
  ].join('\n');
  const r = checkJob({ mode: 'extract', ...j, outs: [{ text: out }], pages: new Map(), spanText });
  assert.deepEqual(
    r.items.map((i) => [i.ref, i.file, i.status, i.reason ?? null]),
    [
      ['raw/bench/2. Проект ГК.doc:L2', 'raw/bench/2. Проект ГК.doc', 'ok', null],
      ['raw/bench/1. Обоснование НМЦК.docx:L1', 'raw/bench/1. Обоснование НМЦК.docx', 'ok', null],
      ['notes/c++ v1.2.md:L3', 'notes/c++ v1.2.md', 'ok', null],
      ['x.md:L1', 'x.md', 'bad', 'ambiguous file name in ref: x.md'],
      ['Проект ГК.doc:L1', 'Проект ГК.doc', 'bad', 'unknown file name'],
    ],
  );
});

test('draft and edits: short unique names resolve; ambiguous names get their own reason', () => {
  const j = job(NAMES);
  const draft = checkJob({ mode: 'draft', ...j, outs: [{ text: 'Price (2. Проект ГК.doc:L2)\nBoth (x.md:L1)\nNone (Проект ГК.doc:L1)' }], pages: new Map(), spanText });
  assert.deepEqual(draft.items.map((i) => [i.status, i.refs_ok, i.issues]), [
    ['ok', 1, []],
    ['bad', 0, ['ambiguous file name in ref: x.md']],
    ['bad', 0, ['ref to an unknown file: Проект ГК.doc:L1']],
  ]);
  const edits = checkJob({
    mode: 'edits',
    ...j,
    outs: [{ text: ['{"file":"2. Проект ГК.doc","line":2,"old":"line 2","new":"L2","why":"w"}', '{"file":"x.md","line":1,"old":"line 1","new":"L1","why":"w"}'].join('\n') }],
    pages: new Map(),
    spanText,
  });
  assert.equal(edits.valid[0].file, 'raw/bench/2. Проект ГК.doc');
  assert.equal(edits.rejected[0].reason, 'ambiguous file name in ref: x.md');
});

test('schema: a ref with a short unique name resolves to the full name; ambiguous is a bad ref with that reason', () => {
  const j = job(NAMES);
  const v = chunkView(j.chunks[0], j.sources, null);
  const schema = parseSchema({ price: 'string', other: 'string' });
  const answer = {
    price: { value: 'line 2', ref: '2. Проект ГК.doc:L2', quote: 'raw/bench/2. Проект ГК.doc line 2' },
    other: { value: 'line 1', ref: 'x.md:L1', quote: 'a/x.md line 1' },
  };
  const r = checkSchemaJob({ schema, outs: [{ text: JSON.stringify(answer) }], views: [v] });
  assert.deepEqual(r.items.map((i) => [i.path, i.status, i.ref ?? null, i.note ?? null]), [
    ['price', 'ok', 'raw/bench/2. Проект ГК.doc:L2', null],
    ['other', 'bad_ref', 'x.md:L1', 'ambiguous file name in ref: x.md'],
  ]);
});

// ---- the page in extract result lines ----

test('the parser reads "L12 (p.3)|" as well as "L12|"', () => {
  assert.deepEqual(parseQuoteLine('L12 (p.3)| text', []), { name: null, n: 12, text: 'text' });
  assert.deepEqual(parseQuoteLine('a.pdf:L12 (p.3)| text', ['a.pdf']), { name: 'a.pdf', n: 12, text: 'text' });
  assert.deepEqual(parseQuoteLine('short.pdf:L12 (p.3)| text', []), { name: 'short.pdf', n: 12, text: 'text' });
});

function setup() {
  const d = tmpDir();
  const root = path.join(d, 'docs');
  fs.mkdirSync(path.join(root, 'pdf'), { recursive: true });
  fs.copyFileSync(path.join(FX, 'text.pdf'), path.join(root, 'pdf', 'text.pdf'));
  fs.writeFileSync(path.join(root, 'notes.md'), 'alpha\nbeta\n');
  const config = parseConfig({ read_roots: [root], models: { fast: { ids: ['v/a'] } }, defaults: { extract: 'fast' } });
  const stateDir = path.join(d, 'state');
  return { root, stateDir, ctx: { config, stateDir: { path: stateDir }, resultsDir: path.join(stateDir, 'results') } };
}

function chat(content) {
  return async (url) => {
    const u = String(url);
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/endpoints/zdr')) return json({ data: ZDR });
    if (!u.endsWith('/chat/completions')) throw new Error(`unexpected ${u}`);
    return json({ id: 'g', model: 'v/a', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } });
  };
}

test('extract over a PDF: every result line carries its page, the text after "|" untouched; a cut line too', async () => {
  const s = setup();
  const out = ['L2| Bid security: 1 000 000 PKR. Deadline: 2026-02-17 11:00.', 'L5| НМЦК: 3 605 044,00 …', 'L99| invented'].join('\n');
  const r = await eyesRun({ task: 't', mode: 'extract', files: [path.join(s.root, 'pdf', 'text.pdf')] }, s.ctx, { key: KEY, fetch: chat(out), ledger: new Ledger(s.stateDir), sleep: async () => {} });
  assert.equal(r.text, ['L2 (p.1)| Bid security: 1 000 000 PKR. Deadline: 2026-02-17 11:00.', 'L5 (p.1)| НМЦК: 3 605 044,00 …', 'L99| invented'].join('\n') + '\n');
  const check = await readCheck(s.ctx.resultsDir, r.id);
  assert.deepEqual(check.checks.items.map((i) => [i.ref, i.status]), [['L2 (p.1)', 'ok'], ['L5 (p.1)', 'partial'], ['L99', 'bad']]);
  // bench scores the same lines whatever the prefix.
  assert.equal(scoreExtract({ lines: ['L2', 'L5'] }, check.checks.items, 'pdf/text.pdf').hit, 2);
});

test('extract over a PDF and a text file: the page only on PDF lines, with the name, short names too', async () => {
  const s = setup();
  const out = ['pdf/text.pdf:L9| Voltage 3.0 3.6', 'text.pdf:L8| Temperature −40 105', 'notes.md:L2| beta'].join('\n');
  const r = await eyesRun({ task: 't', mode: 'extract', files: [path.join(s.root, 'pdf', 'text.pdf'), path.join(s.root, 'notes.md')] }, s.ctx, { key: KEY, fetch: chat(out), ledger: new Ledger(s.stateDir), sleep: async () => {} });
  assert.equal(r.text, ['pdf/text.pdf:L9 (p.1)| Voltage 3.0 3.6', 'text.pdf:L8 (p.1)| Temperature −40 105', 'notes.md:L2| beta'].join('\n') + '\n');
  const check = await readCheck(s.ctx.resultsDir, r.id);
  assert.deepEqual(check.checks.items.map((i) => [i.ref, i.file, i.status]), [
    ['pdf/text.pdf:L9 (p.1)', 'pdf/text.pdf', 'ok'],
    ['pdf/text.pdf:L8 (p.1)', 'pdf/text.pdf', 'ok'],
    ['notes.md:L2', 'notes.md', 'ok'],
  ]);
  assert.equal(scoreExtract({ lines: ['pdf/text.pdf:L9', 'pdf/text.pdf:L8', 'notes.md:L2'] }, check.checks.items, null).hit, 3);
});
