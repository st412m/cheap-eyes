// Fake keys and tokens only. scan-secrets:allow-file
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CLI_ARGS, isolatedEnv, tmpDir, writeJson } from './helpers.js';

const FAKE_KEY = 'sk-' + 'or-v1-FAKE-KEY-FOR-TESTS-0000000000000000';

function run(args, env, cwd) {
  const r = spawnSync(process.execPath, [...CLI_ARGS, ...args], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

function setup(cfg) {
  const base = tmpDir();
  const root = path.join(base, 'notes');
  const out = path.join(base, 'out');
  fs.mkdirSync(root);
  fs.mkdirSync(out);
  const file = writeJson(path.join(base, 'cfg', 'my.json'), typeof cfg === 'function' ? cfg({ root, out, base }) : cfg);
  const env = isolatedEnv(path.join(base, 'home'), {
    HOME: path.join(base, 'home'),
    USERPROFILE: path.join(base, 'home'),
    CHEAP_EYES_CONFIG: file,
    CHEAP_EYES_STATE_DIR: path.join(base, 'state'),
  });
  return { base, root, out, file, env };
}

test('check-config prints the winning file, roots, dirs, export, retention and aliases', () => {
  const s = setup(({ root, out }) => ({
    read_roots: [root],
    write_roots: [out],
    export_dir: path.join(out, 'eyes'),
    export_retention_days: 30,
    models: { fast: { ids: ['vendor/model-a', 'vendor/model-b'], params: { reasoning: { effort: 'none' } } } },
    defaults: { extract: 'fast' },
    daily_budget_usd: 2.5,
    deny_globs: ['*.sqlite'],
  }));
  const r = run(['check-config'], { ...s.env, CHEAP_EYES_OPENROUTER_KEY: FAKE_KEY }, s.base);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`config file:    ${s.file}  (env CHEAP_EYES_CONFIG)`), r.out);
  assert.ok(r.out.includes(`[1] ${s.root}`), r.out);
  assert.match(r.out, /\(dir\)/);
  assert.ok(r.out.includes(path.join(s.base, 'state')), r.out);
  assert.match(r.out, /env CHEAP_EYES_STATE_DIR; created on start/);
  assert.ok(r.out.includes(path.join(s.base, 'state', 'results')), r.out);
  assert.ok(r.out.includes(`export dir:     ${path.join(s.out, 'eyes')}`), r.out);
  assert.match(r.out, /results 14 d, max 500 MB; exports 30 d/);
  assert.match(r.out, /fast: vendor\/model-a, vendor\/model-b/);
  assert.match(r.out, /extract=fast/);
  assert.match(r.out, /openrouter key: set/);
  assert.match(r.out, /daily budget:\s+\$2\.5/);
  assert.match(r.out, /deny globs:\s+\.env\*  \*\.key .*node_modules\/\*\*  \*\.sqlite  \(built-in \+ 1 from config\)/);
  assert.ok(!r.out.includes(FAKE_KEY), 'the key must never be printed');
  assert.match(r.out, /\nOK$/m);
  assert.equal(fs.existsSync(path.join(s.base, 'state')), false, 'check-config must not create the state dir');
});

test('check-config: export off, key not set, file root', () => {
  const s = setup(({ base }) => {
    fs.writeFileSync(path.join(base, 'one.log'), 'x\n');
    return { read_roots: [path.join(base, 'one.log')] };
  });
  const r = run(['check-config'], s.env, s.base);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /export:\s+off/);
  assert.match(r.out, /\(file\)/);
  assert.match(r.out, /openrouter key: NOT set/);
  assert.match(r.out, /daily budget:\s+\$1\n/);
  assert.match(r.out, /deny globs:.*\(built-in\)\n/);
});

test('check-config: daily budget off with explicit null', () => {
  const s = setup(({ root }) => ({ read_roots: [root], daily_budget_usd: null }));
  const r = run(['check-config'], s.env, s.base);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /daily budget:\s+off \(null\)/);
});

