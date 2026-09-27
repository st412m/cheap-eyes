import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignNames, chunkBlocks, estimateTokens, fileItems } from '../src/input/render.js';

const root = (index, real, kind = 'dir') => ({ index, real, kind });

test('names: relative to the root; clash → root segment; still equal → root index', () => {
  const files = [
    { rel: 'x.md', root: root(1, '/srv/vault') },
    { rel: 'x.md', root: root(2, '/mnt/notes') },
    { rel: 'y.md', root: root(1, '/srv/vault') },
    { rel: 'x.md', root: root(3, '/backup/vault') },
  ];
  assert.deepEqual(assignNames(files, 'linux'), ['#1/x.md', 'notes/x.md', 'y.md', '#3/x.md']);
  assert.deepEqual(assignNames([files[0], files[1]], 'linux'), ['vault/x.md', 'notes/x.md']);
});

test('names: file roots are named by basename; windows roots', () => {
  assert.deepEqual(assignNames([{ rel: 'home-assistant.log', root: root(1, '/config/home-assistant.log', 'file') }], 'linux'), ['home-assistant.log']);
  const files = [
    { rel: 'a/b.md', root: root(1, 'C:\\wiki') },
    { rel: 'a/b.md', root: root(2, '\\\\host\\vault\\wiki2') },
  ];
  assert.deepEqual(assignNames(files, 'win32'), ['wiki/a/b.md', 'wiki2/a/b.md']);
});

test('token estimate: UTF-8 bytes / 3, Cyrillic counts double', () => {
  assert.equal(estimateTokens('abcdef'), 2);
  assert.equal(estimateTokens('привет'), 4); // 12 bytes
});

function block(name, n, text = (i) => `line ${i} ${'x'.repeat(20)}`) {
  const nums = Array.from({ length: n }, (_, i) => i + 1);
  const masked = new Map(nums.map((k) => [k - 1, text(k)]));
  return { name, items: fileItems({ nums, masked, total: n, filtered: false }) };
}

test('chunking: no split lines, 5-line overlap, header repeated, line map per chunk', () => {
  const b = block('a.md', 60);
  const chunks = chunkBlocks([b, block('b.md', 3)], { budget: 200, multi: true });
  assert.ok(chunks.length > 2);
  for (const c of chunks) {
    assert.ok(c.tokens <= 200, `chunk within budget: ${c.tokens}`);
    const lines = c.text.split('\n');
    assert.match(lines[0], /^=== file: (a|b)\.md ===$/);
    for (const l of lines) assert.match(l, /^(=== file: .* ===|L\d+\| line \d+ x{20})$/);
  }
  // overlap: chunk 2 starts with the last 5 lines of chunk 1
  const r1 = chunks[0].lines['a.md'];
  const last1 = r1.at(-1)[1];
  const first2 = chunks[1].lines['a.md'][0][0];
  assert.equal(first2, last1 - 4);
  // every line of a.md is in some chunk
  const seen = new Set();
  for (const c of chunks) for (const [a, z] of c.lines['a.md'] ?? []) for (let i = a; i <= z; i++) seen.add(i);
  assert.equal(seen.size, 60);
  assert.deepEqual(chunks.at(-1).span.to, { name: 'b.md', n: 3 });
});

test('chunking: a break at a file boundary carries no overlap', () => {
  const small = (name) => block(name, 4);
  const one = chunkBlocks([small('a.md')], { budget: 1000, multi: true })[0].tokens;
  const chunks = chunkBlocks([small('a.md'), small('b.md')], { budget: one + 5, multi: true });
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[1].lines, { 'b.md': [[1, 4]] });
});

test('chunking: single file has no header; Cyrillic lines weigh more', () => {
  const lat = chunkBlocks([block('a', 30, () => 'a'.repeat(30))], { budget: 150, multi: false });
  const cyr = chunkBlocks([block('a', 30, () => 'я'.repeat(30))], { budget: 150, multi: false });
  assert.ok(!lat[0].text.includes('=== file'));
  assert.ok(cyr.length > lat.length, `${cyr.length} > ${lat.length}`);
});

test('chunking: a single line over the budget is refused with its place', () => {
  assert.throws(
    () => chunkBlocks([block('big.log', 3, (i) => (i === 2 ? 'z'.repeat(3000) : 'ok'))], { budget: 500, multi: true }),
    /does not fit one chunk: big\.log:L2/,
  );
});
