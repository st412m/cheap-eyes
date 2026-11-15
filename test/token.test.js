// The HTTP token: sources, generation, `cheap-eyes token [--new]`, and where it may be printed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { connectionLines, replaceToken, resolveToken, tokenPath } from '../src/token.js';
import { CLI_ARGS, isolatedEnv, tmpDir, writeJson } from './helpers.js';

const ENV_TOKEN = 'FAKE-env-token-0123456789abcdefghijklmn';
const FILE_TOKEN = 'FAKE-file-token-0123456789abcdefghijklm';
const HEX64 = /^[0-9a-f]{64}$/;

function errorOf(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail('expected an error');
}

test('token order: --token-file, then env, then the saved file, then a generated one', () => {
  const dir = tmpDir();
  const state = path.join(dir, 'state');
  const tf = path.join(dir, 'tf.txt');
  fs.writeFileSync(tf, `${FILE_TOKEN}\n`);
  fs.mkdirSync(state);
  fs.writeFileSync(tokenPath(state), 'FAKE-saved-token-0123456789abcdefghijkl\n');
  const env = { CHEAP_EYES_HTTP_TOKEN: ENV_TOKEN };
  assert.deepEqual(resolveToken({ tokenFile: tf, env, stateDir: state }), { token: FILE_TOKEN, source: '--token-file', generated: false, file: null });
  assert.equal(resolveToken({ env, stateDir: state }).source, 'env CHEAP_EYES_HTTP_TOKEN');
  const saved = resolveToken({ env: { CHEAP_EYES_HTTP_TOKEN: '' }, stateDir: state });
  assert.equal(saved.token, 'FAKE-saved-token-0123456789abcdefghijkl');
  assert.equal(saved.source, tokenPath(state));
  fs.rmSync(tokenPath(state));
  const gen = resolveToken({ env: {}, stateDir: state });
  assert.equal(gen.generated, true);
  assert.match(gen.token, HEX64);
  assert.equal(fs.readFileSync(tokenPath(state), 'utf8'), `${gen.token}\n`);
});

test('token: generated once; later starts read the saved one; the state folder is created', () => {
  const state = path.join(tmpDir(), 'a', 'state');
  const first = resolveToken({ env: {}, stateDir: state });
  const again = resolveToken({ env: {}, stateDir: state });
  assert.equal(first.generated, true);
  assert.equal(again.generated, false);
  assert.equal(again.token, first.token);
  assert.deepEqual(fs.readdirSync(state), ['token'], 'no temp file left');
});

test('token: without generation a missing token is an error that names both ways to get one', () => {
  const e = errorOf(() => resolveToken({ env: {}, stateDir: path.join(tmpDir(), 'state'), generate: false }));
  assert.equal(e.name, 'TokenError');
  assert.match(e.message, /no token yet: `cheap-eyes serve --http` generates one on its first start, or run `cheap-eyes token --new`/);
});

test('token: an invalid saved, env or file token is refused without being echoed', () => {
  const dir = tmpDir();
  fs.writeFileSync(tokenPath(dir), 'FAKE-bad saved token\n');
  const saved = errorOf(() => resolveToken({ env: {}, stateDir: dir }));
  assert.match(saved.message, /token in .*token: HTTP token .*; run `cheap-eyes token --new`/);
  assert.ok(!saved.message.includes('FAKE-bad'));
  const env = errorOf(() => resolveToken({ env: { CHEAP_EYES_HTTP_TOKEN: 'FAKE-short' }, stateDir: dir }));
  assert.match(env.message, /token from env CHEAP_EYES_HTTP_TOKEN: HTTP token too short/);
  assert.ok(!env.message.includes('FAKE-short'));
  const tf = path.join(dir, 'empty.txt');
  fs.writeFileSync(tf, '\n');
  assert.match(errorOf(() => resolveToken({ tokenFile: tf, env: {}, stateDir: dir })).message, /token from --token-file: HTTP token is empty/);
});

test('token --new replaces the saved token', () => {
  const state = path.join(tmpDir(), 'state');
  const a = resolveToken({ env: {}, stateDir: state }).token;
  const b = replaceToken(state);
  assert.notEqual(b.token, a);
  assert.match(b.token, HEX64);
  assert.equal(b.file, tokenPath(state));
  assert.equal(resolveToken({ env: {}, stateDir: state }).token, b.token);
  assert.deepEqual(connectionLines('T'), ['/private_T/mcp', 'Authorization: Bearer T']);
});

test('token file mode is 0600 on POSIX', { skip: process.platform === 'win32' ? 'file modes do not apply on Windows' : false }, () => {
  const state = path.join(tmpDir(), 'state');
  resolveToken({ env: {}, stateDir: state });
  assert.equal(fs.statSync(tokenPath(state)).mode & 0o777, 0o600);
  replaceToken(state);
  assert.equal(fs.statSync(tokenPath(state)).mode & 0o777, 0o600);
});

