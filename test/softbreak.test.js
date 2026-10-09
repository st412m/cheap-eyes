// A word broken by a soft hyphen at a PDF line end comes back joined through
// readSource. The shape of the real case: the soft hyphen is drawn as its own text run
// at the line end and mapped to U+00AD by the font's ToUnicode. The PDF is built here,
// not committed. How the join is done is tested in doclines.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readSource } from '../src/input/extract.js';
import { tmpDir } from './helpers.js';

const CONFIG = { max_file_bytes: 2e6, max_doc_bytes: 5e7, extract_timeout_s: 60 };

// A one-page PDF: Helvetica with a ToUnicode CMap (printable ASCII as is, 0xAD → U+00AD).
// `lines`: per line, the text runs drawn with Tj (latin1; "\xad" is the soft hyphen).
function makePdf(lines) {
  const esc = (s) => [...s].map((c) => (c === '\xad' ? '\\255' : c.replace(/[()\\]/g, '\\$&'))).join('');
  const content = ['BT', '/F1 12 Tf', '72 720 Td', ...lines.flatMap((runs, i) => [...(i ? ['0 -16 Td'] : []), ...runs.map((r) => `(${esc(r)}) Tj`)]), 'ET'].join('\n');
  const cmap = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def /CMapType 2 def',
    '1 begincodespacerange <00> <FF> endcodespacerange',
    '1 beginbfrange <20> <7E> <0020> endbfrange',
    '1 beginbfchar <AD> <00AD> endbfchar',
    'endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>',
    `<< /Length ${Buffer.byteLength(cmap, 'latin1')} >>\nstream\n${cmap}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('a soft hyphen drawn at a PDF line end joins the word; a hard hyphen stays; a mid-line one is dropped', async () => {
  const d = tmpDir();
  const file = path.join(d, 'soft.pdf');
  fs.writeFileSync(
    file,
    makePdf([
      ['We plani', '\xad'],
      ['ruem to simplify the access for companies'],
      ['north-'],
      ['west of the region and further on'],
      ['in the mid\xaddle of a line, nothing else'],
    ]),
  );
  const r = await readSource(file, { name: 'soft.pdf', config: CONFIG });
  assert.deepEqual(r.lines, ['We planiruem', 'to simplify the access for companies', 'north-', 'west of the region and further on', 'in the middle of a line, nothing else']);
  assert.ok(!r.warnings.some((w) => w.includes('not patched for soft hyphens')), 'the installed pdfjs is patched');
});
