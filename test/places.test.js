// The place of a line in refs ("L5 (slide 2)", "L32 (attachment: forwarded.eml,
// attachments)"): built from the doclines sections, outer to inner; shown in extract
// results, grep mode, checks and schema refs; derived from the line number, never taken
// from the model. The `page` field stays for top-level PDF pages only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { sectionOf } from 'doclines';
import { Ledger } from '../src/budget.js';
import { checkJob, chunkView, describeItem, parseQuoteLine } from '../src/checks.js';
import { parseConfig } from '../src/config.js';
import { readSource } from '../src/input/extract.js';
import { clearCatalogCache } from '../src/openrouter.js';
import { placeOf, sectionChain } from '../src/place.js';
import { eyesResult } from '../src/result-tool.js';
import { readCheck } from '../src/results.js';
import { eyesRun, spanText } from '../src/run.js';
import { checkSchemaJob, checkValue, parseSchema } from '../src/schema.js';
import { sourcesDir } from '../src/sources.js';
import { tmpDir } from './helpers.js';

const FX = path.join(import.meta.dirname, 'fixtures', 'formats');
const KEY = 'sk-' + 'or-v1-FAKE0000000000000000000000000000000000000000000000000000'; // fake, scan-secrets:allow
const ZDR = [{ model_id: 'v/a', provider_name: 'P', context_length: 200000, max_completion_tokens: null, pricing: { prompt: '0.0000002', completion: '0.0000004', request: '0' } }];
const CONFIG = { max_file_bytes: 2 * 1024 * 1024, max_doc_bytes: 50 * 1024 * 1024, extract_timeout_s: 60 };

beforeEach(() => clearCatalogCache());

const read = (f) => readSource(path.join(FX, f), { name: f, config: CONFIG });
const at = (r, n) => placeOf(r.sections, n);

// ---- the place from the sections ----

test('a message with a PDF attachment: the chain outer to inner; equal ranges keep the doclines order', () => {
  const sections = [
    { kind: 'attachments', n: null, label: null, start: 5, end: 6 },
    { kind: 'attachment', n: null, label: 'offer (1).pdf', start: 7, end: 20 },
    { kind: 'page', n: 1, label: null, start: 7, end: 12 },
    { kind: 'page', n: 2, label: null, start: 13, end: 20 },
    { kind: 'attachment', n: null, label: 'one.pdf', start: 21, end: 25 },
    { kind: 'page', n: 1, label: null, start: 21, end: 25 },
    { kind: 'attachment', n: null, label: 'empty.txt', start: 26, end: 25 },
    { kind: 'attachment', n: null, label: 'deck.pptx', start: 26, end: 30 },
    { kind: 'slide', n: 1, label: null, start: 26, end: 28 },
    { kind: 'notes', n: 1, label: null, start: 29, end: 30 },
  ];
  assert.equal(placeOf(sections, 1), null, 'the message head is in no section');
  assert.equal(placeOf(sections, 5), 'attachments');
  assert.equal(placeOf(sections, 7), 'attachment: offer (1).pdf, p.1');
  assert.equal(placeOf(sections, 14), 'attachment: offer (1).pdf, p.2');
  assert.equal(placeOf(sections, 21), 'attachment: one.pdf, p.1', 'a one-page PDF has the range of its attachment');
  assert.equal(placeOf(sections, 27), 'attachment: deck.pptx, slide 1', 'an empty section holds no line');
  assert.equal(placeOf(sections, 30), 'attachment: deck.pptx, notes 1');
  assert.deepEqual(sectionChain(sections, 14).map((s) => s.kind), ['attachment', 'page']);
  assert.equal(placeOf(null, 3), null);
});

test('place texts: chapter by number only, notes with and without a number, footnotes, endnotes', () => {
  const s = [
    { kind: 'chapter', n: 2, label: 'Глава первая', start: 1, end: 2 },
    { kind: 'notes', n: null, label: null, start: 3, end: 3 },
    { kind: 'footnotes', n: null, label: null, start: 4, end: 4 },
    { kind: 'endnotes', n: null, label: null, start: 5, end: 5 },
    { kind: 'notes', n: 4, label: null, start: 6, end: 6 },
  ];
  assert.deepEqual([1, 3, 4, 5, 6].map((n) => placeOf(s, n)), ['chapter 2', 'notes', 'footnotes', 'endnotes', 'notes 4']);
  // An attachment name as its marker shows it: one line, no control characters.
  assert.equal(placeOf([{ kind: 'attachment', n: null, label: 'a\r\nb\u0007.pdf', start: 1, end: 1 }], 1), 'attachment: a b.pdf');
});

