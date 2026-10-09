// Mode schema: parser (every shape of schema-shapes.json as is), limits, JSON repair,
// per-field checks on crafted answers, merge of chunks with conflicts, end to end on
// a mocked fetch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { Ledger } from '../src/budget.js';
import { chunkView } from '../src/checks.js';
import { parseConfig } from '../src/config.js';
import { clearCatalogCache } from '../src/openrouter.js';
import { systemPrompt } from '../src/prompts.js';
import { eyesResult } from '../src/result-tool.js';
import { readCheck } from '../src/results.js';
import { eyesRun } from '../src/run.js';
import { checkSchemaJob, checkValue, MAX_LEAVES, missingTokens, normValue, numberReadings, parseAnswer, parseNumberish, parseSchema, schemaTask } from '../src/schema.js';
import { tmpDir } from './helpers.js';

const SHAPES = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'schema', 'schema-shapes.json'), 'utf8')).schemas;
const KEY = 'sk-' + 'or-v1-FAKE0000000000000000000000000000000000000000000000000000'; // fake, scan-secrets:allow
const ZDR = [{ model_id: 'v/a', provider_name: 'P', context_length: 200000, max_completion_tokens: null, pricing: { prompt: '0.0000002', completion: '0.0000004', request: '0' } }];

beforeEach(() => clearCatalogCache());

// ---- the schema ----

test('every entry of schema-shapes.json is accepted as is, every leaf with its type hint', () => {
  assert.equal(Object.keys(SHAPES).length, 13);
  for (const [name, shape] of Object.entries(SHAPES)) {
    for (const input of [shape, JSON.stringify(shape)]) {
      const s = parseSchema(input);
      assert.ok(s.leaves > 0 && s.leaves <= MAX_LEAVES, name);
      const types = [];
      const walk = (n) => (n.kind === 'leaf' ? types.push(n.type) : n.kind === 'object' ? n.fields.forEach(([, c]) => walk(c)) : walk(n.item));
      walk(s.tree);
      assert.equal(types.length, s.leaves);
      assert.ok(types.every((t) => t !== null), `${name}: a leaf without a type`);
      assert.ok(schemaTask(s, 'dates as YYYY-MM-DD').startsWith(`Fill this schema from the input:\n${JSON.stringify(shape)}\nInstructions: dates as YYYY-MM-DD`));
    }
  }
  const leaf = (t) => parseSchema({ a: t }).tree.fields[0][1];
  assert.deepEqual(leaf('number — maximum price, RUB'), { kind: 'leaf', type: 'number', desc: 'maximum price, RUB' });
  assert.deepEqual(leaf('date'), { kind: 'leaf', type: 'date', desc: '' });
  assert.deepEqual(leaf('stringent limits that apply'), { kind: 'leaf', type: null, desc: 'stringent limits that apply' });
});

test('schema limits: 60 leaves, depth 4, one-item lists, descriptions only', () => {
  const many = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, 'string']));
  assert.equal(parseSchema(many(60)).leaves, 60);
  assert.throws(() => parseSchema(many(61)), /more than 60 fields/);
  assert.equal(parseSchema({ a: [{ b: ['string'] }] }).leaves, 1, 'a[] .b [] = depth 4');
  assert.throws(() => parseSchema({ a: { b: { c: { d: { e: 'string' } } } } }), /deeper than 4 levels at a\.b\.c\.d\.e/);
  assert.throws(() => parseSchema({ a: ['string', 'number'] }), /exactly one item template at a \(got 2\)/);
  assert.throws(() => parseSchema({ a: [] }), /exactly one item template/);
  assert.throws(() => parseSchema({ a: 5 }), /a description string, an object or a one-item list at a \(got number\)/);
  assert.throws(() => parseSchema({ a: '  ' }), /empty description at a/);
  assert.throws(() => parseSchema({}), /empty object/);
  assert.throws(() => parseSchema('["string"]'), /must be a JSON object/);
  assert.throws(() => parseSchema('{"a": '), /schema: not valid JSON/);
});

// ---- the answer ----