// ---- the commands ----

function setup() {
  const base = tmpDir();
  const state = path.join(base, 'state');
  const cfg = writeJson(path.join(base, 'cfg.json'), { read_roots: [base] });
  return { base, state, env: isolatedEnv(path.join(base, 'home'), { CHEAP_EYES_CONFIG: cfg, CHEAP_EYES_STATE_DIR: state }) };
}

function run(args, env) {
  const r = spawnSync(process.execPath, [...CLI_ARGS, ...args], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, encoding: 'utf8', timeout: 20000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('token command: nothing yet, --new, then the same two lines again', () => {
  const s = setup();
  const before = run(['token'], s.env);
  assert.equal(before.code, 1);
  assert.equal(before.stdout, '');
  assert.match(before.stderr, /no token yet/);
  const made = run(['token', '--new'], s.env);
  assert.equal(made.code, 0, made.stderr);
  const token = fs.readFileSync(tokenPath(s.state), 'utf8').trim();
  assert.match(token, HEX64);
  assert.equal(made.stdout, `/private_${token}/mcp\nAuthorization: Bearer ${token}\n`);
  assert.match(made.stderr, /new token saved to .*; a running server keeps accepting the old token until it is restarted; every connected client must be updated/);
  assert.ok(!made.stderr.includes(token), 'notes on stderr never carry the token');
  const shown = run(['token'], s.env);
  assert.equal(shown.code, 0);
  assert.equal(shown.stdout, made.stdout);
  assert.equal(shown.stderr, '');
});

test('token command: warns when env CHEAP_EYES_HTTP_TOKEN overrides the saved token', () => {
  const s = setup();
  run(['token', '--new'], s.env);
  const newer = run(['token', '--new'], { ...s.env, CHEAP_EYES_HTTP_TOKEN: ENV_TOKEN });
  assert.match(newer.stderr, /warning: env CHEAP_EYES_HTTP_TOKEN is set and takes precedence over the saved token; unset it/);
  const shown = run(['token'], { ...s.env, CHEAP_EYES_HTTP_TOKEN: ENV_TOKEN });
  assert.equal(shown.stdout, `/private_${ENV_TOKEN}/mcp\nAuthorization: Bearer ${ENV_TOKEN}\n`);
  assert.match(shown.stderr, /warning: env CHEAP_EYES_HTTP_TOKEN is set and overrides the token saved in /);
});

async function startServe(env) {
  const child = spawn(process.execPath, [...CLI_ARGS, 'serve', '--http', '--port', '0'], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (b) => (stderr += b));
  child.stdout.on('data', (b) => (stdout += b));
  for (let i = 0; i < 300 && !/on http 127\.0\.0\.1:\d+/.test(stderr); i++) await new Promise((r) => setTimeout(r, 50));
  // Let the whole start write arrive.
  await new Promise((r) => setTimeout(r, 200));
  const port = Number(/on http 127\.0\.0\.1:(\d+)/.exec(stderr)?.[1]);
  return {
    port,
    out: () => stdout + stderr,
    stop: async () => {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    },
  };
}

test('serve --http without a token generates one, shows it once, serves with it; a restart keeps it and does not print it', async () => {
  const s = setup();
  const first = await startServe(s.env);
  let token;
  try {
    token = fs.readFileSync(tokenPath(s.state), 'utf8').trim();
    assert.match(token, HEX64);
    const out = first.out();
    assert.ok(out.includes(`new HTTP token generated and saved to ${tokenPath(s.state)}`), out);
    assert.ok(out.includes(`claude.ai connector path: /private_${token}/mcp`), out);
    assert.ok(out.includes(`Bearer header: Authorization: Bearer ${token}`), out);
    assert.match(out, /shown once; `cheap-eyes token` shows it again/);
    assert.equal(out.split(token).length - 1, 2, 'the token appears exactly in the two lines');
    const res = await fetch(`http://127.0.0.1:${first.port}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    });
    assert.equal(res.status, 200);
    await fetch(`http://127.0.0.1:${first.port}/mcp`, { method: 'POST', headers: { authorization: 'Bearer FAKE-wrong-token-0123456789abcdefghijk' }, body: '{}' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(first.out().split(token).length - 1, 2, 'request logs never carry the token');
  } finally {
    await first.stop();
  }
  const second = await startServe(s.env);
  try {
    assert.match(second.out(), /on http 127\.0\.0\.1:\d+/);
    assert.ok(!second.out().includes(token), second.out());
    assert.ok(!second.out().includes('new HTTP token'), second.out());
  } finally {
    await second.stop();
  }
  assert.equal(fs.readFileSync(tokenPath(s.state), 'utf8').trim(), token, 'the restart kept the token');
  const check = run(['check-config'], s.env);
  assert.ok(!(check.stdout + check.stderr).includes(token), 'check-config never prints the token');
  assert.match(check.stdout, /http token: +saved in .*token \(`cheap-eyes token` prints it\)/);
});
