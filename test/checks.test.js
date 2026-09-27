import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDraftChunk, checkEditsChunk, checkExtractChunk, checkJob, chunkView, hardTokens, parseRefs, stripFence } from '../src/checks.js';
import { spanText } from '../src/run.js';

// Source: file "a.md" lines 1..60 (masked text), chunk carries lines 1–10 and 20–22.
function source(name, n, fn = (i) => `line ${i} text`) {
  return [name, new Map(Array.from({ length: n }, (_, i) => [i, fn(i + 1)]))];
}
const SRC = new Map([
  source('a.md', 60, (i) =>
    ({
      1: 'Router notes',
      2: 'uplink 192.0.2.1 via ether1',
      3: 'password: [token]',
      4: 'version 7.15.2 installed on 2026-09-01 at 14:30',
      5: 'host nas.example.com:5001 serves /media/vault/docs',
      6: 'entity sensor.living_room_temp reads 21',
      7: '  indented    spaced   line',
      8: 'retry=3 timeout=30',
      9: 'name = "alpha" and name = "alpha"',
    })[i] ?? `line ${i} text`,
  ),
  source('b.md', 10),
]);
const CHUNK = { lines: { 'a.md': [[1, 10], [20, 22]] } };
const single = () => chunkView(CHUNK, SRC, 'a.md');
const multi = () => chunkView({ lines: { 'a.md': [[1, 10]], 'b.md': [[1, 5]] } }, SRC, null);

// ---- extract ----

test('extract: ok, ok~ (whitespace), partial (prefix …), bad (invented), NOT IN INPUT', () => {
  const out = ['L1| Router notes', 'L7| indented spaced line', 'L2| uplink 192.0.2.1 …', 'L4| version 9.9.9 installed', 'NOT IN INPUT'].join('\n');
  const items = checkExtractChunk(out, single(), 1);
  assert.deepEqual(items.map((i) => i.status), ['ok', 'ok~', 'partial', 'bad', 'not_in_input']);
  assert.match(items[3].reason, /text differs/);
});

test('extract: a line that exists in the file but was not in this chunk is bad', () => {
  const items = checkExtractChunk('L15| line 15 text\nL21| line 21 text', single(), 1);
  assert.deepEqual(items.map((i) => [i.status, i.reason ?? null]), [
    ['bad', "line not in this chunk's input"],
    ['ok', null],
  ]);
});

test('extract: a ``` wrapper is stripped; non-quote lines are bad', () => {
  const items = checkExtractChunk('```\nL1| Router notes\nHere is what I found:\n```', single(), 1);
  assert.deepEqual(items.map((i) => i.status), ['ok', 'bad']);
  assert.deepEqual(stripFence('```text\nx\n```'), ['x']);
});

test('extract: several files need "name:L" refs', () => {
  const items = checkExtractChunk('b.md:L2| line 2 text\nL2| line 2 text\nc.md:L1| x', multi(), 1);
  assert.deepEqual(items.map((i) => [i.status, i.reason ?? null]), [
    ['ok', null],
    ['bad', 'file name missing (several files)'],
    ['bad', 'unknown file name'],
  ]);
});

test('extract: masked source text compares as masked', () => {
  const [it] = checkExtractChunk('L3| password: [token]', single(), 1);
  assert.equal(it.status, 'ok');
});

test('extract job: overlap duplicates dropped by (file, line); result text rebuilt', () => {
  const chunks = [{ lines: { 'a.md': [[1, 10]] }, span: { from: { name: 'a.md', n: 1 }, to: { name: 'a.md', n: 10 } } }, { lines: { 'a.md': [[6, 15]] }, span: { from: { name: 'a.md', n: 6 }, to: { name: 'a.md', n: 15 } } }];
  const outs = [{ text: 'L1| Router notes\nL8| retry=3 timeout=30' }, { text: 'L8| retry=3 timeout=30\nL12| line 12 text' }];
  const r = checkJob({ mode: 'extract', chunks, outs, sources: SRC, singleName: 'a.md', spanText });
  assert.equal(r.text, 'L1| Router notes\nL8| retry=3 timeout=30\nL12| line 12 text\n');
  assert.equal(r.summary.ok, 3);
  assert.equal(r.summary.refs_bad, 0);
  assert.equal(r.summary.pass_rate, 1);
  assert.deepEqual(r.items.map((i) => i.result_line), [1, 2, 3]);
});

