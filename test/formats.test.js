// Formats through doclines: the adapter mapping, the allowlist and the refusal
// messages in cheap-eyes wording. Format internals are tested in doclines. Fixture
// files are checked against test/fixtures/formats/fixtures.json.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { DoclinesError, FORMATS } from 'doclines';
import { ALLOWED, printWarnings, READS, readSource, toInputError } from '../src/input/extract.js';
import { tmpDir } from './helpers.js';

const FX = path.join(import.meta.dirname, 'fixtures', 'formats');
const FIXTURES = JSON.parse(fs.readFileSync(path.join(FX, 'fixtures.json'), 'utf8'));
const CONFIG = { max_file_bytes: 2 * 1024 * 1024, max_doc_bytes: 50 * 1024 * 1024, extract_timeout_s: 60 };
const fx = (name) => fs.readFileSync(path.join(FX, name));

async function refused(promise, re) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.name, 'InputError', e.stack);
    assert.match(e.message, re);
    return true;
  });
}

// ---- every fixture against fixtures.json ----

for (const [file, want] of Object.entries(FIXTURES).filter(([k]) => !k.startsWith('_'))) {
  test(`fixture ${file}: ${want.outcome}${want.reason ? ` (${want.reason})` : ''}`, async () => {
    const p = path.join(FX, file);
    if (want.outcome === 'refused') {
      await refused(readSource(p, { name: file, config: CONFIG }), new RegExp(want.reason.replace(/[()?]/g, '\\$&')));
      return;
    }
    const r = await readSource(p, { name: file, config: CONFIG });
    assert.equal(r.format, want.format);
    const text = r.lines.join('\n');
    for (const s of want.must) assert.ok(text.includes(s), `${file}: missing ${JSON.stringify(s)}\n${text}`);
    for (const s of want.must_not) assert.ok(!text.includes(s), `${file}: must not contain ${JSON.stringify(s)}`);
    if (want.table_row) assert.ok(r.lines.includes(want.table_row), `${file}: no line ${JSON.stringify(want.table_row)}\n${text}`);
    if (want.pages) assert.equal(r.pageStarts.length, want.pages);
    if (want.sections) assert.deepEqual(r.sections.map((s) => s.kind), want.sections);
    if (want.markers) assert.deepEqual(r.markers.map((m) => m.text), want.markers);
    assert.ok(!text.includes('undefined'), `${file}: "undefined" leaked into the text`);
  });
}

// ---- the result shape ----

test('PDF: page marker, page table, a section per page, sha256 and size of the file', async () => {
  const r = await readSource(path.join(FX, 'text.pdf'), { name: 'text.pdf', config: CONFIG });
  assert.match(r.lines.find((l) => l.includes('Temperature')), /Temperature.*−40.*105/);
  assert.deepEqual(r.markers, [{ at: 0, text: '--- page 1 ---' }]);
  assert.deepEqual(r.pageStarts, [1]);
  assert.deepEqual(r.pagesWithoutText, []);
  assert.deepEqual(r.sections, [{ kind: 'page', n: 1, label: null, start: 1, end: r.lines.length }]);
  assert.equal(r.encoding, null);
  assert.equal(r.bytes, fx('text.pdf').length);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(r.warnings));
});