test('JSON answer: a ``` wrapper is stripped; one repair (outer braces, trailing commas); otherwise null', () => {
  assert.deepEqual(parseAnswer('```json\n{"a": 1}\n```'), { value: { a: 1 }, repaired: false });
  assert.deepEqual(parseAnswer('Here you go:\n{"a": {"b": [1, 2,],},}\nThanks'), { value: { a: { b: [1, 2] } }, repaired: true });
  assert.equal(parseAnswer('{"a": 1'), null);
  assert.equal(parseAnswer('[1, 2]'), null);
});

test('numbers are compared after separators: spaces, commas, dots, minus sign', () => {
  const cases = [
    ['3 605 044,00', 3605044], ['1 500,50', 1500.5], ['1 000 000', 1000000], ['12,345,678', 12345678], ['1,000,000', 1000000], ['1.000.000', 1000000],
    ['1,5', 1.5], ['3.6', 3.6], ['−40', -40], ['1,234.56', 1234.56], ['1.234,56', 1234.56], [42, 42],
    // A leading 0 group is always a decimal fraction.
    ['0,500', 0.5], ['0.500', 0.5],
    // Several equal separators that are not thousands groups: not a number, compared as text.
    ['1.2.3', null], ['203.0.113.9', null], ['02.10.2026', null], ['1,23,456', null], ['1 23', null],
    ['42 days', null], ['', null],
  ];
  for (const [s, n] of cases) assert.equal(parseNumberish(s), n, String(s));
  // One separator with exactly 3 digits after a 1–3 digit group: one reading for comparing
  // answers, both readings on the quote side.
  assert.deepEqual(numberReadings('1,500'), [1500, 1.5]);
  assert.deepEqual(numberReadings('12.500'), [12.5, 12500]);
  assert.deepEqual(numberReadings('1234,500'), [1234.5]);
  assert.deepEqual(missingTokens(12.5, 'Margin 12,500 percent'), []);
  assert.deepEqual(missingTokens(12500, 'Fee 12.500 EUR'), []);
  assert.deepEqual(missingTokens(12.4, 'Margin 12,500 percent'), ['12.4']);
  // Versions, IPs and dates are text: no false match through digit gluing.
  assert.equal(normValue('1.2.3') === normValue('123'), false);
  assert.equal(normValue('203.0.113.9'), '203.0.113.9');
  assert.deepEqual(missingTokens(2030113, 'host 203.0.113.9'), ['2030113']);
});

// A view over one chunk of a.md, lines 1–6, page 2 from line 5.
function view(lines, { range = [1, lines.length], name = 'a.md', pages = new Map([['a.md', [1, 5]]]) } = {}) {
  const src = new Map(lines.map((l, i) => [i, l]));
  return chunkView({ lines: { [name]: [range] } }, new Map([[name, src]]), name, pages);
}

const LINES = [
  'Bid security: 1 000 000 PKR. Deadline: 2026-02-17 11:00.',
  'НМЦК: 3 605 044,00 руб.',
  'Срок исполнения контракта — 27 ноября 2026 года.',
  'Мы плани­руем поставку',
  'Version 2.4.1 released',
  'Temperature −40 105',
];

