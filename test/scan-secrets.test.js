// Fake secrets for the tests. scan-secrets:allow-file
// Private addresses are assembled at run time: the LAN check has no opt-out.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileOptions, scanText } from '../tools/scan-secrets.mjs';
import { tmpDir } from './helpers.js';

const SCRIPT = path.join(import.meta.dirname, '..', 'tools', 'scan-secrets.mjs');
const FAKE_SK = 'sk-' + 'or-v1-FAKE0000000000000000000000000000000000000000000000000000';
const ip = (...octets) => octets.join('.');

test('private LAN addresses are found, public and documentation ones are not', () => {
  const text = [
    `a ${ip(10, 1, 2, 3)}`,
    `b ${ip(172, 16, 0, 1)}`,
    `c ${ip(172, 31, 255, 254)}`,
    `d ${ip(192, 168, 1, 20)}`,
    'e 172.32.0.1',
    'f 192.0.2.10',
    'g 8.8.8.8',
    `h ${ip(10, 0, 0, 300)}`,
    `i v1.${ip(10, 0, 1, 2)}`,
  ].join('\n');
  assert.deepEqual(
    scanText(text).map((f) => f.line),
    [1, 2, 3, 4],
  );
});

test('masker hits are found and named; markers and code files behave as documented', () => {
  const text = [`key = "${FAKE_SK}"`, 'password: hunter2hunter2', 'nothing here', `x ${FAKE_SK} # scan-secrets:allow`].join('\n');
  assert.deepEqual(scanText(text), [
    { line: 1, rules: ['sk_key'] },
    { line: 2, rules: ['kv_secret'] },
  ]);
  // Code: key-value / Authorization rules are identifiers there; token shapes still count.
  assert.deepEqual(scanText(`const token = opts.token;\nconst k = '${FAKE_SK}';`, { code: true }), [{ line: 2, rules: ['sk_key'] }]);
  // allow-file in the first 3 lines turns the masker check off (not the LAN check),
  // and only when the caller allows it (files under test/).
  const marked = `// scan-secrets:allow-file\n${FAKE_SK}\nhost ${ip(192, 168, 0, 9)}`;
  assert.deepEqual(scanText(marked, { allowFile: true }), [{ line: 3, rules: ['private_ipv4'] }]);
  assert.deepEqual(scanText(marked), [
    { line: 2, rules: ['sk_key'] },
    { line: 3, rules: ['private_ipv4'] },
  ]);
  assert.deepEqual(scanText(`${FAKE_SK}\n${ip(10, 0, 0, 1)}`, { lanOnly: true }), [{ line: 2, rules: ['private_ipv4'] }]);
});

test('allow-file is honoured only under test/', () => {
  assert.equal(fileOptions('test/mask.test.js').allowFile, true);
  assert.equal(fileOptions('test/fixtures/x.txt').allowFile, true);
  for (const rel of ['README.md', 'src/mask.js', 'tools/test/x.js', 'docs/test/x.md', '../test/x.js']) assert.equal(fileOptions(rel).allowFile, false, rel);
  // Through the CLI: a marked file outside test/ is still scanned.
  const dir = tmpDir();
  const file = path.join(dir, 'notes.md');
  fs.writeFileSync(file, `<!-- scan-secrets:allow-file -->\nkey ${FAKE_SK}\n`);
  const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /notes\.md:2: sk_key/);
});

test('the CLI fails on a finding and never prints the matched text', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'leak.md');
  const lan = ip(192, 168, 7, 7);
  fs.writeFileSync(file, `ok\nkey ${FAKE_SK}\nhost ${lan}\n`);
  const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /leak\.md:2: sk_key/);
  assert.match(r.stdout, /leak\.md:3: private_ipv4/);
  assert.ok(!r.stdout.includes('FAKE0000') && !r.stdout.includes(lan));
  const clean = path.join(dir, 'clean.md');
  fs.writeFileSync(clean, 'nothing to see, 192.0.2.1\n');
  const c = spawnSync(process.execPath, [SCRIPT, clean], { encoding: 'utf8' });
  assert.equal(c.status, 0);
  assert.match(c.stdout, /1 file\(s\) clean/);
});

test('every finding names its file, and the counts add up', () => {
  const dir = tmpDir();
  const leak = path.join(dir, 'leak.md');
  fs.writeFileSync(leak, `key ${FAKE_SK}\n`);
  const missing = path.join(dir, 'missing.md');
  const clean = path.join(dir, 'clean.md');
  fs.writeFileSync(clean, 'nothing\n');
  const r = spawnSync(process.execPath, [SCRIPT, leak, missing, clean], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /leak\.md:1: sk_key/);
  assert.match(r.stdout, /missing\.md: cannot read \(ENOENT\)/, 'an unreadable file is a named finding on stdout');
  assert.match(r.stdout, /scan-secrets: 2 finding\(s\) in 2 of 3 file\(s\)/);
});