test('the innermost section of the chain is the one doclines sectionOf gives, on every fixture line', async () => {
  for (const f of ['text.pdf', 'text.pptx', 'text.ppt', 'text.odp', 'text.epub', 'text.fb2', 'mail-mixed.eml']) {
    const r = await read(f);
    for (let n = 1; n <= r.lines.length; n++) assert.equal(sectionChain(r.sections, n).at(-1) ?? null, sectionOf(r, n), `${f}:L${n}`);
  }
  // Equal ranges: a one-page PDF attachment and its page; the page is the inner one.
  const tie = {
    sections: [
      { kind: 'attachment', n: null, label: 'one.pdf', start: 5, end: 7 },
      { kind: 'page', n: 1, label: null, start: 5, end: 7 },
      { kind: 'attachment', n: null, label: 'two.pdf', start: 8, end: 10 },
      { kind: 'page', n: 1, label: null, start: 8, end: 9 },
    ],
  };
  for (let n = 1; n <= 11; n++) assert.equal(sectionChain(tie.sections, n).at(-1) ?? null, sectionOf(tie, n), `L${n}`);
  assert.equal(sectionOf(tie, 6).kind, 'page');
});

test('places of the fixtures: slides and notes, chapters, FB2 notes, attachments', async () => {
  const pptx = await read('text.pptx');
  assert.deepEqual([1, 4, 5, 9, 13].map((n) => at(pptx, n)), ['slide 1', 'notes 1', 'slide 2', 'slide 3', 'notes 4']);
  const epub = await read('text.epub');
  assert.equal(epub.lines[3], 'Срок исполнения контракта — 27 ноября 2026 года.1');
  assert.deepEqual([1, 4, 10].map((n) => at(epub, n)), ['chapter 1', 'chapter 2', 'chapter 3']);
  const fb2 = await read('text.fb2');
  assert.deepEqual([1, 3, 13].map((n) => at(fb2, n)), [null, 'chapter 1', 'notes']);
  const eml = await read('mail-mixed.eml');
  assert.equal(eml.lines[31], 'inner.txt (text/plain, 31 bytes)');
  assert.deepEqual(
    [1, 12, 21, 25, 31, 32].map((n) => at(eml, n)),
    [null, 'attachments', 'attachment: text.docx', 'attachment: pixel.png', 'attachment: forwarded.eml', 'attachment: forwarded.eml, attachments'],
  );
  assert.equal(eml.pageStarts, null, 'no page table for a message');
});

// ---- the ref parsers ----

test('a line prefix with any place in parentheses is read; the text after "|" is kept', () => {
  assert.deepEqual(parseQuoteLine('L5 (slide 2)| Table slide', []), { name: null, n: 5, text: 'Table slide' });
  assert.deepEqual(parseQuoteLine('a.eml:L20 (attachment: offer (1).pdf, p.2)| x (y)| z', ['a.eml']), { name: 'a.eml', n: 20, text: 'x (y)| z' });
  assert.deepEqual(parseQuoteLine('L7| a (b)| c', []), { name: null, n: 7, text: 'a (b)| c' });
});

// ---- checks ----

function view(lines, sections, { name = 'd.pptx', pages = new Map() } = {}) {
  const src = new Map(lines.map((l, i) => [i, l]));
  return { chunk: { lines: { [name]: [[1, lines.length]] }, span: { from: { name, n: 1 }, to: { name, n: lines.length } } }, sources: new Map([[name, src]]), pages, places: new Map([[name, sections]]) };
}

const DECK = ['Title', 'Body', 'Notes text', 'Table slide', 'A | 1'];
const DECK_SECTIONS = [
  { kind: 'slide', n: 1, label: null, start: 1, end: 2 },
  { kind: 'notes', n: 1, label: null, start: 3, end: 3 },
  { kind: 'slide', n: 2, label: null, start: 4, end: 5 },
];