test('field checks: ok, ok~ (NBSP, soft hyphen), quote mismatch with the real line, bad ref, value not in quote', () => {
  const v = view(LINES);
  const st = (x) => checkValue(x, v);
  assert.deepEqual(st({ value: 1000000, ref: 'L1', quote: 'Bid security: 1 000 000 PKR' }), { ref: 'L1 (p.1)', page: 1, place: 'p.1', status: 'ok' });
  assert.equal(st({ value: 3605044, ref: 'L2', quote: 'НМЦК: 3 605 044,00 руб.' }).status, 'ok~');
  assert.equal(st({ value: 'планируем', ref: 'L4', quote: 'Мы планируем' }).status, 'ok~');
  assert.equal(st({ value: -40, ref: 'L6', quote: '−40' }).status, 'ok');
  assert.deepEqual(st({ value: 3605045, ref: 'L2', quote: '3 605 044,00' }), { ref: 'L2 (p.1)', page: 1, place: 'p.1', status: 'value_not_in_quote', note: 'not in quote: 3605045' });
  assert.equal(st({ value: '2026-11-27', ref: 'L3', quote: '27 ноября 2026 года' }).status, 'value_not_in_quote', 'a reformatted date: the known false positive');
  assert.deepEqual(st({ value: '2.4.1', ref: 'L1', quote: 'Version 2.4.1' }), { ref: 'L1 (p.1)', page: 1, place: 'p.1', status: 'quote_mismatch', note: 'quote found at a.md:L5' });
  assert.equal(st({ value: 'x', ref: 'L1', quote: 'nowhere at all' }).note, 'quote not in the cited lines');
  assert.equal(st({ value: 'x', ref: 'L1', quote: '' }).note, 'no quote');
  assert.deepEqual(st({ value: 'x', ref: 'L9', quote: 'x' }), { status: 'bad_ref', note: "ref outside this chunk's input: L9" });
  assert.equal(st({ value: 'x', ref: 'b.md:L1', quote: 'x' }).note, 'unknown file in ref: b.md');
  assert.equal(st({ value: 'x', ref: 'line one', quote: 'x' }).note, 'unreadable ref: line one');
  assert.equal(st({ value: 'x', ref: null, quote: 'x' }).note, 'no ref');
  // A range: the quote may run across the cited lines; the page of its first line.
  assert.deepEqual(st({ value: 'Version 2.4.1', ref: 'L4-L5', quote: 'поставку Version 2.4.1' }), { ref: 'L4-L5 (p.1)', page: 1, place: 'p.1', status: 'ok' });
  assert.equal(st({ value: 'Version 2.4.1', ref: 'L4-L5', quote: 'планируем поставку Version 2.4.1' }).status, 'ok~');
  assert.equal(st({ value: '2.4.1', ref: 'a.md:L5', quote: '2.4.1' }).ref, 'L5 (p.2)');
});

test('a quote starting with the line prefix of a cited line is checked without it (ok~); another line\'s prefix is not stripped', () => {
  const lines = Array.from({ length: 14 }, (_, i) => `line ${i + 1} filler`);
  lines[11] = '1. | 58.29.11.000-00000003 | Программное обеспечение | шт. | 1 | 36 122,50';
  lines[12] = 'Итого: 3 605 044,00';
  const full = 'raw/set/1. Обоснование НМЦК.docx';
  const src = new Map(lines.map((l, i) => [i, l]));
  const v = chunkView({ lines: { [full]: [[1, 14]], 'raw/set/2. Проект ГК.doc': [[1, 1]] } }, new Map([[full, src], ['raw/set/2. Проект ГК.doc', new Map([[0, 'x']])]]), null, new Map([[full, [1, 5, 10]]]));
  const st = (quote, ref = `${full}:L12`, value = 36122.5) => checkValue({ value, ref, quote }, v);
  const row = lines[11];
  assert.equal(st(row).status, 'ok', 'no prefix: unchanged');
  assert.equal(st(`L12| ${row}`).status, 'ok~');
  assert.equal(st(`L12|${row}`).status, 'ok~', 'space after "|" optional');
  assert.equal(st(`L12 (p.3)| ${row}`).status, 'ok~');
  assert.equal(st(`${full}:L12| ${row}`).status, 'ok~', 'full name');
  assert.equal(st(`1. Обоснование НМЦК.docx:L12| ${row}`).status, 'ok~', 'short name, resolved like refs');
  assert.equal(st(`2. Проект ГК.doc:L12| ${row}`).status, 'quote_mismatch', 'a prefix naming another file');
  assert.deepEqual(st(`L13| ${row}`), { ref: `${full}:L12 (p.3)`, page: 3, place: 'p.3', status: 'quote_mismatch', note: 'quote not in the cited lines' });
  assert.equal(st(`L12| ${row}\nL13| Итого: 3 605 044,00`, `${full}:L12-L13`, 3605044).status, 'ok~', 'a prefix on each line of the quote');
  assert.equal(st(`L12| ${row}\nL14| line 14 filler`, `${full}:L12-L13`).status, 'quote_mismatch', 'L14 is outside the cited range');
  assert.equal(st('L12| ').status, 'quote_mismatch', 'nothing but a prefix');
  assert.equal(st(`L12| ${row}`, `${full}:L12`, 12).status, 'value_not_in_quote', 'the prefix number does not count as a value');
});

