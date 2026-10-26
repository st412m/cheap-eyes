// Marker chains: after skipped lines, at a chunk break and in the second half of a
// re-split chunk, a line inside an attachment is preceded by the attachment marker and
// the page/slide marker it sits in, outermost first.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { chainSweep, chunkBlocks, fileItems, splitChunk } from '../src/input/render.js';
import { prepareInput } from '../src/run.js';
import { tmpDir } from './helpers.js';

const FX = path.join(import.meta.dirname, 'fixtures', 'formats');
const masked = (lines) => new Map(lines.map((l, i) => [i, l]));

// A message: head and body L1–L5, the attachment list L6–L7, spec.pdf with page 1
// (L8–L9) and page 2 (L10–L12).
const LINES = 'abcdefghijkl'.split('');
const MARKERS = [
  { at: 5, text: '--- attachments ---' },
  { at: 7, text: '--- attachment: spec.pdf ---' },
  { at: 7, text: '--- page 1 ---' },
  { at: 9, text: '--- page 2 ---' },
];
const SECTIONS = [
  { kind: 'attachments', n: null, label: null, start: 6, end: 7 },
  { kind: 'attachment', n: null, label: 'spec.pdf', start: 8, end: 12 },
  { kind: 'page', n: 1, label: null, start: 8, end: 9 },
  { kind: 'page', n: 2, label: null, start: 10, end: 12 },
];

test('chainSweep: the markers of the sections holding a line, outermost first; null when markers and sections do not pair', () => {
  const chainOf = chainSweep(MARKERS, SECTIONS);
  const texts = (n) => chainOf(n).map((m) => m.text);
  assert.deepEqual(texts(1), []);
  assert.deepEqual(texts(6), ['--- attachments ---']);
  assert.deepEqual(texts(8), ['--- attachment: spec.pdf ---', '--- page 1 ---']);
  assert.deepEqual(texts(11), ['--- attachment: spec.pdf ---', '--- page 2 ---']);
  assert.equal(chainSweep(MARKERS, []), null);
  assert.equal(chainSweep(MARKERS, SECTIONS.slice(1)), null);
  assert.equal(chainSweep(MARKERS, SECTIONS.map((s, i) => (i === 3 ? { ...s, start: 11 } : s))), null);
});

test('fileItems: after skipped lines the whole chain of the line; without sections only the last marker', () => {
  const args = { nums: [2, 11], masked: masked(LINES), total: 12, filtered: true, markers: MARKERS };
  assert.deepEqual(
    fileItems({ ...args, sections: SECTIONS }).map((it) => it.text),
    ['… (line 1 skipped)', 'L2| b', '… (lines 3–10 skipped)', '--- attachment: spec.pdf ---', '--- page 2 ---', 'L11| k', '… (line 12 skipped)'],
  );
  assert.deepEqual(
    fileItems(args).map((it) => it.text),
    ['… (line 1 skipped)', 'L2| b', '… (lines 3–10 skipped)', '--- page 2 ---', 'L11| k', '… (line 12 skipped)'],
  );
  // Unfiltered output is unchanged by sections.
  const all = { nums: LINES.map((_, i) => i + 1), masked: masked(LINES), total: 12, filtered: false, markers: MARKERS };
  assert.deepEqual(
    fileItems({ ...all, sections: SECTIONS }).map((it) => it.text),
    fileItems(all).map((it) => it.text),
  );
});

// The marker lines at the top of a chunk text, before its first numbered line.
const lead = (text) => {
  const out = [];
  for (const l of text.split('\n')) {
    if (/^L\d+\|/.test(l)) break;
    if (l.startsWith('--- ')) out.push(l);
  }
  return out;
};
const firstLine = (text) => Number(/^L(\d+)\|/m.exec(text)[1]);

