import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { decide, DEFAULT_MAX_BYTES } from '../hooks/block-large-reads.js';
import { isolatedEnv, tmpDir, writeJson } from './helpers.js';

const HOOK = path.join(import.meta.dirname, '..', 'hooks', 'block-large-reads.js');

function runHook(stdin, env = {}, cwd) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    cwd,
    encoding: 'utf8',
    timeout: 15000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function setup(maxBytes = 100) {
  const d = tmpDir();
  const cfg = writeJson(path.join(d, 'cfg.json'), { read_roots: [d], hook: { max_bytes: maxBytes } });
  const env = isolatedEnv(path.join(d, 'home'), { CHEAP_EYES_CONFIG: cfg });
  const big = path.join(d, 'big.log');
  fs.writeFileSync(big, 'line of text\n'.repeat(50)); // 650 bytes
  const small = path.join(d, 'small.md');
  fs.writeFileSync(small, 'tiny\n');
  return { d, env, big, small };
}

const read = (file_path, extra = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path, ...extra }, cwd: '/' });

test('a whole-file Read of a large text file is denied, pointing to eyes_run, Grep or a ranged Read', () => {
  const s = setup();
  const r = runHook(read(s.big), s.env, s.d);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /is 650 bytes \(over hook\.max_bytes 100\).*eyes_run.*Grep.*offset\/limit/);
});

test('a ranged Read, a small file and other tools pass with no output (never "allow")', () => {
  const s = setup();
  for (const stdin of [
    read(s.big, { offset: 1, limit: 20 }),
    read(s.big, { limit: 20 }),
    read(s.small),
    JSON.stringify({ tool_name: 'Grep', tool_input: { pattern: 'x', path: s.big } }),
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: `cat ${s.big}` } }),
  ]) {
    const r = runHook(stdin, s.env, s.d);
    assert.equal(r.code, 0);
    assert.equal(r.out, '', stdin);
  }
});

test('binary files, images and PDFs pass; UTF-16 text is still text', () => {
  const s = setup();
  const bin = path.join(s.d, 'blob.dat');
  fs.writeFileSync(bin, Buffer.concat([Buffer.from('abc'), Buffer.alloc(500)]));
  const png = path.join(s.d, 'pic.png');
  fs.writeFileSync(png, 'x'.repeat(500));
  const u16 = path.join(s.d, 'ps.log');
  fs.writeFileSync(u16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('text line\r\n'.repeat(40), 'utf16le')]));
  assert.equal(runHook(read(bin), s.env, s.d).out, '');
  assert.equal(runHook(read(png), s.env, s.d).out, '');
  assert.match(runHook(read(u16), s.env, s.d).out, /"deny"/);
});

test('any hook error → allow: bad JSON, missing file, empty stdin', () => {
  const s = setup();
  for (const stdin of ['not json', '', read(path.join(s.d, 'missing.log')), JSON.stringify({ tool_name: 'Read' })]) {
    const r = runHook(stdin, s.env, s.d);
    assert.equal(r.code, 0, stdin);
    assert.equal(r.out, '', stdin);
  }
});

test('max_bytes: from hook.max_bytes in the config; default 30720 without a config', () => {
  const s = setup(1000);
  assert.equal(runHook(read(s.big), s.env, s.d).out, '', '650 bytes is under 1000');
  const bare = tmpDir();
  const env = isolatedEnv(path.join(bare, 'home'), { HOME: path.join(bare, 'home'), USERPROFILE: path.join(bare, 'home') });
  assert.equal(runHook(read(s.big), env, bare).out, '', 'default 30720');
  assert.equal(DEFAULT_MAX_BYTES, 30720);
  const huge = path.join(bare, 'huge.log');
  fs.writeFileSync(huge, 'y'.repeat(DEFAULT_MAX_BYTES + 1));
  assert.match(runHook(read(huge), env, bare).out, /over hook\.max_bytes 30720/);
});

test('decide() is pure enough to unit-test', () => {
  const s = setup();
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: s.big } }, 10), null);
  assert.match(decide({ tool_name: 'Read', tool_input: { file_path: s.big } }, 10), /over hook\.max_bytes 10/);
});