test('the placeholder rule is in the schema prompt only', () => {
  assert.match(systemPrompt('schema'), /An unfilled template placeholder is not a value: .*\[insert …\].*XX\.XX\.XXXX\) gives \{"value": null, "reason": "NOT IN INPUT"\}\. When the text holds a real value next to a blank, the real value is the answer\.$/);
  for (const mode of ['extract', 'draft', 'edits']) assert.ok(!systemPrompt(mode).includes('placeholder'), mode);
});

// ---- merge ----

const SCHEMA = parseSchema({ amount: 'number', currency: 'string', deadline: 'date', missing: 'string', items: [{ name: 'string', qty: 'number' }] });
const DOC = ['Bid security: 1 000 000 PKR', 'Item A, qty 2', 'Deadline 2026-02-17', 'note', 'Item B, qty 3', 'other', 'note 2', 'Security raised to 1 500 000 PKR', 'Item C, qty 7', 'end'];
const leaf = (value, ref, quote) => ({ value, ref, quote });

test('merge: first non-null wins, different values → conflict, lists concatenated without duplicates, nulls, failed chunks', () => {
  const v1 = view(DOC, { range: [1, 6], pages: new Map() });
  const v2 = view(DOC, { range: [4, 10], pages: new Map() });
  const out1 = {
    amount: leaf(1000000, 'L1', '1 000 000'),
    currency: { value: null, reason: 'NOT IN INPUT' },
    deadline: leaf('2026-02-17', 'L3', '2026-02-17'),
    missing: { value: null, reason: 'NOT IN INPUT' },
    items: [
      { name: leaf('A', 'L2', 'Item A'), qty: leaf(2, 'L2', 'qty 2') },
      { name: leaf('B', 'L5', 'Item B'), qty: leaf(3, 'L5', 'qty 3') },
    ],
  };
  const out2 = {
    amount: leaf('1 500 000', 'L8', '1 500 000'),
    currency: leaf('PKR', 'L8', 'PKR'),
    deadline: { value: null, reason: 'NOT IN INPUT' },
    missing: { value: null, reason: 'NOT IN INPUT' },
    items: [
      { name: leaf('B', 'L5', 'Item B'), qty: leaf('3', 'L5', 'qty 3') },
      { name: leaf('C', 'L9', 'Item C'), qty: leaf(7, 'L9', 'qty 7') },
    ],
  };
  const r = checkSchemaJob({ schema: SCHEMA, outs: [{ text: JSON.stringify(out1) }, { text: '```json\n' + JSON.stringify(out2) + '\n```' }, { text: 'sorry, no JSON' }], views: [v1, v2, v2] });
  const merged = JSON.parse(r.text.replace(/^```json\n|\n```\n$/g, ''));
  assert.deepEqual(merged.amount, { value: [1000000, '1 500 000'], conflict: true, refs: ['L1', 'L8'], quotes: ['1 000 000', '1 500 000'] });
  assert.deepEqual(merged.currency, { value: 'PKR', ref: 'L8', quote: 'PKR' });
  assert.deepEqual(merged.deadline, { value: '2026-02-17', ref: 'L3', quote: '2026-02-17' });
  assert.deepEqual(merged.missing, { value: null, reason: 'NOT IN INPUT' });
  assert.deepEqual(merged.items.map((i) => i.name.value), ['A', 'B', 'C'], 'B from the overlap once ("3" and 3 are the same)');
  assert.equal(r.summary.conflict, 1);
  assert.equal(r.summary.null, 1);
  assert.equal(r.summary.failed_chunks, 1);
  assert.deepEqual(r.items[0], { chunk: 3, status: 'failed', reason: 'answer is not a JSON object (after one repair attempt)', text: 'sorry, no JSON' });
  const amount = r.items.filter((i) => i.path === 'amount');
  assert.deepEqual(amount.map((i) => [i.status, i.chunk ?? null, i.conflict ?? false]), [['conflict', null, false], ['ok', 1, true], ['ok', 2, true]]);
  assert.ok(r.items.filter((i) => i.status === 'ok').every((i) => i.quote === undefined), 'ok items carry no echoed quote');
  assert.deepEqual(r.items.find((i) => i.path === 'items[2].qty'), { path: 'items[2].qty', status: 'ok', chunk: 2, ref: 'L9', value: '7' });
});

