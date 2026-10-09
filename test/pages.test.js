// Extracted formats in the 0.1 pipeline: page markers in rendering and chunking,
// refs shown with pages in checks and headers, refusals before any network call.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { Ledger } from '../src/budget.js';
import { checkExtractChunk, checkJob, chunkView, describeItem } from '../src/checks.js';
import { parseConfig } from '../src/config.js';
import { clearCatalogCache } from '../src/openrouter.js';
import { readCheck } from '../src/results.js';
import { chunkBlocks, fileItems } from '../src/input/render.js';
import { eyesRun, prepareInput, spanText } from '../src/run.js';
import { tmpDir } from './helpers.js';

const FX = path.join(import.meta.dirname, 'fixtures', 'formats');
const KEY = 'sk-' + 'or-v1-FAKE0000000000000000000000000000000000000000000000000000'; // fake, scan-secrets:allow
const ZDR = [{ model_id: 'v/a', provider_name: 'P', context_length: 32000, max_completion_tokens: 4096, pricing: { prompt: '0.0000002', completion: '0.0000004', request: '0' } }];

beforeEach(() => clearCatalogCache());

const masked = (lines) => new Map(lines.map((l, i) => [i, l]));

test('fileItems: markers before their line; across skipped lines only the last one', () => {
  const lines = ['a', 'b', 'c', 'd', 'e', 'f'];
  const markers = [
    { at: 0, text: '--- page 1 ---' },
    { at: 2, text: '--- page 2 ---' },
    { at: 2, text: '--- page 3 ---' },
    { at: 4, text: '--- page 4 ---' },
  ];
  const all = fileItems({ nums: [1, 2, 3, 4, 5, 6], masked: masked(lines), total: 6, filtered: false, markers });
  assert.deepEqual(
    all.map((it) => it.text),
    ['--- page 1 ---', 'L1| a', 'L2| b', '--- page 2 ---', '--- page 3 ---', 'L3| c', 'L4| d', '--- page 4 ---', 'L5| e', 'L6| f'],
  );
  const some = fileItems({ nums: [2, 6], masked: masked(lines), total: 6, filtered: true, markers });
  assert.deepEqual(some.map((it) => it.text), ['… (line 1 skipped)', '--- page 1 ---', 'L2| b', '… (lines 3–5 skipped)', '--- page 4 ---', 'L6| f']);
  assert.ok(all.filter((it) => it.kind === 'marker').every((it) => it.n === undefined));
});