test('checks: extract, draft and edits carry the place; no page outside a PDF', () => {
  const v = view(DECK, DECK_SECTIONS);
  const job = { chunks: [v.chunk], sources: v.sources, pages: v.pages, places: v.places, singleName: 'd.pptx', spanText };
  // The model echoes a prefix with a place, a wrong place, or none: all resolve by number.
  const ex = checkJob({ mode: 'extract', ...job, outs: [{ text: 'L4 (slide 2)| Table slide\nL3 (p.9)| Notes text\nL1| Title\nL5| A | 2' }] });
  assert.deepEqual(ex.items.map((i) => [i.ref, i.status, i.place, i.page]), [
    ['L4 (slide 2)', 'ok', 'slide 2', undefined],
    ['L3 (notes 1)', 'ok', 'notes 1', undefined],
    ['L1 (slide 1)', 'ok', 'slide 1', undefined],
    ['L5 (slide 2)', 'bad', 'slide 2', undefined],
  ]);
  assert.equal(ex.text, 'L4 (slide 2)| Table slide\nL3 (notes 1)| Notes text\nL1 (slide 1)| Title\nL5 (slide 2)| A | 2\n');
  assert.match(describeItem(ex.items[3]), /^L5 \(slide 2\) \[bad\] text differs/);
  const dr = checkJob({ mode: 'draft', ...job, outs: [{ text: 'Title and notes (L1-L3)\nTable A is 2 (L5)' }] });
  assert.deepEqual(dr.items.map((i) => [i.places, i.pages]), [[['slide 1', 'notes 1'], undefined], [['slide 2'], undefined]]);
  assert.match(describeItem(dr.items[1]), /^line 2 \(slide 2\) \[ok\]/);
  const ed = checkJob({ mode: 'edits', ...job, outs: [{ text: '{"file":"","line":5,"old":"1","new":"2","why":"w"}\n{"file":"","line":3,"old":"zzz","new":"y","why":"w"}' }] });
  assert.deepEqual([ed.valid[0].place, ed.valid[0].page], ['slide 2', undefined]);
  assert.match(describeItem(ed.rejected[0]), /^d\.pptx:L3 \(notes 1\) \[bad\]/);
});

test('checks on a PDF: place "p.N" and the page field as before', () => {
  const v = view(['a', 'b', 'c'], [{ kind: 'page', n: 1, label: null, start: 1, end: 2 }, { kind: 'page', n: 2, label: null, start: 3, end: 3 }], { name: 'r.pdf', pages: new Map([['r.pdf', [1, 3]]]) });
  const ex = checkJob({ mode: 'extract', chunks: [v.chunk], sources: v.sources, pages: v.pages, places: v.places, singleName: 'r.pdf', spanText, outs: [{ text: 'L3| c' }] });
  assert.deepEqual(ex.items.map((i) => [i.ref, i.page, i.place]), [['L3 (p.2)', 2, 'p.2']]);
  const dr = checkJob({ mode: 'draft', chunks: [v.chunk], sources: v.sources, pages: v.pages, places: v.places, singleName: 'r.pdf', spanText, outs: [{ text: 'All 42 (L1-L3)' }] });
  assert.deepEqual([dr.items[0].pages, dr.items[0].places], [[1, 2], ['p.1', 'p.2']]);
  assert.match(describeItem(dr.items[0]), /^line 1 \(p\.1, 2\) \[flag\]/);
});

test('checks: a PDF page inside an attachment has a place, no page field', () => {
  const sections = [
    { kind: 'attachment', n: null, label: 'offer.pdf', start: 2, end: 3 },
    { kind: 'page', n: 1, label: null, start: 2, end: 2 },
    { kind: 'page', n: 2, label: null, start: 3, end: 3 },
  ];
  const v = view(['From: a', 'Price', 'Total 42'], sections, { name: 'm.eml' });
  const ex = checkJob({ mode: 'extract', chunks: [v.chunk], sources: v.sources, pages: v.pages, places: v.places, singleName: 'm.eml', spanText, outs: [{ text: 'L3| Total 42\nL1| From: a' }] });
  assert.deepEqual(ex.items.map((i) => [i.ref, i.page, i.place]), [['L3 (attachment: offer.pdf, p.2)', undefined, 'attachment: offer.pdf, p.2'], ['L1', undefined, undefined]]);
  assert.equal(ex.text, 'L3 (attachment: offer.pdf, p.2)| Total 42\nL1| From: a\n');
});