test('check-config exits 1 on a missing read root and names it', () => {
  const s = setup(({ root, base }) => ({ read_roots: [root, path.join(base, 'gone')] }));
  const r = run(['check-config'], s.env, s.base);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes(`${path.join(s.base, 'gone')}  MISSING`), r.out);
});

test('check-config exits 1 on an invalid config and names the field', () => {
  const s = setup(({ root }) => ({ read_roots: [root], max_filez: 3 }));
  const r = run(['check-config'], s.env, s.base);
  assert.equal(r.code, 1);
  assert.match(r.out, /unknown field "max_filez"/);
  assert.ok(r.out.includes(s.file));
});

test('unknown command exits 2 with usage', () => {
  const r = run(['frobnicate'], {}, tmpDir());
  assert.equal(r.code, 2);
  assert.match(r.out, /Usage:/);
});

test('models command: flags are validated; without network it fails cleanly', () => {
  const s = setup(({ root }) => ({ read_roots: [root], models: { fast: { ids: ['vendor/model-a'] } } }));
  const bad = run(['models', '--candidates', '--max-price-in', 'cheap'], s.env, s.base);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /--max-price-in must be a positive number/);
  const r = run(['models', '--candidates'], s.env, s.base);
  assert.equal(r.code, 1);
  assert.match(r.out, /GET \/endpoints\/zdr: .*network is disabled in tests/);
});

test('check-config shows the HTTP bind default and the token state, never the token', () => {
  const s = setup(({ root }) => ({ read_roots: [root] }));
  const none = run(['check-config'], s.env, s.base);
  assert.match(none.out, /http serve: +default bind 127\.0\.0\.1 with localhost Host\/Origin checks; any other --host has none/);
  assert.match(none.out, /http token: +NOT set/);
  const good = 'FAKE-http-token-0123456789abcdefghijklmn';
  const set = run(['check-config'], { ...s.env, CHEAP_EYES_HTTP_TOKEN: good }, s.base);
  assert.match(set.out, /http token: +set \(env/);
  assert.ok(!set.out.includes(good));
  const shortTok = run(['check-config'], { ...s.env, CHEAP_EYES_HTTP_TOKEN: 'FAKE-short' }, s.base);
  assert.match(shortTok.out, /http token: +set but invalid: HTTP token too short/);
  assert.ok(!shortTok.out.includes('FAKE-short'));
});

test('check-config: proxy direct / set / ignored, never the proxy URL', () => {
  const s = setup(({ root }) => ({ read_roots: [root] }));
  const proxy = 'http://FAKE-user:FAKE-pass@proxy.example.com:3128';
  assert.match(run(['check-config'], s.env, s.base).out, /proxy: +direct$/m);
  const on = run(['check-config'], { ...s.env, HTTPS_PROXY: proxy, NODE_USE_ENV_PROXY: '1' }, s.base).out;
  assert.match(on, /proxy: +HTTPS_PROXY set$/m);
  assert.ok(!on.includes('proxy.example.com') && !on.includes('FAKE-pass'));
  const off = run(['check-config'], { ...s.env, HTTPS_PROXY: proxy }, s.base).out;
  assert.match(off, /proxy: +direct \(HTTPS_PROXY is set, but without NODE_USE_ENV_PROXY=1 Node ignores it\)/);
  assert.ok(!off.includes('proxy.example.com'));
});

test('proxyState: --use-env-proxy in NODE_OPTIONS, old Node 22', async () => {
  const { proxyState } = await import('../src/check-config.js');
  assert.equal(proxyState({ HTTPS_PROXY: 'x', NODE_OPTIONS: '--use-env-proxy' }, [], '24.5.0'), 'HTTPS_PROXY set');
  assert.match(proxyState({ HTTPS_PROXY: 'x', NODE_USE_ENV_PROXY: '1' }, [], '22.17.0'), /22\.17\.0 < 22\.21/);
  assert.equal(proxyState({}, ['--use-env-proxy'], '24.0.0'), 'direct');
});