test('chunking: a break inside a page repeats that page marker before the overlap', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line number ${i + 1} with some words`);
  const markers = [{ at: 0, text: '--- page 1 ---' }, { at: 20, text: '--- page 2 ---' }];
  const items = fileItems({ nums: lines.map((_, i) => i + 1), masked: masked(lines), total: 40, filtered: false, markers });
  const chunks = chunkBlocks([{ name: 'a.pdf', items }], { budget: 200, multi: false });
  assert.ok(chunks.length > 2);
  for (const c of chunks) {
    const first = c.text.split('\n')[0];
    assert.match(first, /^--- page \d ---$/, c.text);
    const n = Number(/L(\d+)\|/.exec(c.text)[1]);
    assert.equal(first, n <= 20 ? '--- page 1 ---' : '--- page 2 ---');
  }
  // Markers are never counted as lines of a chunk.
  const covered = chunks.flatMap((c) => c.lines['a.pdf'].flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a + k)));
  assert.deepEqual([...new Set(covered)].sort((a, b) => a - b), lines.map((_, i) => i + 1));
});

test('checks: soft hyphen and NBSP differences are ok~, also for plain text files', () => {
  const chunk = { lines: { 'a.md': [[1, 2]] } };
  const view = chunkView(chunk, new Map([['a.md', masked(['мы плани­руем', 'НМЦК: 3 605'])]]), 'a.md');
  const items = checkExtractChunk('L1| мы планируем\nL2| НМЦК: 3 605', view, 1);
  assert.deepEqual(items.map((i) => i.status), ['ok~', 'ok~']);
});

test('checks: refs carry pages through the line → page table (extract, draft, edits)', () => {
  const chunks = [{ lines: { 'r.pdf': [[1, 4]] }, span: { from: { name: 'r.pdf', n: 1 }, to: { name: 'r.pdf', n: 4 } } }];
  const sources = new Map([['r.pdf', masked(['alpha', 'beta', 'gamma 42', 'delta'])]]);
  const pages = new Map([['r.pdf', [1, 3]]]);
  const ex = checkJob({ mode: 'extract', chunks, outs: [{ text: 'L1| alpha\nL3| gamma 43\nL9| x' }], sources, pages, singleName: 'r.pdf', spanText });
  assert.deepEqual(ex.items.map((i) => [i.ref, i.status, i.page]), [['L1 (p.1)', 'ok', 1], ['L3 (p.2)', 'bad', 2], ['L9', 'bad', undefined]]);
  assert.match(describeItem(ex.items[1]), /^L3 \(p\.2\) \[bad\]/);
  const dr = checkJob({ mode: 'draft', chunks, outs: [{ text: 'Gamma is 42 (L3-L4)\nAlpha (L1)' }], sources, pages, singleName: 'r.pdf', spanText });
  assert.deepEqual(dr.items.map((i) => i.pages), [[2], [1]]);
  const ed = checkJob({ mode: 'edits', chunks, outs: [{ text: '{"file":"","line":3,"old":"42","new":"43","why":"w"}\n{"file":"","line":2,"old":"zzz","new":"y","why":"w"}' }], sources, pages, singleName: 'r.pdf', spanText });
  assert.equal(ed.valid[0].page, 2);
  assert.match(describeItem(ed.rejected[0]), /:L2 \(p\.1\) \[bad\]/);
});

function setup() {
  const d = tmpDir();
  const root = path.join(d, 'docs');
  fs.mkdirSync(root, { recursive: true });
  for (const f of ['text.pdf', 'text.docx', 'refused.xls', 'refused-encrypted.docx', 'utf8.html']) fs.copyFileSync(path.join(FX, f), path.join(root, f));
  fs.writeFileSync(path.join(root, 'notes.md'), 'plain line\n');
  const config = parseConfig({ read_roots: [root], models: { fast: { ids: ['v/a'] } }, defaults: { extract: 'fast', draft: 'fast', edits: 'fast' } });
  const stateDir = path.join(d, 'state');
  return { root, config, stateDir, ctx: { config, stateDir: { path: stateDir }, resultsDir: path.join(stateDir, 'results') } };
}

test('pipeline: a PDF gets numbered lines, a page marker, a page table and the marker rule in the prompt', async () => {
  const s = setup();
  const input = await prepareInput({ mode: 'extract', task: 't', files: [path.join(s.root, 'text.pdf')] }, { config: s.config });
  const items = input.kept[0].items;
  assert.deepEqual(items.slice(0, 2).map((i) => i.text), ['--- page 1 ---', 'L1| Fixture: cheap-eyes formats']);
  assert.match(input.system, /"--- page 12 ---" or "--- attachment: a\.pdf ---" mark page or section boundaries inside a file, not files/);
  assert.equal(input.files[0].format, 'pdf');
  assert.deepEqual(input.files[0].page_starts, [1]);
  assert.deepEqual([...input.pages.keys()], ['text.pdf']);
  // Masking runs on extracted text as on files.
  assert.ok(!items.some((i) => i.text.includes('Fixture-Not-A-Real-Secret-7')));
  const plain = await prepareInput({ mode: 'extract', task: 't', files: [path.join(s.root, 'notes.md')] }, { config: s.config });
  assert.doesNotMatch(plain.system, /--- page/);
  assert.equal(plain.files[0].format, 'text');
});

test('pipeline: grep over a PDF keeps the page marker of the matched line', async () => {
  const s = setup();
  const input = await prepareInput({ mode: 'extract', task: 't', files: [path.join(s.root, 'text.pdf')], grep: { pattern: 'Voltage', context: 0 } }, { config: s.config });
  assert.deepEqual(input.kept[0].items.map((i) => i.kind), ['gap', 'marker', 'line', 'gap']);
});

test('refusals come before any network call or budget reservation; glob matches are skipped with the format named', async () => {
  const s = setup();
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    throw new Error('no network');
  };
  const ledger = new Ledger(s.stateDir);
  ledger.reserve = () => assert.fail('budget reserved for a refused input');
  const deps = { key: KEY, fetch, ledger, sleep: async () => {} };
  for (const [f, re] of [
    ['refused.xls', /unsupported format: Excel workbook \(\.xls\)/],
    ['refused-encrypted.docx', /encrypted document — cheap-eyes cannot read password-protected files/],
  ]) {
    await assert.rejects(eyesRun({ task: 't', mode: 'extract', files: [path.join(s.root, f)] }, s.ctx, deps), (e) => e.name === 'InputError' && re.test(e.message));
  }
  assert.deepEqual(calls, []);
  assert.equal(ledger.day, null, 'the ledger was not even loaded');
  assert.ok(!fs.existsSync(s.ctx.resultsDir), 'no result was allocated');
  const input = await prepareInput({ mode: 'extract', task: 't', files: [path.join(s.root, '*')] }, { config: s.config });
  assert.deepEqual(input.files.map((f) => `${f.name}:${f.format}`).sort(), ['notes.md:text', 'text.docx:docx', 'text.pdf:pdf', 'utf8.html:html']);
  assert.deepEqual(
    input.skipped.map((x) => `${path.basename(x.path)}: ${x.reason}`).sort(),
    ['refused-encrypted.docx: encrypted document', 'refused.xls: unsupported format: Excel workbook (.xls)'],
  );
});

test('end to end: an extract over a PDF shows refs with pages in the header and check.json', async () => {
  const s = setup();
  const fetch = async (url) => {
    const u = String(url);
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/endpoints/zdr')) return json({ data: ZDR });
    if (u.endsWith('/chat/completions')) {
      const content = 'L2| Bid security: 1 000 000 PKR. Deadline: 2026-02-17 11:00.\nL5| НМЦК: 3 605 044,00 руб\nL99| invented';
      return json({ id: 'g', model: 'v/a', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 50, completion_tokens: 10, cost: 0.0001 } });
    }
    throw new Error(`unexpected ${u}`);
  };
  const r = await eyesRun({ task: 't', mode: 'extract', files: [path.join(s.root, 'text.pdf')] }, s.ctx, { key: KEY, fetch, ledger: new Ledger(s.stateDir), sleep: async () => {} });
  assert.match(r.header, /L5 \(p\.1\) \[bad\] text differs from the source line/);
  const check = await readCheck(s.ctx.resultsDir, r.id);
  assert.deepEqual(check.checks.items.map((i) => i.ref), ['L2 (p.1)', 'L5 (p.1)', 'L99']);
  assert.equal(check.files[0].format, 'pdf');
  assert.deepEqual(check.files[0].page_starts, [1]);
});