test('sections of each new format carry their numbers and names (lines 1-based, end inclusive)', async () => {
  const pptx = await readSource(path.join(FX, 'text.pptx'), { name: 'text.pptx', config: CONFIG });
  assert.deepEqual(pptx.sections.slice(0, 3), [
    { kind: 'slide', n: 1, label: null, start: 1, end: 3 },
    { kind: 'notes', n: 1, label: null, start: 4, end: 4 },
    { kind: 'slide', n: 2, label: null, start: 5, end: 8 },
  ]);
  assert.equal(pptx.lines[3], 'Speaker notes for slide one');
  const epub = await readSource(path.join(FX, 'text.epub'), { name: 'text.epub', config: CONFIG });
  assert.deepEqual(epub.sections[1], { kind: 'chapter', n: 2, label: 'Глава первая', start: 3, end: 8 });
  const fb2 = await readSource(path.join(FX, 'text.fb2'), { name: 'text.fb2', config: CONFIG });
  assert.equal(fb2.encoding, 'utf-8');
  assert.deepEqual(fb2.sections.at(-1), { kind: 'notes', n: null, label: null, start: 12, end: 13 });
  const eml = await readSource(path.join(FX, 'mail-mixed.eml'), { name: 'mail-mixed.eml', config: CONFIG });
  const docx = eml.sections.find((s) => s.kind === 'attachment' && s.label === 'text.docx');
  assert.equal(eml.lines[docx.start - 1], 'Fixture: cheap-eyes formats');
  assert.deepEqual(eml.markers.find((m) => m.text === '--- attachment: text.docx ---'), { at: docx.start - 1, text: '--- attachment: text.docx ---' });
});

test('plain text: lines as in the file (only \\r removed), no markers or sections', async () => {
  const d = tmpDir();
  const f = path.join(d, 'n.md');
  fs.writeFileSync(f, '# Scan log\r\nexported %PDF-1.7 from the scanner  \n');
  const r = await readSource(f, { name: 'n.md', config: CONFIG });
  assert.equal(r.format, 'text');
  assert.equal(r.encoding, 'utf-8');
  assert.deepEqual(r.lines, ['# Scan log', 'exported %PDF-1.7 from the scanner  ']);
  assert.deepEqual([r.markers, r.sections, r.pageStarts, r.pagesWithoutText, r.warnings], [[], [], null, [], []]);
});

// ---- the allowlist ----

test('allowed formats: every doclines format except spreadsheets; a new doclines format needs a change here', () => {
  assert.deepEqual(ALLOWED, ['text', 'html', 'pdf', 'docx', 'doc', 'rtf', 'pptx', 'ppt', 'odt', 'odp', 'epub', 'fb2', 'eml', 'msg']);
  assert.deepEqual(
    FORMATS.map((f) => f.id).filter((id) => !ALLOWED.includes(id)),
    ['xlsx', 'xls', 'ods'],
  );
  assert.ok(FORMATS.filter((f) => !ALLOWED.includes(f.id)).every((f) => f.family === 'spreadsheet'));
  assert.equal(READS, 'cheap-eyes reads text, HTML, PDF, Word, RTF, PowerPoint, OpenDocument text and presentations, EPUB, FB2, EML, MSG');
});

// ---- refusal messages ----

test('a spreadsheet is refused with the reason; the skip reason keeps the format', async () => {
  for (const [file, label] of [
    ['refused.xls', 'Excel workbook (.xls)'],
    ['text.xlsx', 'Excel workbook (.xlsx)'],
  ]) {
    await assert.rejects(readSource(path.join(FX, file), { name: file, config: CONFIG }), (e) => {
      assert.equal(e.message, `unsupported format: ${label} — spreadsheets are not read: tables need exact lookups, use grep or code (${file})`);
      assert.equal(e.reason, `unsupported format: ${label}`);
      return true;
    });
  }
});

test('a damaged OLE file is refused as a format, without a library message', async () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'cut.doc'), fx('text.doc').subarray(0, 1024));
  await assert.rejects(readSource(path.join(d, 'cut.doc'), { name: 'cut.doc', config: CONFIG }), (e) => {
    assert.equal(e.message, `unsupported format: damaged OLE compound file — ${READS} (cut.doc)`);
    assert.equal(e.reason, 'unsupported format: damaged OLE compound file');
    return true;
  });
});

