// `cheap-eyes set`: every kind of key, removal, validation, secrets. Fake keys only. scan-secrets:allow-file
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SETTING_KEYS } from '../src/config.js';
import { applySetting, missingFolders, SETTABLE, writeSetting } from '../src/set.js';
import { CLI_ARGS, isolatedEnv, tmpDir, writeJson } from './helpers.js';

const FAKE_KEY = 'sk-' + 'or-v1-FAKE-KEY-FOR-TESTS-0000000000000000';
const L = { platform: 'linux', cwd: '/work' };

function errorOf(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail('expected an error');
}

test('set: every scalar top-level field is settable', () => {
  const lists = new Set(['read_roots', 'deny_globs', 'write_roots']);
  const objects = new Set(['models', 'defaults', 'max_price_usd_per_mtok', 'mask', 'hook', 'time']);
  for (const k of SETTING_KEYS) {
    if (objects.has(k)) continue;
    assert.ok(SETTABLE.includes(k), `${k} is settable`);
  }
  for (const k of lists) assert.ok(SETTABLE.includes(k));
  for (const k of ['defaults.extract', 'defaults.draft', 'defaults.edits', 'defaults.schema', 'time.default_tz', 'hook.max_bytes', 'max_price_usd_per_mtok', 'max_price_usd_per_mtok.in', 'max_price_usd_per_mtok.out', 'models.<alias>']) {
    assert.ok(SETTABLE.includes(k), k);
  }
});

test('set: values of each kind', () => {
  const v = (key, ...words) => applySetting({}, key, words, L).next;
  assert.deepEqual(v('read_roots', '/a', 'notes', 'ünïcode dir'), { read_roots: ['/a', '/work/notes', '/work/ünïcode dir'] });
  assert.deepEqual(v('write_roots', '/out'), { write_roots: ['/out'] });
  assert.deepEqual(v('deny_globs', '*.sqlite', 'private/**'), { deny_globs: ['*.sqlite', 'private/**'] });
  assert.deepEqual(v('state_dir', 'st'), { state_dir: '/work/st' });
  assert.deepEqual(v('max_files', '50'), { max_files: 50 });
  assert.deepEqual(v('daily_budget_usd', '2.5'), { daily_budget_usd: 2.5 });
  assert.deepEqual(v('daily_budget_usd', 'off'), { daily_budget_usd: null });
  assert.deepEqual(v('url_input', 'off'), { url_input: false });
  assert.deepEqual(v('allow_raw_model_ids', 'on'), { allow_raw_model_ids: true });
  assert.deepEqual(v('url_contact', 'me@example.org'), { url_contact: 'me@example.org' });
  assert.deepEqual(v('time.default_tz', 'Europe/Moscow'), { time: { default_tz: 'Europe/Moscow' } });
  assert.deepEqual(v('hook.max_bytes', '1000'), { hook: { max_bytes: 1000 } });
  assert.deepEqual(v('defaults.extract', 'fast'), { defaults: { extract: 'fast' } });
  assert.deepEqual(v('models.fast', 'v/a,v/b', 'v/c'), { models: { fast: { ids: ['v/a', 'v/b', 'v/c'], params: { reasoning: { effort: 'none' } } } } });
  // An alias edited by hand keeps its params; only the ids change.
  const kept = applySetting({ models: { fast: { ids: ['v/a'], params: { temperature: 0 } } } }, 'models.fast', ['v/z'], L).next;
  assert.deepEqual(kept.models.fast, { ids: ['v/z'], params: { temperature: 0 } });
  const cap = applySetting({ max_price_usd_per_mtok: { in: 1, out: 4 } }, 'max_price_usd_per_mtok.in', ['0.5'], L).next;
  assert.deepEqual(cap, { max_price_usd_per_mtok: { in: 0.5, out: 4 } });
});