// ---- draft ----

test('parseRefs: single, range, several files, en dash; the rest of the line', () => {
  const r = parseRefs('Uplink is 192.0.2.1 (L2) and more (a.md:L5, b.md:L7–L9) end');
  assert.deepEqual(r.refs.map((x) => [x.name, x.from, x.to]), [
    [null, 2, 2],
    ['a.md', 5, 5],
    ['b.md', 7, 9],
  ]);
  assert.equal(r.rest, 'Uplink is 192.0.2.1  and more  end');
  assert.equal(parseRefs('a note (see below)').refs.length, 0);
});

test('hardTokens: IPs, host:port, versions, paths, entity ids, backticks, dates, times; bare numbers', () => {
  const { tokens, numbers } = hardTokens('At 14:30 on 2026-09-01 host nas.example.com:5001 at 192.0.2.1 runs 7.15.2 in /media/vault/docs, `retry=3`, sensor.living_room_temp, 2001:db8::1 and 42 things');
  const kinds = Object.fromEntries(tokens.map((t) => [t.value, t.kind]));
  assert.equal(kinds['14:30'], 'time');
  assert.equal(kinds['2026-09-01'], 'date');
  assert.equal(kinds['nas.example.com:5001'], 'host_port');
  assert.equal(kinds['192.0.2.1'], 'ipv4');
  assert.equal(kinds['7.15.2'], 'version');
  assert.equal(kinds['/media/vault/docs'], 'path');
  assert.equal(kinds['retry=3'], 'backtick');
  assert.equal(kinds['sensor.living_room_temp'], 'entity');
  assert.equal(kinds['2001:db8::1'], 'ipv6');
  assert.deepEqual(numbers, ['42']);
});