test('every doclines code maps to the cheap-eyes wording and config keys', () => {
  const map = (code, message, extra = {}) => toInputError(new DoclinesError(code, message, extra), { name: 'f', config: CONFIG });
  const cases = [
    [map('unsupported', 'unsupported format: Excel binary workbook (.xlsb) (f)', { label: 'Excel binary workbook (.xlsb)' }), `unsupported format: Excel binary workbook (.xlsb) — ${READS} (f)`, 'unsupported format: Excel binary workbook (.xlsb)'],
    [map('unsupported', 'unsupported format: image (PNG), no OCR (f)', { label: 'image (PNG), no OCR' }), `unsupported format: image (PNG), no OCR — ${READS} (f)`, 'unsupported format: image (PNG), no OCR'],
    [map('unsupported', 'charset koi8-u is not available in this Node build (it needs full ICU) (f)', { reason: 'charset not available' }), 'charset koi8-u is not available in this Node build (it needs full ICU) (f)', 'charset not available'],
    [map('not_allowed', 'format not allowed: OpenDocument spreadsheet (.ods) (f)', { format: 'ods', label: 'OpenDocument spreadsheet (.ods)' }), 'unsupported format: OpenDocument spreadsheet (.ods) — spreadsheets are not read: tables need exact lookups, use grep or code (f)', 'unsupported format: OpenDocument spreadsheet (.ods)'],
    [map('encrypted', 'encrypted document: password-protected files are not read (f)'), 'encrypted document — cheap-eyes cannot read password-protected files (f)', 'encrypted document'],
    [map('no_text_layer', 'no usable text layer (scanned PDF?): f', { reason: 'no usable text layer (scanned PDF?)' }), 'no usable text layer (scanned PDF?): f', 'no usable text layer (scanned PDF?)'],
    [map('damaged', 'damaged PDF: f', { reason: 'damaged PDF' }), 'damaged PDF: f', 'damaged PDF'],
    [map('too_large', 'document too large: f (60 bytes > maxDocBytes 50)'), 'document too large: f (60 bytes > max_doc_bytes 50)', 'document too large'],
    [map('text_too_large', 'file too large: f (60 bytes > maxTextBytes 50)', { format: 'text' }), 'file too large: f (60 bytes > max_file_bytes 50)', 'file too large'],
    [map('text_too_large', 'extracted text too large: f (over 2097152 bytes)', { format: 'pdf' }), 'extracted text too large: f (over max_file_bytes 2097152)', 'extracted text too large'],
    [map('timeout', 'extraction timed out after 60 s: f'), 'extraction timed out after 60 s (extract_timeout_s): f', 'extraction timed out'],
    [map('out_of_memory', 'extraction ran out of memory (1024 MB): f', { reason: 'extraction ran out of memory' }), 'extraction ran out of memory (1024 MB): f', 'extraction ran out of memory'],
    [map('binary', 'binary file refused: f', { reason: 'binary file' }), 'binary file refused: f', undefined],
    [map('not_a_file', 'not a regular file: f', { reason: 'not a regular file' }), 'not a regular file: f', undefined],
  ];
  for (const [e, message, reason] of cases) {
    assert.equal(e.name, 'InputError');
    assert.equal(e.message, message);
    assert.equal(e.reason, reason, message);
  }
  const other = new TypeError('x');
  assert.equal(toInputError(other, { name: 'f', config: CONFIG }), other, 'anything but a refusal is passed on');
});

test('a damaged file: the internal detail goes to stderr only, never into the message', () => {
  const printed = [];
  const orig = console.error;
  console.error = (s) => printed.push(s);
  try {
    const e = toInputError(new DoclinesError('damaged', 'cannot read a.doc: damaged or unsupported DOC file', { reason: 'damaged or unsupported file', detail: 'Offset is outside the bounds' }), { name: 'a.doc', config: CONFIG });
    assert.equal(e.message, 'cannot read a.doc: damaged or unsupported DOC file');
    assert.equal(e.reason, 'damaged or unsupported file');
  } finally {
    console.error = orig;
  }
  assert.deepEqual(printed, ['cheap-eyes: extraction failed: a.doc: Offset is outside the bounds']);
});

// ---- limits ----