test('schema: the ref carries the place; a ref the model wrote with a place still resolves', () => {
  const v = view(DECK, DECK_SECTIONS);
  const cv = chunkView(v.chunk, v.sources, 'd.pptx', v.pages, v.places);
  assert.deepEqual(checkValue({ value: 'Notes text', ref: 'L3', quote: 'Notes text' }, cv), { ref: 'L3 (notes 1)', place: 'notes 1', status: 'ok' });
  assert.deepEqual(checkValue({ value: 'Table slide', ref: 'L4 (slide 2)', quote: 'L4 (slide 2)| Table slide' }, cv), { ref: 'L4 (slide 2)', place: 'slide 2', status: 'ok~' });
  assert.equal(checkValue({ value: 'Body', ref: '(L1-L2 (slide 1))', quote: 'Body' }, cv).status, 'ok');
  const r = checkSchemaJob({ schema: parseSchema({ title: 'string' }), outs: [{ text: JSON.stringify({ title: { value: 'Title', ref: 'L1', quote: 'Title' } }) }], views: [cv] });
  assert.deepEqual(r.items.map((i) => [i.path, i.status, i.ref, i.place, i.page]), [['title', 'ok', 'L1 (slide 1)', 'slide 1', undefined]]);
});

// ---- end to end ----