test('set: bad words are refused before validation, with the key', () => {
  assert.match(errorOf(() => applySetting({}, 'max_files', ['many'], L)).message, /max_files takes a number, got "many"/);
  assert.match(errorOf(() => applySetting({}, 'url_input', ['maybe'], L)).message, /url_input takes on or off/);
  assert.match(errorOf(() => applySetting({}, 'url_contact', ['a', 'b'], L)).message, /takes one value \(quote it/);
  assert.match(errorOf(() => applySetting({}, 'nope', ['1'], L)).message, /unknown setting "nope"; settings: /);
  assert.match(errorOf(() => applySetting({}, 'models.fast', [','], L)).message, /model ids separated by commas/);
});

test('set: no value removes the key; an emptied nested object goes too', () => {
  const cur = { read_roots: ['/a'], time: { default_tz: 'UTC' }, models: { fast: { ids: ['v/a'] }, slow: { ids: ['v/b'] } } };
  assert.deepEqual(applySetting(cur, 'read_roots', [], L).next, { time: { default_tz: 'UTC' }, models: cur.models });
  assert.deepEqual(applySetting(cur, 'time.default_tz', [], L).next, { read_roots: ['/a'], models: cur.models });
  assert.deepEqual(applySetting(cur, 'models.fast', [], L).next.models, { slow: { ids: ['v/b'] } });
  assert.deepEqual(cur.time, { default_tz: 'UTC' }, 'the input is not changed');
});

test('set: a result that does not validate writes nothing and names the field', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sub', 'config.json');
  const e1 = errorOf(() => writeSetting(file, 'concurrency', ['0'], { env: {} }));
  assert.match(e1.message, /field "concurrency"/);
  assert.equal(fs.existsSync(file), false, 'nothing created');
  writeJson(file, { read_roots: [dir], models: { fast: { ids: ['v/a'] } }, defaults: { extract: 'fast' } });
  const before = fs.readFileSync(file, 'utf8');
  assert.match(errorOf(() => writeSetting(file, 'models.fast', [], { env: {} })).message, /field "defaults\.extract": alias "fast" is not defined/);
  assert.match(errorOf(() => writeSetting(file, 'defaults.draft', ['long'], { env: {} })).message, /field "defaults\.draft"/);
  assert.match(errorOf(() => writeSetting(file, 'time.default_tz', ['Mars/Olympus'], { env: {} })).message, /field "time\.default_tz"/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'file unchanged');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.json'], 'no temp file left');
});

test('set: creates the folder and the file; keeps every other key', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a', 'b', 'config.json');
  const r = writeSetting(file, 'max_files', ['7'], { env: {} });
  assert.deepEqual(r, { file, value: 7, removed: false });
  writeSetting(file, 'url_contact', ['me@example.org'], { env: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { max_files: 7, url_contact: 'me@example.org' });
});

test('set: never a secret, by key or by value; nothing written', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  for (const key of ['openrouter_key', 'key', 'http_token', 'token', 'api_key']) {
    const e = errorOf(() => writeSetting(file, key, ['x'], { env: {} }));
    assert.match(e.message, /secrets never go into the settings file/, key);
  }
  const byValue = errorOf(() => writeSetting(file, 'url_contact', [FAKE_KEY], { env: {} }));
  assert.match(byValue.message, /looks like the OpenRouter key or the HTTP token/);
  assert.ok(!byValue.message.includes(FAKE_KEY));
  const token = 'FAKE-http-token-0123456789abcdefghijklmn';
  assert.throws(() => writeSetting(file, 'deny_globs', [token], { env: { CHEAP_EYES_HTTP_TOKEN: token } }), /looks like/);
  assert.equal(fs.existsSync(file), false);
});

test('set max_price_usd_per_mtok <in> <out>: both halves on a file without a cap; removal', () => {
  const dir = tmpDir();
  const file = writeJson(path.join(dir, 'config.json'), { max_files: 5 });
  const r = writeSetting(file, 'max_price_usd_per_mtok', ['1', '4'], { env: {} });
  assert.deepEqual(r.value, { in: 1, out: 4 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { max_files: 5, max_price_usd_per_mtok: { in: 1, out: 4 } });
  writeSetting(file, 'max_price_usd_per_mtok.out', ['3.5'], { env: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).max_price_usd_per_mtok, { in: 1, out: 3.5 });
  const rm = writeSetting(file, 'max_price_usd_per_mtok', [], { env: {} });
  assert.equal(rm.removed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { max_files: 5 });
});

test('set max_price_usd_per_mtok: one number, three numbers or a word are refused with the usage; nothing filled in', () => {
  const dir = tmpDir();
  const file = writeJson(path.join(dir, 'config.json'), {});
  for (const words of [['1'], ['1', '4', '5'], ['cheap', '4']]) {
    const e = errorOf(() => writeSetting(file, 'max_price_usd_per_mtok', words, { env: {} }));
    assert.match(e.message, /max_price_usd_per_mtok takes two numbers, in then out \(USD per 1M tokens\): cheap-eyes set max_price_usd_per_mtok <in> <out>/, words.join(' '));
  }
  // One half on a file without a cap is not completed with a made-up other half.
  assert.match(errorOf(() => writeSetting(file, 'max_price_usd_per_mtok.in', ['1'], { env: {} })).message, /field "max_price_usd_per_mtok\.out"/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
});

test('set: a failed rename removes the temporary file and rethrows', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  const boom = Object.assign(new Error('rename refused'), { code: 'EPERM' });
  const e = errorOf(() =>
    writeSetting(file, 'max_files', ['3'], {
      env: {},
      rename: () => {
        throw boom;
      },
    }),
  );
  assert.equal(e, boom);
  assert.deepEqual(fs.readdirSync(dir), [], 'no temp file, no settings file');
});

test('missingFolders: only folder keys, only folders that do not exist', () => {
  const dir = tmpDir();
  const gone = path.join(dir, 'gone');
  assert.deepEqual(missingFolders('read_roots', [dir, gone]), [gone]);
  assert.deepEqual(missingFolders('write_roots', [gone]), [gone]);
  assert.deepEqual(missingFolders('export_dir', gone), [gone]);
  assert.deepEqual(missingFolders('state_dir', dir), []);
  assert.deepEqual(missingFolders('deny_globs', ['gone/**']), []);
  assert.deepEqual(missingFolders('read_roots', undefined), []);
});

// ---- the command ----

function run(args, env, cwd) {
  const r = spawnSync(process.execPath, [...CLI_ARGS, ...args], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

function cliSetup() {
  const base = tmpDir();
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const userCfg = process.platform === 'win32' ? path.join(home, 'AppData', 'Roaming', 'cheap-eyes', 'config.json') : path.join(home, '.config', 'cheap-eyes', 'config.json');
  return { base, cwd, userCfg, env: isolatedEnv(home, { HOME: home, USERPROFILE: home }) };
}

test('set command: writes the user settings file, says where and that a restart is needed', () => {
  const s = cliSetup();
  const dir = path.join(s.base, 'ünïcode notes');
  const r = run(['set', 'read_roots', dir], s.env, s.cwd);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`read_roots = ${JSON.stringify([dir])} written to ${s.userCfg}`), r.out);
  assert.match(r.out, /after a restart \(over stdio: restart the client/);
  assert.match(r.out, /arguments .* override this list/);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.userCfg, 'utf8')), { read_roots: [dir] });
  const check = run(['check-config'], s.env, s.cwd);
  assert.ok(check.out.includes(`settings file:  ${s.userCfg}  (user config`), check.out);
  assert.ok(check.out.includes(`[1] ${dir}`), check.out);
  const rm = run(['set', 'read_roots'], s.env, s.cwd);
  assert.equal(rm.code, 0, rm.out);
  assert.match(rm.out, /read_roots removed from .*\nthe default applies: on stdio the project folder/);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.userCfg, 'utf8')), {});
});