test('max_doc_bytes caps the raw document; max_file_bytes caps the extracted text', async () => {
  await refused(readSource(path.join(FX, 'text.pdf'), { name: 'text.pdf', config: { ...CONFIG, max_doc_bytes: 1000 } }), /^document too large: text\.pdf \(\d+ bytes > max_doc_bytes 1000\)$/);
  await refused(readSource(path.join(FX, 'utf8.html'), { name: 'utf8.html', config: { ...CONFIG, max_file_bytes: 100 } }), /^extracted text too large: utf8\.html \(over max_file_bytes 100\)$/);
  // Raw HTML over max_file_bytes passes when its text fits.
  const d = tmpDir();
  const big = path.join(d, 'big.html');
  fs.writeFileSync(big, `<html><head><script>${'x'.repeat(5000)}</script></head><body><p>small text</p></body></html>`);
  const r = await readSource(big, { name: 'big.html', config: { ...CONFIG, max_file_bytes: 1000, max_doc_bytes: 10000 } });
  assert.deepEqual(r.lines, ['small text']);
  // Plain text keeps the 0.1 rule: the file itself against max_file_bytes.
  const txt = path.join(d, 'big.log');
  fs.writeFileSync(txt, 'y'.repeat(1001));
  await refused(readSource(txt, { name: 'big.log', config: { ...CONFIG, max_file_bytes: 1000 } }), /^file too large: big\.log \(1001 bytes > max_file_bytes 1000\)$/);
});

test('extract_timeout_s: a document not done in time is refused, the key named', async () => {
  await refused(readSource(path.join(FX, 'text.ppt'), { name: 'text.ppt', config: { ...CONFIG, extract_timeout_s: 0.001 } }), /^extraction timed out after 0\.001 s \(extract_timeout_s\): text\.ppt$/);
});

// ---- warnings and output channels ----

test('doclines warnings go to stderr: per file with its name, process-wide ones once', () => {
  const out = [];
  const orig = console.error;
  console.error = (s) => out.push(s);
  try {
    printWarnings(['Unknown slide layout'], 'a.pptx');
    printWarnings(['pdfjs 0.0.0 not patched for soft hyphens; words broken at line ends stay split', 'Bad cell'], 'a.pdf');
    printWarnings(['pdfjs 0.0.0 not patched for soft hyphens; words broken at line ends stay split'], 'b.pdf');
  } finally {
    console.error = orig;
  }
  assert.deepEqual(out, [
    'cheap-eyes: a.pptx: Unknown slide layout',
    'cheap-eyes: pdfjs 0.0.0 not patched for soft hyphens; words broken at line ends stay split',
    'cheap-eyes: a.pdf: Bad cell',
  ]);
});

test('doclines warnings never reach the job; the heap cap warning is printed once for two documents', () => {
  const run = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'run.js')).href;
  const config = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'config.js')).href;
  // A host heap limit far above the worker cap: doclines warns that the cap is not in effect.
  const script = `
    import { prepareInput } from ${JSON.stringify(run)};
    import { parseConfig } from ${JSON.stringify(config)};
    const root = ${JSON.stringify(FX)};
    const input = await prepareInput({ mode: 'extract', task: 't', files: [root + '/text.pdf', root + '/text.pptx'] }, { config: parseConfig({ read_roots: [root] }) });
    process.stderr.write('\\n' + JSON.stringify(input.warnings));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  const lines = r.stderr.split('\n');
  assert.deepEqual(JSON.parse(lines.at(-1)), [], 'nothing in the job warnings');
  const cheap = lines.filter((l) => l.startsWith('cheap-eyes: '));
  assert.equal(cheap.length, 1, r.stderr);
  assert.match(cheap[0], /^cheap-eyes: heap cap of 1024 MB not in effect: the host process sets --max-old-space-size \(worker heap limit \d+ MB\)$/);
});

test('nothing extraction prints reaches stdout (the stdio MCP channel)', () => {
  const ext = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'input', 'extract.js')).href;
  const script = `
    import { readSource } from ${JSON.stringify(ext)};
    for (const f of ['text.pdf', 'text.pptx', 'text.ppt', 'mail-mixed.eml', 'text.epub']) {
      const r = await readSource(${JSON.stringify(FX)} + '/' + f, { config: ${JSON.stringify(CONFIG)} });
      if (r.lines.length < 5) process.exit(2);
    }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});