function setup(files) {
  const d = tmpDir();
  const root = path.join(d, 'docs');
  fs.mkdirSync(root, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(FX, f), path.join(root, f));
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

test('extract over a deck and a message: places in the result lines, check.json and the sources index', async () => {
  const s = setup(['text.pptx', 'mail-mixed.eml']);
  const out = ['text.pptx:L5 (slide 2)| Table slide', 'text.pptx:L4| Speaker notes for slide one', 'mail-mixed.eml:L32| inner.txt (text/plain, 31 bytes)', 'mail-mixed.eml:L2| To: buyer@example.org'].join('\n');
  const files = [path.join(s.root, 'text.pptx'), path.join(s.root, 'mail-mixed.eml')];
  const r = await eyesRun({ task: 't', mode: 'extract', files }, s.ctx, { key: KEY, fetch: chat(out), ledger: new Ledger(s.stateDir), sleep: async () => {} });
  assert.equal(
    r.text,
    [
      'text.pptx:L5 (slide 2)| Table slide',
      'text.pptx:L4 (notes 1)| Speaker notes for slide one',
      'mail-mixed.eml:L32 (attachment: forwarded.eml, attachments)| inner.txt (text/plain, 31 bytes)',
      'mail-mixed.eml:L2| To: buyer@example.org',
    ].join('\n') + '\n',
  );
  const check = await readCheck(s.ctx.resultsDir, r.id);
  assert.deepEqual(check.checks.items.map((i) => [i.ref, i.status, i.place ?? null]), [
    ['text.pptx:L5 (slide 2)', 'ok', 'slide 2'],
    ['text.pptx:L4 (notes 1)', 'ok', 'notes 1'],
    ['mail-mixed.eml:L32 (attachment: forwarded.eml, attachments)', 'ok', 'attachment: forwarded.eml, attachments'],
    ['mail-mixed.eml:L2', 'ok', null],
  ]);
  assert.ok(check.checks.items.every((i) => i.page === undefined));
  // eyes_result shows the same items.
  assert.match(await eyesResult({ id: r.id, check: 'all' }, s.ctx), /"ref":"mail-mixed\.eml:L32 \(attachment: forwarded\.eml, attachments\)".*"place":"attachment: forwarded\.eml, attachments"/);
  // The sources index keeps the sections next to the page table.
  const meta = JSON.parse(fs.readFileSync(path.join(sourcesDir(s.ctx.resultsDir, r.id), '1.json'), 'utf8'));
  assert.equal(meta.page_starts, null);
  assert.deepEqual(meta.sections[0], { kind: 'slide', n: 1, label: null, start: 1, end: 3 });
});

test('grep over a deck and an FB2 book: places on matched lines, none outside sections', async () => {
  const s = setup(['text.pptx', 'text.fb2']);
  const files = [path.join(s.root, 'text.pptx'), path.join(s.root, 'text.fb2')];
  const r = await eyesRun({ mode: 'grep', files, grep: { pattern: 'Temperature|Test Author|Сноска', context: 0 } }, s.ctx, { key: null, fetch: async () => assert.fail('no network in grep mode') });
  assert.match(r.text, /\n--- slide 2 ---\nL7 \(slide 2\)\| Temperature \| −40 \| 105\n/);
  assert.match(r.text, /=== file: text\.fb2 ===\n… \(line 1 skipped\)\nL2\| Test Author\n/);
  assert.match(r.text, /\nL6 \(chapter 1\)\| Temperature \| −40 \| 105\n/);
  assert.match(r.text, /\n--- notes ---\nL13 \(notes\)\| Сноска: срок указан в проекте контракта\.\n/);
});

// ---- a ref that names an attachment instead of its file ----

// A view over one message: its lines and sections, every line carried.
async function mailView(names = ['mail-mixed.eml']) {
  const lines = {};
  const sources = new Map();
  const places = new Map();
  for (const f of names) {
    const r = await read(f);
    lines[f] = [[1, r.lines.length]];
    sources.set(f, new Map(r.lines.map((l, i) => [i, l])));
    if (r.sections.length) places.set(f, r.sections);
  }
  const chunk = { lines, span: { from: { name: names[0], n: 1 }, to: { name: names.at(-1), n: 1 } } };
  return { chunk, sources, places, singleName: names.length === 1 ? names[0] : null };
}

test('the name of an attachment resolves to the file holding it, only for lines inside it; a file wins; two files are ambiguous', () => {
  const att = (label, start, end) => ({ kind: 'attachment', n: null, label, start, end });
  const chunk = { lines: { 'a.eml': [[1, 10]], 'b.eml': [[1, 10]], 'x.pdf': [[1, 3]] } };
  const places = new Map([
    ['a.eml', [att('offer\r\n.pdf', 3, 5), att('x.pdf', 6, 8)]],
    ['b.eml', [att('same.txt', 2, 4)]],
  ]);
  const v = chunkView(chunk, new Map(), null, new Map(), places);
  assert.deepEqual(v.lookupAt('offer .pdf', 4), { name: 'a.eml', attachment: true }, 'the label as its marker shows it');
  assert.deepEqual(v.lookupAt('offer .pdf', 3, 5), { name: 'a.eml', attachment: true });
  assert.deepEqual(v.lookupAt('offer .pdf', 2), { outside: 'L2 is not inside attachment offer .pdf' });
  assert.deepEqual(v.lookupAt('offer .pdf', 4, 7), { outside: 'L7 is not inside attachment offer .pdf' });
  assert.deepEqual(v.lookupAt('x.pdf', 7), { name: 'x.pdf' }, 'a real file of that name wins');
  assert.deepEqual(v.lookupAt('nope.pdf', 4), { unknown: true });
  const two = chunkView({ lines: { 'a.eml': [[1, 10]], 'b.eml': [[1, 10]] } }, new Map(), null, new Map(), new Map([['a.eml', [att('same.txt', 2, 4)]], ['b.eml', [att('same.txt', 2, 4)]]]));
  assert.deepEqual(two.lookupAt('same.txt', 3), { ambiguous: true });
  assert.equal(two.nameProblem('same.txt', 'unknown file name', two.lookupAt('same.txt', 3)), 'ambiguous file name in ref: same.txt');
});

test('extract over one message: refs named after attachments are refs to the message, written with the place', async () => {
  const v = await mailView();
  const out = [
    'text.docx:L15| Bid security: 1 000 000 PKR. Deadline: 2026-02-17 11:00.',
    'forwarded.eml:L28| Date: Mon, 16 Feb 2026 09:30:00 +0300',
    'text.docx:L5| Subject: Заявка на поставку — фикстура',
  ].join('\n');
  const r = checkJob({ mode: 'extract', chunks: [v.chunk], sources: v.sources, pages: new Map(), places: v.places, singleName: v.singleName, spanText, outs: [{ text: out }] });
  assert.deepEqual(r.items.map((i) => [i.ref, i.file, i.status, i.reason ?? null]), [
    ['L15 (attachment: text.docx)', 'mail-mixed.eml', 'ok', null],
    ['L28 (attachment: forwarded.eml)', 'mail-mixed.eml', 'ok', null],
    ['text.docx:L5', 'text.docx', 'bad', 'L5 is not inside attachment text.docx'],
  ]);
  assert.equal(
    r.text,
    [
      'L15 (attachment: text.docx)| Bid security: 1 000 000 PKR. Deadline: 2026-02-17 11:00.',
      'L28 (attachment: forwarded.eml)| Date: Mon, 16 Feb 2026 09:30:00 +0300',
      'text.docx:L5| Subject: Заявка на поставку — фикстура',
    ].join('\n') + '\n',
  );
  const draft = checkJob({ mode: 'draft', chunks: [v.chunk], sources: v.sources, pages: new Map(), places: v.places, singleName: v.singleName, spanText, outs: [{ text: 'Security 1 000 000 PKR (text.docx:L15)' }] });
  assert.deepEqual([draft.items[0].status, draft.items[0].places], ['ok', ['attachment: text.docx']]);
});

test('extract over a message and a file of an attachment name: the file wins; message lines keep the message name', async () => {
  const v = await mailView(['mail-mixed.eml', 'text.docx']);
  const out = ['text.docx:L5| НМЦК: 3 605 044,00 руб.', 'text.docx:L15| Bid security: 1 000 000 PKR. Deadline: 2026-02-17 11:00.', 'mail-mixed.eml:L15| Bid security: 1 000 000 PKR. Deadline: 2026-02-17 11:00.'].join('\n');
  const r = checkJob({ mode: 'extract', chunks: [v.chunk], sources: v.sources, pages: new Map(), places: v.places, singleName: null, spanText, outs: [{ text: out }] });
  assert.deepEqual(r.items.map((i) => [i.ref, i.file, i.status, i.reason ?? null]), [
    ['text.docx:L5', 'text.docx', 'ok', null],
    ['text.docx:L15', 'text.docx', 'bad', "line not in this chunk's input"],
    ['mail-mixed.eml:L15 (attachment: text.docx)', 'mail-mixed.eml', 'ok', null],
  ]);
});

test('several files: a ref named after an attachment is written with the message name', async () => {
  const v = await mailView(['mail-mixed.eml', 'text.pptx']);
  const r = checkJob({ mode: 'extract', chunks: [v.chunk], sources: v.sources, pages: new Map(), places: v.places, singleName: null, spanText, outs: [{ text: 'text.docx:L15| Bid security: 1 000 000 PKR. Deadline: 2026-02-17 11:00.' }] });
  assert.deepEqual(r.items.map((i) => [i.ref, i.status]), [['mail-mixed.eml:L15 (attachment: text.docx)', 'ok']]);
  assert.equal(r.text, 'mail-mixed.eml:L15 (attachment: text.docx)| Bid security: 1 000 000 PKR. Deadline: 2026-02-17 11:00.\n');
});

test('schema and edits: a ref or file named after an attachment belongs to the message', async () => {
  const v = await mailView();
  const cv = chunkView(v.chunk, v.sources, v.singleName, new Map(), v.places);
  assert.deepEqual(checkValue({ value: 1000000, ref: 'text.docx:L15', quote: 'Bid security: 1 000 000 PKR' }, cv), { ref: 'L15 (attachment: text.docx)', place: 'attachment: text.docx', status: 'ok' });
  assert.deepEqual(checkValue({ value: 'x', ref: 'text.docx:L5', quote: 'x' }, cv), { status: 'bad_ref', note: 'L5 is not inside attachment text.docx' });
  const ed = checkJob({ mode: 'edits', chunks: [v.chunk], sources: v.sources, pages: new Map(), places: v.places, singleName: v.singleName, spanText, outs: [{ text: '{"file":"text.docx","line":15,"old":"PKR","new":"USD","why":"w"}' }] });
  assert.deepEqual([ed.valid.length, ed.valid[0].file, ed.valid[0].place], [1, 'mail-mixed.eml', 'attachment: text.docx']);
  assert.equal(ed.text, '{"file":"mail-mixed.eml","line":15,"old":"PKR","new":"USD","why":"w"}\n');
});

test('end to end: a stubbed model cites attachments by name in a one-message job', async () => {
  const s = setup(['mail-mixed.eml']);
  const out = ['text.docx:L15| Bid security: 1 000 000 PKR. Deadline: 2026-02-17 11:00.', 'forwarded.eml:L28| Date: Mon, 16 Feb 2026 09:30:00 +0300'].join('\n');
  const r = await eyesRun({ task: 't', mode: 'extract', files: [path.join(s.root, 'mail-mixed.eml')] }, s.ctx, { key: KEY, fetch: chat(out), ledger: new Ledger(s.stateDir), sleep: async () => {} });
  assert.equal(r.text, 'L15 (attachment: text.docx)| Bid security: 1 000 000 PKR. Deadline: 2026-02-17 11:00.\nL28 (attachment: forwarded.eml)| Date: Mon, 16 Feb 2026 09:30:00 +0300\n');
  const check = await readCheck(s.ctx.resultsDir, r.id);
  assert.deepEqual(check.checks.items.map((i) => [i.ref, i.status, i.place]), [
    ['L15 (attachment: text.docx)', 'ok', 'attachment: text.docx'],
    ['L28 (attachment: forwarded.eml)', 'ok', 'attachment: forwarded.eml'],
  ]);
});