function longMessage() {
  // L1–L5 body, L6–L7 list, attachment L8–L67: page 1 L8–L37, page 2 L38–L67.
  const lines = Array.from({ length: 67 }, (_, i) => `line ${i + 1} ${'w'.repeat(30)}`);
  const markers = [
    { at: 5, text: '--- attachments ---' },
    { at: 7, text: '--- attachment: spec.pdf ---' },
    { at: 7, text: '--- page 1 ---' },
    { at: 37, text: '--- page 2 ---' },
  ];
  const sections = [
    { kind: 'attachments', n: null, label: null, start: 6, end: 7 },
    { kind: 'attachment', n: null, label: 'spec.pdf', start: 8, end: 67 },
    { kind: 'page', n: 1, label: null, start: 8, end: 37 },
    { kind: 'page', n: 2, label: null, start: 38, end: 67 },
  ];
  const items = fileItems({ nums: lines.map((_, i) => i + 1), masked: masked(lines), total: 67, filtered: false, markers, sections });
  const chainOf = chainSweep(markers, sections);
  const expected = lines.map((_, i) => chainOf(i + 1).map((m) => m.text));
  return { items, expected };
}

test('chunking: a chunk that starts inside the attachment opens with its chain, each marker once', () => {
  const { items, expected } = longMessage();
  for (const multi of [false, true]) {
    const chunks = chunkBlocks([{ name: 'mail.eml', items }], { budget: 220, multi });
    assert.ok(chunks.length > 5);
    for (const c of chunks.slice(1)) {
      const n = firstLine(c.text);
      assert.deepEqual(lead(c.text), expected[n - 1], c.text);
      assert.ok(c.tokens <= 220, `chunk within budget: ${c.tokens}`);
    }
    const covered = new Set(chunks.flatMap((c) => c.lines['mail.eml'].flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a + k))));
    assert.equal(covered.size, 67);
  }
});

test('chunking: a break on a marker repeats the chain once, without the marker twice', () => {
  const { items } = longMessage();
  const chunks = chunkBlocks([{ name: 'mail.eml', items }], { budget: 220, multi: false });
  for (const c of chunks) {
    const before = lead(c.text);
    assert.equal(new Set(before).size, before.length, c.text);
  }
});

test('re-split: the second half opens with the chain of its first line', () => {
  const { items, expected } = longMessage();
  const [chunk] = chunkBlocks([{ name: 'mail.eml', items }], { budget: 100000, multi: false });
  const [a, b] = splitChunk(chunk, { multi: false });
  assert.equal(firstLine(a.text), 1);
  const n = firstLine(b.text);
  assert.ok(n > 8, `second half starts inside the attachment: L${n}`);
  assert.deepEqual(lead(b.text), expected[n - 1]);
});

test('pipeline: grep in an EML keeps the attachment marker above the page and slide markers', async () => {
  const root = tmpDir();
  const b = 'cheap-eyes-boundary';
  const part = (file, type) =>
    `--${b}\r\nContent-Type: ${type}; name="${file}"\r\nContent-Disposition: attachment; filename="${file}"\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
    fs.readFileSync(path.join(FX, file)).toString('base64').replace(/.{76}/g, '$&\r\n') +
    '\r\n';
  const eml =
    `From: a@example.com\r\nTo: b@example.com\r\nSubject: s\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n` +
    `--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody line.\r\n` +
    part('text.pdf', 'application/pdf') +
    part('text.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation') +
    `--${b}--\r\n`;
  fs.writeFileSync(path.join(root, 'mail.eml'), eml);
  const config = parseConfig({ read_roots: [root], models: { fast: { ids: ['v/a'] } }, defaults: { extract: 'fast', draft: 'fast', edits: 'fast' } });
  const input = await prepareInput({ mode: 'extract', task: 't', files: [path.join(root, 'mail.eml')], grep: { pattern: 'Voltage', context: 0 } }, { config });
  const texts = input.kept[0].items.filter((it) => it.kind !== 'gap').map((it) => it.text.replace(/^(L\d+)\| .*/, '$1'));
  assert.deepEqual(texts, ['--- attachment: text.pdf ---', '--- page 1 ---', 'L16', '--- attachment: text.pptx ---', '--- slide 2 ---', 'L26']);
});