test('set command: a folder that does not exist is written anyway, with a warning naming it', () => {
  const s = cliSetup();
  const gone = path.join(s.base, 'not-yet');
  for (const [key, args] of [
    ['read_roots', [s.base, gone]],
    ['write_roots', [gone]],
    ['state_dir', [gone]],
  ]) {
    const r = run(['set', key, ...args], s.env, s.cwd);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.out.includes(`warning: folder does not exist: ${gone} (written anyway)`), `${key}: ${r.out}`);
    assert.ok(!r.out.includes(`folder does not exist: ${s.base} `), r.out);
  }
  const exp = run(['set', 'export_dir', path.join(gone, 'eyes')], s.env, s.cwd);
  assert.equal(exp.code, 0, exp.out);
  assert.ok(exp.out.includes(`warning: folder does not exist: ${path.join(gone, 'eyes')} (written anyway)`), exp.out);
  const saved = JSON.parse(fs.readFileSync(s.userCfg, 'utf8'));
  assert.deepEqual(saved.read_roots, [s.base, gone]);
  assert.equal(saved.state_dir, gone);
});

test('set command: warns when an environment variable overrides the key', () => {
  const s = cliSetup();
  const r = run(['set', 'daily_budget_usd', '3'], { ...s.env, CHEAP_EYES_DAILY_BUDGET_USD: 'off' }, s.cwd);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /warning: env CHEAP_EYES_DAILY_BUDGET_USD is set and overrides the settings file: the server keeps using null/);
  const roots = run(['set', 'read_roots', s.base], { ...s.env, CHEAP_EYES_READ_ROOTS: s.cwd }, s.cwd);
  assert.match(roots.out, /warning: env CHEAP_EYES_READ_ROOTS is set and overrides the settings file/);
});

test('set command: ./cheap-eyes.json in force is the file written, and it says so', () => {
  const s = cliSetup();
  const local = writeJson(path.join(s.cwd, 'cheap-eyes.json'), { max_files: 3 });
  const r = run(['set', 'max_files', '4'], s.env, s.cwd);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`is the settings file in force here (./cheap-eyes.json)`), r.out);
  assert.deepEqual(JSON.parse(fs.readFileSync(local, 'utf8')), { max_files: 4 });
  assert.equal(fs.existsSync(s.userCfg), false);
});

test('set command: a validation failure exits 1, names the field and writes nothing; no name is a usage error', () => {
  const s = cliSetup();
  const r = run(['set', 'concurrency', '0'], s.env, s.cwd);
  assert.equal(r.code, 1);
  assert.match(r.out, /field "concurrency"/);
  assert.match(r.out, /nothing was written/);
  assert.equal(fs.existsSync(s.userCfg), false);
  const none = run(['set'], s.env, s.cwd);
  assert.equal(none.code, 2);
  assert.match(none.out, /set needs a setting name: /);
  const secret = run(['set', 'openrouter_key', FAKE_KEY], s.env, s.cwd);
  assert.equal(secret.code, 1);
  assert.ok(!secret.out.includes(FAKE_KEY));
});