test('merge: equal values after normalisation are no conflict; a conflict from the model passes through, each value checked', () => {
  const v = view(DOC, { pages: new Map() });
  const schema = parseSchema({ amount: 'number' });
  const same = checkSchemaJob({ schema, outs: [{ text: '{"amount": {"value": 1000000, "ref": "L1", "quote": "1 000 000"}}' }, { text: '{"amount": {"value": " 1 000 000 ", "ref": "L1", "quote": "1 000 000"}}' }], views: [v, v] });
  assert.equal(same.summary.conflict, 0);
  const model = checkSchemaJob({
    schema,
    outs: [{ text: '{"amount": {"value": [1000000, 1500000], "conflict": true, "refs": ["L1", "L4"], "quotes": ["1 000 000", "1 500 000"]}}' }],
    views: [v],
  });
  assert.deepEqual(model.items.map((i) => [i.status, i.ref ?? null]), [['conflict', null], ['ok', 'L1'], ['quote_mismatch', 'L4']]);
  assert.equal(model.items[2].note, 'quote found at a.md:L8');
});

// ---- end to end ----

function setup() {
  const d = tmpDir();
  const root = path.join(d, 'docs');
  fs.mkdirSync(root, { recursive: true });
  const config = parseConfig({ read_roots: [root], models: { fast: { ids: ['v/a'] } }, defaults: { extract: 'fast' } });
  const stateDir = path.join(d, 'state');
  return { root, config, stateDir, ctx: { config, stateDir: { path: stateDir }, resultsDir: path.join(stateDir, 'results') } };
}