test('draft: ok line; no ref; ref outside the chunk; wide ref; token and number checks', () => {
  const out = [
    '# Findings',
    '',
    '- Uplink is 192.0.2.1 via ether1 (L2)',
    '- The router has notes',
    '- Something at line 15 (L15)',
    '- Everything (L1-L40)',
    '- Uplink is 192.0.2.99 (L2)',
    '- Version 7.15.2 installed 2026-09-01 at 14:30 (L4)',
    '- Retries 50 times (L8)',
    '- NAS at nas.example.com:5001 with docs in /media/vault/docs (L5)',
    '```',
    'NOT IN INPUT',
  ].join('\n');
  const items = checkDraftChunk(out, single(), 1);
  const by = Object.fromEntries(items.map((i) => [i.out_line, i]));
  assert.equal(by[1], undefined, 'heading exempt');
  assert.equal(by[3].status, 'ok');
  assert.deepEqual(by[4].issues, ['no ref']);
  assert.match(by[5].issues[0], /ref outside this chunk's input: L15/);
  assert.match(by[6].issues.join(), /ref outside/, 'L40 is not in the chunk');
  assert.match(by[7].issues[0], /token not in cited lines: 192\.0\.2\.99/);
  assert.equal(by[8].status, 'ok');
  assert.equal(by[9].status, 'flag');
  assert.match(by[9].issues[0], /number not in cited lines: 50/);
  assert.equal(by[10].status, 'ok');
  assert.equal(by[11], undefined, 'fence exempt');
  assert.equal(by[12].status, 'not_in_input');
});

test('draft: a ref range wider than 30 lines is flagged', () => {
  const view = chunkView({ lines: { 'a.md': [[1, 60]] } }, SRC, 'a.md');
  const [it] = checkDraftChunk('- lots of lines (L1-L40)', view, 1);
  assert.equal(it.status, 'flag');
  assert.match(it.issues[0], /wide ref: L1-L40/);
});

test('draft: several files; refs must name a file in this chunk', () => {
  const items = checkDraftChunk('- a (a.md:L1)\n- b (b.md:L2)\n- c (c.md:L1)\n- d (L1)', multi(), 1);
  assert.deepEqual(items.map((i) => i.status), ['ok', 'ok', 'bad', 'bad']);
});

test('draft job: chunk headers, result line numbers, summary', () => {
  const chunks = [
    { lines: { 'a.md': [[1, 5]] }, span: { from: { name: 'a.md', n: 1 }, to: { name: 'a.md', n: 5 } } },
    { lines: { 'a.md': [[4, 10]] }, span: { from: { name: 'a.md', n: 4 }, to: { name: 'a.md', n: 10 } } },
  ];
  const outs = [{ text: '- notes (L1)' }, { text: '- retry (L8)\n- bad (L1)' }];
  const r = checkJob({ mode: 'draft', chunks, outs, sources: SRC, singleName: 'a.md', spanText });
  assert.equal(r.text, '=== chunk 1 (a.md:L1–L5) ===\n- notes (L1)\n=== chunk 2 (a.md:L4–L10) ===\n- retry (L8)\n- bad (L1)\n');
  assert.deepEqual(r.items.map((i) => [i.result_line, i.status]), [
    [2, 'ok'],
    [4, 'ok'],
    [5, 'bad'],
  ]);
  assert.equal(r.summary.refs_ok, 2);
  assert.equal(r.summary.refs_bad, 1);
});

// ---- edits ----

test('edits: valid; old missing / ambiguous; masks; outside the chunk; line as "L123"; bad JSON', () => {
  const out = [
    '{"file":"","line":8,"old":"retry=3","new":"retry=5","why":"more"}',
    '{"file":"","line":"L2","old":"ether1","new":"ether2","why":"x"}',
    '{"file":"","line":8,"old":"retry=9","new":"x","why":"x"}',
    '{"file":"","line":9,"old":"alpha","new":"beta","why":"x"}',
    '{"file":"","line":3,"old":"[token]","new":"secret","why":"x"}',
    '{"file":"","line":8,"old":"retry","new":"[key]","why":"x"}',
    '{"file":"","line":15,"old":"line","new":"x","why":"x"}',
    'this is not json',
  ].join('\n');
  const { valid, rejected } = checkEditsChunk(out, single(), 1);
  assert.deepEqual(valid.map((e) => [e.line, e.old]), [
    [8, 'retry=3'],
    [2, 'ether1'],
  ]);
  assert.deepEqual(
    rejected.map((e) => e.reason),
    [
      '"old" is not in the source line',
      '"old" occurs 2 times in the source line',
      'touches a mask: the masked text is not what is on disk',
      'touches a mask: the masked text is not what is on disk',
      "line not in this chunk's input",
      'not JSON',
    ],
  );
});

test('edits: a JSON array and a ``` wrapper are tolerated; several files need the file name', () => {
  const arr = '```json\n[{"file":"b.md","line":2,"old":"line 2","new":"row 2","why":"x"},{"file":"","line":1,"old":"line","new":"x","why":"x"}]\n```';
  const { valid, rejected } = checkEditsChunk(arr, multi(), 1);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].file, 'b.md');
  assert.equal(rejected[0].reason, 'file name missing (several files)');
});

test('edits job: overlap duplicates dropped by (file, line); valid and rejected apart', () => {
  const chunks = [{ lines: { 'a.md': [[1, 10]] } }, { lines: { 'a.md': [[6, 15]] } }];
  const e8 = '{"file":"","line":8,"old":"retry=3","new":"retry=5","why":"x"}';
  const outs = [{ text: e8 }, { text: `${e8}\n{"file":"","line":12,"old":"line 12","new":"row 12","why":"x"}` }];
  const r = checkJob({ mode: 'edits', chunks, outs, sources: SRC, singleName: 'a.md', spanText });
  assert.equal(r.valid.length, 2);
  assert.equal(r.rejected.length, 0);
  assert.equal(r.summary.pass_rate, 1);
  assert.equal(r.text.trim().split('\n').length, 2);
});

