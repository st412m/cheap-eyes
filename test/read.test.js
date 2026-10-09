// Plain text through readSource: UTF-8 or UTF-16 by BOM, binary refusal, line split,
// max_file_bytes on the file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readSource } from '../src/input/extract.js';
import { tmpDir } from './helpers.js';

const CONFIG = { max_file_bytes: 2e6, max_doc_bytes: 5e7, extract_timeout_s: 60 };

const utf16le = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
const utf16be = (s) => {
  const b = Buffer.from(s, 'utf16le');
  b.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), b]);
};

function file(name, data) {
  const f = path.join(tmpDir(), name);
  fs.writeFileSync(f, data);
  return f;
}

const read = (f, config = CONFIG) => readSource(f, { config });

test('UTF-8 with and without BOM', async () => {
  const r = await read(file('a.txt', '﻿привет\n'));
  assert.deepEqual([r.lines, r.encoding], [['привет'], 'utf-8']);
  assert.equal((await read(file('b.txt', 'plain'))).encoding, 'utf-8');
});

test('UTF-16 LE (PowerShell 5.1 ">") and BE by BOM', async () => {
  const le = await read(file('le.txt', utf16le('строка 1\r\nline 2\r\n')));
  assert.deepEqual([le.lines, le.encoding], [['строка 1', 'line 2'], 'utf-16le']);
  const be = await read(file('be.txt', utf16be('a\nб\n')));
  assert.deepEqual([be.lines, be.encoding], [['a', 'б'], 'utf-16be']);
});

test('binary: NUL in the first 8 KB, checked after BOM detection', async () => {
  for (const [name, data] of [
    ['x.bin', Buffer.from([0x41, 0x00, 0x42])],
    ['y.txt', utf16le('a\u0000b')],
  ]) {
    const f = file(name, data);
    await assert.rejects(read(f), (e) => {
      assert.equal(e.name, 'InputError');
      assert.equal(e.message, `binary file refused: ${f}`);
      assert.equal(e.reason, undefined, 'the skip reason is the message head, as in 0.1');
      return true;
    });
  }
  const late = await read(file('late.txt', Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0])])));
  assert.equal(late.lines.length, 1);
});

test('lines: \\r stripped, numbering kept, a trailing newline adds no line', async () => {
  assert.deepEqual((await read(file('a.txt', 'a\r\nb\rc\n'))).lines, ['a', 'bc']);
  assert.deepEqual((await read(file('b.txt', 'a\n\nb'))).lines, ['a', '', 'b']);
  assert.deepEqual((await read(file('c.txt', ''))).lines, []);
  assert.deepEqual((await read(file('d.txt', '\n'))).lines, ['']);
});

test('max_file_bytes refuses a larger file, naming the path', async () => {
  const f = file('big.log', 'x'.repeat(100));
  await assert.rejects(read(f, { ...CONFIG, max_file_bytes: 99 }), (e) => {
    assert.equal(e.message, `file too large: ${f} (100 bytes > max_file_bytes 99)`);
    return true;
  });
  assert.equal((await read(f, { ...CONFIG, max_file_bytes: 100 })).lines.length, 1);
});