test('end to end: schema in the task, merged JSON as the result, field summary in the header, a source copy', async () => {
  const s = setup();
  const f = path.join(s.root, 'tender.md');
  fs.writeFileSync(f, DOC.join('\n') + '\n');
  const bodies = [];
  const answer = {
    amount: leaf(1000000, 'L1', 'Bid security: 1 000 000 PKR'),
    currency: leaf('PKR', 'L1', 'PKR'),
    deadline: leaf('2026-02-17', 'L4', 'Deadline 2026-02-17'),
    missing: { value: null, reason: 'NOT IN INPUT' },
    items: [{ name: leaf('A', 'L2', 'Item A'), qty: leaf(2, 'L2', 'qty 2') }],
  };
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/endpoints/zdr')) return json({ data: ZDR });
    if (!u.endsWith('/chat/completions')) throw new Error(`unexpected ${u}`);
    bodies.push(JSON.parse(init.body));
    return json({ id: 'g', model: 'v/a', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0002 } });
  };
  const schema = { amount: 'number — bid security', currency: 'string', deadline: 'date', missing: 'string', items: [{ name: 'string', qty: 'number' }] };
  const r = await eyesRun({ mode: 'schema', schema: JSON.stringify(schema), task: 'amounts in PKR', files: [f] }, s.ctx, { key: KEY, fetch, ledger: new Ledger(s.stateDir), sleep: async () => {} });
  const user = bodies[0].messages[1].content;
  assert.match(user, /\nTask: Fill this schema from the input:\n\{"amount":"number — bid security",/);
  assert.match(user, /\nInstructions: amounts in PKR$/);
  assert.match(bodies[0].messages[0].content, /Mode: schema\./);
  assert.ok(bodies[0].messages[0].content.endsWith('\nNever fill a field from outside knowledge.\nAn unfilled template placeholder is not a value: text that is only a fill-in instruction or a blank ([insert …], [указать …], <…>, ____, «___», № _____ от _____, XX.XX.XXXX) gives {"value": null, "reason": "NOT IN INPUT"}. When the text holds a real value next to a blank, the real value is the answer.'), 'the placeholder rule closes the schema prompt');
  assert.equal(bodies[0].max_completion_tokens, 8000);
  assert.match(r.header, /\ncheck \(schema\): fields ok 4 \/ mismatch 1 \/ null 1 \/ conflict 0; bad ref 0, value not in quote 0\n/);
  assert.match(r.text, /^```json\n\{\n  "amount": \{\n    "value": 1000000,/);
  const check = await readCheck(s.ctx.resultsDir, r.id);
  const byPath = Object.fromEntries(check.checks.items.map((i) => [i.path, i.status]));
  assert.deepEqual(byPath, { amount: 'ok', currency: 'ok', deadline: 'quote_mismatch', missing: 'null', 'items[0].name': 'ok', 'items[0].qty': 'ok' });
  assert.match(r.header, /\n  deadline L4 \[quote_mismatch\] quote found at tender\.md:L3\n/);
  // check: true lists problems and nulls, not ok fields; the source copy is kept for schema jobs.
  const view = await eyesResult({ id: r.id, check: true }, s.ctx);
  assert.match(view, /items not ok .* 1–2 of 2; end/);
  assert.ok(fs.existsSync(path.join(s.ctx.resultsDir, `${r.id}.sources`, 'index.json')));
  const rec = JSON.parse(fs.readFileSync(path.join(s.stateDir, 'usage.jsonl'), 'utf8'));
  assert.equal(rec.check.mode, 'schema');
  assert.equal(rec.alias, 'fast', 'schema falls back to the extract default');
});

test('schema: refused before any network call when the schema is missing or invalid', async () => {
  const s = setup();
  const f = path.join(s.root, 'a.md');
  fs.writeFileSync(f, 'x\n');
  const deps = { key: KEY, fetch: async () => assert.fail('network'), ledger: new Ledger(s.stateDir) };
  await assert.rejects(eyesRun({ mode: 'schema', files: [f] }, s.ctx, deps), /mode schema needs "schema"/);
  await assert.rejects(eyesRun({ mode: 'schema', files: [f], schema: { a: { b: { c: { d: { e: 'x' } } } } } }, s.ctx, deps), /deeper than 4 levels/);
  await assert.rejects(eyesRun({ mode: 'extract', task: 't', files: [f], schema: { a: 'x' } }, s.ctx, deps), /"schema" is used only with mode schema/);
});

// ---- merge: equal after normalisation, equal rows on different lines ----

const PLACES = ['Место: г. Анадырь', 'Место: г. Анадырь.', 'Поставщик: «Ромашка»', 'Поставщик: "Ромашка"', 'Ставка 5 %', 'Ставка 10 %', 'Город Магадан', 'Сумма 1 098,00'];

test('merge: values that differ only by trailing punctuation or quotes are one plain value with every ref', () => {
  const v = view(PLACES, { pages: new Map() });
  const schema = parseSchema({ place: 'string', supplier: 'string', total: 'number' });
  const r = checkSchemaJob({
    schema,
    outs: [
      { text: JSON.stringify({ place: leaf('г. Анадырь', 'L1', 'г. Анадырь'), supplier: leaf('«Ромашка»', 'L3', '«Ромашка»'), total: leaf('1 098,00', 'L8', '1 098,00') }) },
      { text: JSON.stringify({ place: leaf('г. Анадырь.', 'L2', 'г. Анадырь.'), supplier: leaf('"Ромашка"', 'L4', '"Ромашка"'), total: leaf(1098, 'L8', '1 098,00') }) },
    ],
    views: [v, v],
  });
  const merged = JSON.parse(r.text.replace(/^```json\n|\n```\n$/g, ''));
  assert.deepEqual(merged.place, { value: 'г. Анадырь', ref: 'L1', quote: 'г. Анадырь', refs: ['L1', 'L2'], quotes: ['г. Анадырь', 'г. Анадырь.'] });
  assert.deepEqual(merged.supplier, { value: '«Ромашка»', ref: 'L3', quote: '«Ромашка»', refs: ['L3', 'L4'], quotes: ['«Ромашка»', '"Ромашка"'] });
  assert.deepEqual(merged.total.value, '1 098,00', 'numbers still compare as numbers');
  assert.equal(r.summary.conflict, 0);
  assert.deepEqual(r.items.filter((i) => i.path === 'place').map((i) => [i.status, i.ref, i.conflict ?? false]), [['ok', 'L1', false], ['ok', 'L2', false]]);
});

test('merge: a conflict reported by the model whose values are all equal after normalisation is a plain value', () => {
  const v = view(PLACES, { pages: new Map() });
  const r = checkSchemaJob({
    schema: parseSchema({ place: 'string' }),
    outs: [{ text: JSON.stringify({ place: { value: ['г. Анадырь', 'г. Анадырь.'], conflict: true, refs: ['L1', 'L2'], quotes: ['г. Анадырь', 'г. Анадырь.'] } }) }],
    views: [v],
  });
  const merged = JSON.parse(r.text.replace(/^```json\n|\n```\n$/g, ''));
  assert.deepEqual(merged.place, { value: 'г. Анадырь', ref: 'L1', quote: 'г. Анадырь', refs: ['L1', 'L2'], quotes: ['г. Анадырь', 'г. Анадырь.'] });
  assert.equal(r.summary.conflict, 0);
});

test('merge: real conflicts stay conflicts', () => {
  const v = view(PLACES, { pages: new Map() });
  const r = checkSchemaJob({
    schema: parseSchema({ rate: 'string', city: 'string' }),
    outs: [
      { text: JSON.stringify({ rate: leaf('5 %', 'L5', '5 %'), city: leaf('Анадырь', 'L1', 'Анадырь') }) },
      { text: JSON.stringify({ rate: leaf('10 %', 'L6', '10 %'), city: { value: ['Анадырь', 'Магадан'], conflict: true, refs: ['L2', 'L7'], quotes: ['Анадырь', 'Магадан'] } }) },
    ],
    views: [v, v],
  });
  const merged = JSON.parse(r.text.replace(/^```json\n|\n```\n$/g, ''));
  assert.deepEqual(merged.rate, { value: ['5 %', '10 %'], conflict: true, refs: ['L5', 'L6'], quotes: ['5 %', '10 %'] });
  assert.deepEqual(merged.city, { value: ['Анадырь', 'Магадан'], conflict: true, refs: ['L1', 'L7'], quotes: ['Анадырь', 'Магадан'] });
  assert.equal(r.summary.conflict, 2);
  // Every entry is still checked, the second Анадырь (L2) included.
  assert.deepEqual(r.items.filter((i) => i.path === 'city').map((i) => [i.status, i.ref ?? null]), [['conflict', null], ['ok', 'L1'], ['ok', 'L2'], ['ok', 'L7']]);
});

const ROWS = ['Позиция | Ед. | Кол-во | Сумма', 'Компакт-диск | шт. | 1 | 1 098,00', 'Компакт-диск | шт. | 1 | 1 098,00', 'Компакт-диск | шт. | 1 | 1 098,00', 'Итого'];
const row = (n) => ({ name: leaf('Компакт-диск', `L${n}`, 'Компакт-диск'), total: leaf(1098, `L${n}`, '1 098,00') });

test('arrays: equal rows on different lines stay separate; the same row read twice (same refs) is one item', () => {
  const schema = parseSchema({ items: [{ name: 'string', total: 'number' }] });
  const a = view(ROWS, { range: [1, 3], pages: new Map() });
  const b = view(ROWS, { range: [2, 5], pages: new Map() });
  // Chunk 1 sees rows on L2 and L3; chunk 2 (overlap from L2) sees L2, L3 and L4.
  const r = checkSchemaJob({ schema, outs: [{ text: JSON.stringify({ items: [row(2), row(3)] }) }, { text: JSON.stringify({ items: [row(2), row(3), row(4)] }) }], views: [a, b] });
  const merged = JSON.parse(r.text.replace(/^```json\n|\n```\n$/g, ''));
  assert.deepEqual(merged.items.map((i) => i.name.ref), ['L2', 'L3', 'L4']);
  assert.equal(merged.items.reduce((s, i) => s + i.total.value, 0), 3 * 1098);
  // Within one answer too.
  const one = checkSchemaJob({ schema, outs: [{ text: JSON.stringify({ items: [row(2), row(3), row(4)] }) }], views: [view(ROWS, { pages: new Map() })] });
  assert.equal(JSON.parse(one.text.replace(/^```json\n|\n```\n$/g, '')).items.length, 3);
});

test('arrays: items with no refs (every leaf null) compare by values only, so equal ones are one item', () => {
  const schema = parseSchema({ items: [{ name: 'string', total: 'number' }] });
  const empty = { name: { value: null, reason: 'NOT IN INPUT' }, total: { value: null, reason: 'NOT IN INPUT' } };
  const r = checkSchemaJob({ schema, outs: [{ text: JSON.stringify({ items: [empty, empty] }) }], views: [view(ROWS, { pages: new Map() })] });
  assert.equal(JSON.parse(r.text.replace(/^```json\n|\n```\n$/g, '')).items.length, 1);
});
