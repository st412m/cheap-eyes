// The server never loads @napi-rs/canvas (pdfjs requires it at module load; its
// native binary kills the process on CPUs without AVX). doclines guards its own
// extraction worker and tests it; here: a PDF read through cheap-eyes leaves nothing
// of the package in the server thread and nothing on stdout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(import.meta.dirname, '..');
const PDF = path.join(ROOT, 'test', 'fixtures', 'formats', 'text.pdf');

test('a PDF read through readSource: CJK text extracts, no @napi-rs file is loaded, stdout stays clean', (t) => {
  t.diagnostic(`@napi-rs/canvas in node_modules: ${fs.existsSync(path.join(ROOT, 'node_modules', '@napi-rs', 'canvas'))}`);
  const ext = pathToFileURL(path.join(ROOT, 'src', 'input', 'extract.js')).href;
  const script = `
    import { createRequire } from 'node:module';
    import { readSource } from ${JSON.stringify(ext)};
    const r = await readSource(${JSON.stringify(PDF)}, { config: { max_file_bytes: 2e6, max_doc_bytes: 5e7, extract_timeout_s: 60 } });
    const loaded = Object.keys(createRequire(import.meta.url).cache).filter((k) => k.includes('@napi-rs'));
    process.stderr.write(JSON.stringify({ cjk: r.lines.some((l) => l.includes('工作温度')), loaded }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.deepEqual(JSON.parse(r.stderr.slice(r.stderr.lastIndexOf('{"cjk"'))), { cjk: true, loaded: [] });
});