test('checks skip chunks that did not finish', () => {
  const chunks = [{ lines: { 'a.md': [[1, 5]] }, span: { from: { name: 'a.md', n: 1 }, to: { name: 'a.md', n: 5 } } }, { lines: { 'a.md': [[6, 10]] } }];
  const r = checkJob({ mode: 'extract', chunks, outs: [{ text: 'L1| Router notes' }, null], sources: SRC, singleName: 'a.md', spanText });
  assert.equal(r.summary.ok, 1);
});

// ---- file names with spaces, brackets and "#" ----

const ODD = new Map([
  source('my notes (old).md', 10, (i) => `old note ${i}`),
  source('a b.md', 10, (i) => `ab line ${i}`),
  source('b.md', 10, (i) => `b line ${i}`),
  source('x#1.md', 10, (i) => `x line ${i}`),
]);
const oddView = () =>
  chunkView({ lines: { 'my notes (old).md': [[1, 10]], 'a b.md': [[1, 10]], 'b.md': [[1, 10]], 'x#1.md': [[1, 10]] } }, ODD, null);

test('draft refs: names with spaces, brackets and "#" are matched against the chunk\'s files', () => {
  const v = oddView();
  const r = parseRefs('- old note 5 (my notes (old).md:L5) and more', v.names);
  assert.deepEqual(r.refs.map((x) => [x.name, x.from, x.to]), [['my notes (old).md', 5, 5]]);
  assert.equal(r.rest, '- old note 5  and more');
  assert.deepEqual(parseRefs('(a b.md:L3-L7)', v.names).refs.map((x) => [x.name, x.from, x.to]), [['a b.md', 3, 7]]);
  assert.deepEqual(parseRefs('(x#1.md:L2)', v.names).refs.map((x) => [x.name, x.from]), [['x#1.md', 2]]);
  assert.deepEqual(parseRefs('(b.md:L2, a b.md:L4; x#1.md:L1–L3)', v.names).refs.map((x) => [x.name, x.from, x.to]), [
    ['b.md', 2, 2],
    ['a b.md', 4, 4],
    ['x#1.md', 1, 3],
  ]);
  const items = checkDraftChunk(['- old note 5 (my notes (old).md:L5)', '- ab lines (a b.md:L3-L7)', '- x (x#1.md:L2)', '- nope (c d.md:L1)'].join('\n'), v, 1);
  assert.deepEqual(items.map((i) => i.status), ['ok', 'ok', 'ok', 'bad']);
  assert.match(items[3].issues[0], /ref to an unknown file: c d\.md:L1/);
});

test('extract: "name:L| text" with odd names; the longest name wins', () => {
  const items = checkExtractChunk(['my notes (old).md:L5| old note 5', 'a b.md:L3| ab line 3', 'b.md:L3| b line 3', 'x#1.md:L2| x line 2', 'zz (q).md:L1| x'].join('\n'), oddView(), 1);
  assert.deepEqual(items.map((i) => [i.file, i.status]), [
    ['my notes (old).md', 'ok'],
    ['a b.md', 'ok'],
    ['b.md', 'ok'],
    ['x#1.md', 'ok'],
    ['zz (q).md', 'bad'],
  ]);
  assert.equal(items[4].reason, 'unknown file name');
});

test('edits: the "file" field is compared as a whole string, so odd names just work', () => {
  const { valid, rejected } = checkEditsChunk('{"file":"my notes (old).md","line":5,"old":"note 5","new":"note five","why":"x"}\n{"file":"a b","line":1,"old":"ab","new":"x","why":"x"}', oddView(), 1);
  assert.equal(valid.length, 1);
  assert.equal(rejected[0].reason, 'unknown file name');
});
