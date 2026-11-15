import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_DENY_GLOBS,
  ALLOWED_PARAMS,
  configCandidates,
  defaultReadRoot,
  defaultStateDir,
  loadConfig,
  parseConfig,
  readRootsFromEnv,
  resolveStateDir,
} from '../src/config.js';
import { isolatedEnv, tmpDir, writeJson } from './helpers.js';

const ROOT = process.platform === 'win32' ? 'C:\\data\\notes' : '/data/notes';

function setup() {
  const base = tmpDir();
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'cwd');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const userCfg =
    process.platform === 'win32'
      ? path.join(home, 'AppData', 'Roaming', 'cheap-eyes', 'config.json')
      : path.join(home, '.config', 'cheap-eyes', 'config.json');
  return { base, home, cwd, userCfg, env: isolatedEnv(home) };
}

function errorOf(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail('expected an error');
}

// ---- lookup order ----

test('lookup: env CHEAP_EYES_CONFIG wins over ./cheap-eyes.json and user config', () => {
  const s = setup();
  const envCfg = writeJson(path.join(s.base, 'elsewhere.json'), { read_roots: [ROOT], max_files: 1 });
  writeJson(path.join(s.cwd, 'cheap-eyes.json'), { read_roots: [ROOT], max_files: 2 });
  writeJson(s.userCfg, { read_roots: [ROOT], max_files: 3 });
  const r = loadConfig({ env: { ...s.env, CHEAP_EYES_CONFIG: envCfg }, cwd: s.cwd, homedir: s.home });
  assert.equal(r.file, envCfg);
  assert.equal(r.source, 'env CHEAP_EYES_CONFIG');
  assert.equal(r.config.max_files, 1);
});

test('lookup: ./cheap-eyes.json wins over user config', () => {
  const s = setup();
  writeJson(path.join(s.cwd, 'cheap-eyes.json'), { read_roots: [ROOT], max_files: 2 });
  writeJson(s.userCfg, { read_roots: [ROOT], max_files: 3 });
  const r = loadConfig({ env: s.env, cwd: s.cwd, homedir: s.home });
  assert.equal(r.config.max_files, 2);
  assert.equal(r.source, './cheap-eyes.json');
});

test('lookup: falls back to the per-user config', () => {
  const s = setup();
  writeJson(s.userCfg, { read_roots: [ROOT], max_files: 3 });
  const r = loadConfig({ env: s.env, cwd: s.cwd, homedir: s.home });
  assert.equal(r.file, s.userCfg);
  assert.equal(r.config.max_files, 3);
});

test('lookup: CHEAP_EYES_CONFIG pointing to a missing file is an error, not a fallback', () => {
  const s = setup();
  writeJson(path.join(s.cwd, 'cheap-eyes.json'), { read_roots: [ROOT] });
  const missing = path.join(s.base, 'missing.json');
  const e = errorOf(() => loadConfig({ env: { ...s.env, CHEAP_EYES_CONFIG: missing }, cwd: s.cwd, homedir: s.home }));
  assert.equal(e.name, 'ConfigError');
  assert.match(e.message, /CHEAP_EYES_CONFIG not found/);
});

test('lookup: no settings file is not an error; every field has its default', () => {
  const s = setup();
  const r = loadConfig({ env: s.env, cwd: s.cwd, homedir: s.home });
  assert.equal(r.file, null);
  assert.equal(r.source, null);
  assert.deepEqual(r.searched, [path.join(s.cwd, 'cheap-eyes.json'), s.userCfg]);
  assert.equal(r.writeTarget, s.userCfg, 'set writes the user settings file');
  assert.deepEqual(r.config.read_roots, []);
  assert.equal(r.sources.read_roots, 'none', 'no default root unless asked for (serve --http)');
  assert.equal(r.config.daily_budget_usd, 1.0);
  assert.equal(r.sources.daily_budget_usd, 'default');
  assert.equal(r.sources.max_files, 'default');
  assert.equal(r.settingsUi, null);
});

test('candidates per OS', () => {
  const win = configCandidates({ env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, cwd: 'C:\\work', platform: 'win32', homedir: 'C:\\Users\\u' });
  assert.deepEqual(
    win.map((c) => c.path),
    ['C:\\work\\cheap-eyes.json', 'C:\\Users\\u\\AppData\\Roaming\\cheap-eyes\\config.json'],
  );
  const winNoAppData = configCandidates({ env: {}, cwd: 'C:\\work', platform: 'win32', homedir: 'C:\\Users\\u' });
  assert.equal(winNoAppData[1].path, 'C:\\Users\\u\\AppData\\Roaming\\cheap-eyes\\config.json');
  const lin = configCandidates({ env: { CHEAP_EYES_CONFIG: 'rel.json' }, cwd: '/work', platform: 'linux', homedir: '/home/u' });
  assert.deepEqual(
    lin.map((c) => c.path),
    ['/work/rel.json', '/work/cheap-eyes.json', '/home/u/.config/cheap-eyes/config.json'],
  );
});

test('invalid JSON names the file and position but does not echo content', () => {
  const s = setup();
  const f = path.join(s.cwd, 'cheap-eyes.json');
  fs.writeFileSync(f, '{\n  "read_roots": ["x"],\n  "zzsecretzz" oops\n}');
  const e = errorOf(() => loadConfig({ env: s.env, cwd: s.cwd, homedir: s.home }));
  assert.match(e.message, /not valid JSON/);
  assert.ok(e.message.includes(f));
  assert.ok(!e.message.includes('zzsecretzz'));
});

test('UTF-8 BOM in the config file is accepted', () => {
  const s = setup();
  fs.writeFileSync(path.join(s.cwd, 'cheap-eyes.json'), '\uFEFF' + JSON.stringify({ read_roots: [ROOT] }));
  assert.equal(loadConfig({ env: s.env, cwd: s.cwd, homedir: s.home }).config.read_roots.length, 1);
});

// ---- defaults and validation ----

test('defaults are applied', () => {
  const c = parseConfig({ read_roots: ['/data'] }, { platform: 'linux' });
  assert.deepEqual(c.deny_globs, DEFAULT_DENY_GLOBS);
  assert.equal(c.results_retention_days, 14);
  assert.equal(c.results_max_mb, 500);
  assert.deepEqual(c.write_roots, []);
  assert.equal(c.export_dir, undefined);
  assert.equal(c.export_retention_days, 0);
  assert.deepEqual(c.models, {});
  assert.deepEqual(c.defaults, {});
  assert.equal(c.allow_raw_model_ids, false);
  assert.equal(c.max_file_bytes, 2 * 1024 * 1024);
  assert.equal(c.max_job_bytes, 5 * 1024 * 1024);
  assert.equal(c.max_files, 200);
  assert.equal(c.concurrency, 3);
  assert.equal(c.timeout_s, 180);
  assert.deepEqual(c.mask.extra_patterns, []);
  assert.equal(c.hook.max_bytes, 30720);
  assert.equal(c.time.default_tz, 'UTC');
  assert.equal(c.daily_budget_usd, 1.0);
  assert.equal(c.max_context, undefined);
});

function invalid(raw, platform = 'linux') {
  return errorOf(() => parseConfig(raw, { platform, file: 'cfg.json' })).message;
}

test('read_roots may be absent or empty', () => {
  assert.deepEqual(parseConfig({}, { platform: 'linux' }).read_roots, []);
  assert.deepEqual(parseConfig({ read_roots: [] }, { platform: 'linux' }).read_roots, []);
});

test('unknown fields are named, top-level and nested', () => {
  const msg = invalid({
    read_roots: ['/data'],
    bogus: 1,
    mask: { extra_patterns: [], nope: true },
    models: { fast: { ids: ['a/b'], idz: [] } },
  });
  assert.match(msg, /unknown field "bogus"/);
  assert.match(msg, /unknown field "mask\.nope"/);
  assert.match(msg, /unknown field "models\.fast\.idz"/);
});

test('type errors name the field', () => {
  assert.match(invalid({ read_roots: ['/data'], max_files: 'many' }), /field "max_files"/);
  assert.match(invalid({ read_roots: ['/data'], concurrency: 0 }), /field "concurrency"/);
  assert.match(invalid({ read_roots: ['/data'], export_retention_days: -1 }), /field "export_retention_days"/);
  assert.match(invalid({ read_roots: ['/data'], max_price_usd_per_mtok: { in: 1 } }), /field "max_price_usd_per_mtok\.out"/);
  assert.match(invalid({ read_roots: ['/data'], models: { fast: { ids: [] } } }), /field "models\.fast\.ids"/);
});

test('relative paths are refused', () => {
  assert.match(invalid({ read_roots: ['/data', 'notes'] }), /field "read_roots\[1\]": must be an absolute path/);
  assert.match(invalid({ read_roots: ['C:\\data', '\\notes'] }, 'win32'), /field "read_roots\[1\]"/);
  assert.match(invalid({ read_roots: ['C:\\data', 'C:notes'] }, 'win32'), /field "read_roots\[1\]": must be an absolute path/);
  assert.match(invalid({ read_roots: ['/data'], state_dir: 'state' }), /field "state_dir"/);
  assert.match(invalid({ read_roots: ['/data'], write_roots: ['out'] }), /field "write_roots\[0\]"/);
});

test('UNC read roots are accepted on windows', () => {
  const c = parseConfig({ read_roots: ['\\\\host\\share\\wiki'] }, { platform: 'win32' });
  assert.equal(c.read_roots[0], '\\\\host\\share\\wiki');
});

test('export_dir must lie inside write_roots, and needs write_roots', () => {
  assert.match(invalid({ read_roots: ['/data'], export_dir: '/out' }), /field "export_dir": export_dir needs write_roots/);
  assert.match(
    invalid({ read_roots: ['/data'], write_roots: ['/out'], export_dir: '/out-evil/x' }),
    /field "export_dir": must lie inside one of write_roots/,
  );
  const c = parseConfig({ read_roots: ['/data'], write_roots: ['/out'], export_dir: '/out/cheap' }, { platform: 'linux' });
  assert.equal(c.export_dir, '/out/cheap');
  const w = parseConfig({ read_roots: ['C:\\d'], write_roots: ['C:\\Out'], export_dir: 'c:\\out\\x' }, { platform: 'win32' });
  assert.equal(w.export_dir, 'c:\\out\\x');
});

test('defaults must reference defined aliases', () => {
  const msg = invalid({ read_roots: ['/data'], models: { fast: { ids: ['a/b'] } }, defaults: { draft: 'long' } });
  assert.match(msg, /field "defaults\.draft": alias "long" is not defined/);
  const c = parseConfig({ read_roots: ['/data'], models: { fast: { ids: ['a/b'] } }, defaults: { extract: 'fast' } }, { platform: 'linux' });
  assert.equal(c.defaults.extract, 'fast');
  assert.deepEqual(c.models.fast.params, {});
});

test('alias names are restricted, so they never look like raw model ids', () => {
  assert.match(invalid({ read_roots: ['/data'], models: { 'a/b': { ids: ['a/b'] } } }), /models/);
});

test('model params: only the allowed keys pass, as-is', () => {
  const params = {
    reasoning: { effort: 'none' },
    temperature: 0,
    top_p: 0.9,
    top_k: 40,
    min_p: 0.05,
    top_a: 0.1,
    seed: 42,
    frequency_penalty: 0,
    presence_penalty: 0,
    repetition_penalty: 1,
    stop: ['###'],
  };
  const c = parseConfig({ read_roots: ['/data'], models: { fast: { ids: ['a/b'], params } } }, { platform: 'linux' });
  assert.deepEqual(c.models.fast.params, params);
  assert.deepEqual(Object.keys(params).sort(), [...ALLOWED_PARAMS].sort());
});

test('model params: any other key is refused and named', () => {
  for (const k of ['prompt', 'service_tier', 'route', 'trace', 'plugins', 'provider', 'max_tokens', 'tools', 'models', 'debug']) {
    const msg = invalid({ read_roots: ['/data'], models: { fast: { ids: ['a/b'], params: { temperature: 0, [k]: 1 } } } });
    assert.ok(msg.includes(`field "models.fast.params.${k}": "${k}" is not allowed`), msg);
    assert.ok(!msg.includes('params.temperature'), msg);
  }
});

test('model ids: refused variant suffixes in any position, any case; :free passes', () => {
  for (const suffix of ['online', 'nitro', 'floor', 'exacto', 'thinking', 'extended']) {
    for (const id of [`vendor/m:${suffix}`, `vendor/m:${suffix.toUpperCase()}`, `vendor/m:free:${suffix}`]) {
      const msg = invalid({ read_roots: ['/data'], models: { fast: { ids: ['vendor/ok', id] } } });
      assert.ok(msg.includes(`field "models.fast.ids[1]": the ":${suffix}" model variant is refused`), msg);
    }
  }
  const ids = ['vendor/m:free', 'vendor/online-model', 'vendor/nitro-7b'];
  assert.deepEqual(parseConfig({ read_roots: ['/data'], models: { fast: { ids } } }, { platform: 'linux' }).models.fast.ids, ids);
});

test('daily_budget_usd: default 1.0, own value, explicit null switches it off', () => {
  assert.equal(parseConfig({ read_roots: ['/data'] }, { platform: 'linux' }).daily_budget_usd, 1.0);
  assert.equal(parseConfig({ read_roots: ['/data'], daily_budget_usd: 7.5 }, { platform: 'linux' }).daily_budget_usd, 7.5);
  assert.equal(parseConfig({ read_roots: ['/data'], daily_budget_usd: null }, { platform: 'linux' }).daily_budget_usd, null);
  assert.match(invalid({ read_roots: ['/data'], daily_budget_usd: 0 }), /field "daily_budget_usd"/);
  assert.match(invalid({ read_roots: ['/data'], daily_budget_usd: '1' }), /field "daily_budget_usd"/);
});

test('deny_globs from config are added to the built-in list, never replace it', () => {
  const c = parseConfig({ read_roots: ['/data'], deny_globs: ['*.sqlite', '*.pem'] }, { platform: 'linux' });
  assert.deepEqual(c.deny_globs, [...DEFAULT_DENY_GLOBS, '*.sqlite']);
  assert.deepEqual(parseConfig({ read_roots: ['/data'], deny_globs: [] }, { platform: 'linux' }).deny_globs, DEFAULT_DENY_GLOBS);
});

test('mask.extra_patterns must compile; time.default_tz must be a real zone', () => {
  assert.match(invalid({ read_roots: ['/data'], mask: { extra_patterns: ['ok', '(unclosed'] } }), /field "mask\.extra_patterns\[1\]": invalid regular expression/);
  assert.match(invalid({ read_roots: ['/data'], time: { default_tz: 'Mars/Olympus' } }), /field "time\.default_tz"/);
  assert.equal(parseConfig({ read_roots: ['/data'], time: { default_tz: 'Europe/Moscow' } }, { platform: 'linux' }).time.default_tz, 'Europe/Moscow');
});

// ---- state dir ----

test('state_dir default per OS', () => {
  assert.equal(
    defaultStateDir({ env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, platform: 'win32', homedir: 'C:\\Users\\u' }),
    'C:\\Users\\u\\AppData\\Local\\cheap-eyes',
  );
  assert.equal(defaultStateDir({ env: {}, platform: 'win32', homedir: 'C:\\Users\\u' }), 'C:\\Users\\u\\AppData\\Local\\cheap-eyes');
  assert.equal(defaultStateDir({ env: {}, platform: 'linux', homedir: '/home/u' }), '/home/u/.local/state/cheap-eyes');
  assert.equal(defaultStateDir({ env: {}, platform: 'darwin', homedir: '/Users/u' }), '/Users/u/.local/state/cheap-eyes');
});

test('state_dir: env CHEAP_EYES_STATE_DIR > config > default', () => {
  const cfg = parseConfig({ read_roots: ['/data'], state_dir: '/var/lib/ce' }, { platform: 'linux' });
  const opts = { platform: 'linux', homedir: '/home/u', cwd: '/' };
  assert.deepEqual(resolveStateDir(cfg, { ...opts, env: { CHEAP_EYES_STATE_DIR: '/data' } }), { path: '/data', source: 'env CHEAP_EYES_STATE_DIR' });
  assert.deepEqual(resolveStateDir(cfg, { ...opts, env: {} }), { path: '/var/lib/ce', source: 'config state_dir' });
  assert.deepEqual(resolveStateDir(cfg, { ...opts, env: { CHEAP_EYES_STATE_DIR: '' } }), { path: '/var/lib/ce', source: 'config state_dir' });
  const bare = parseConfig({ read_roots: ['/data'] }, { platform: 'linux' });
  assert.deepEqual(resolveStateDir(bare, { ...opts, env: {} }), { path: '/home/u/.local/state/cheap-eyes', source: 'default' });
});

test('loadConfig reports state and results dirs, env override applied', () => {
  const s = setup();
  writeJson(path.join(s.cwd, 'cheap-eyes.json'), { read_roots: [ROOT] });
  const stateDir = path.join(s.base, 'state');
  const r = loadConfig({ env: { ...s.env, CHEAP_EYES_STATE_DIR: stateDir }, cwd: s.cwd, homedir: s.home });
  assert.equal(r.stateDir.path, stateDir);
  assert.equal(r.resultsDir, path.join(stateDir, 'results'));
  assert.equal(fs.existsSync(stateDir), false, 'loading the config must not create anything');
});

// ---- sources without a file: environment, arguments, default root ----

test('env CHEAP_EYES_READ_ROOTS: platform delimiter, empty items dropped, wins over the file', () => {
  const s = setup();
  const a = path.join(s.base, 'a');
  const b = path.join(s.base, 'b');
  writeJson(path.join(s.cwd, 'cheap-eyes.json'), { read_roots: [ROOT] });
  const r = loadConfig({ env: { ...s.env, CHEAP_EYES_READ_ROOTS: `${a}${path.delimiter}${path.delimiter} ${b} ` }, cwd: s.cwd, homedir: s.home });
  assert.deepEqual(r.config.read_roots, [a, b]);
  assert.equal(r.sources.read_roots, 'env CHEAP_EYES_READ_ROOTS');
  const win = readRootsFromEnv({ CHEAP_EYES_READ_ROOTS: 'C:\\a;;D:\\b' }, 'win32');
  assert.deepEqual(win, ['C:\\a', 'D:\\b']);
  assert.deepEqual(readRootsFromEnv({ CHEAP_EYES_READ_ROOTS: '/a::/b' }, 'linux'), ['/a', '/b']);
});

test('env CHEAP_EYES_READ_ROOTS: a relative item is refused and the variable is named', () => {
  const e = errorOf(() => readRootsFromEnv({ CHEAP_EYES_READ_ROOTS: '/a:notes' }, 'linux'));
  assert.equal(e.name, 'ConfigError');
  assert.equal(e.envVar, 'CHEAP_EYES_READ_ROOTS');
  assert.match(e.message, /env CHEAP_EYES_READ_ROOTS: every item must be an absolute path \(separator ":"\): "notes"/);
});

test('env CHEAP_EYES_DAILY_BUDGET_USD: a number, "off" for null, anything else refused', () => {
  const s = setup();
  const load = (v) => loadConfig({ env: { ...s.env, CHEAP_EYES_DAILY_BUDGET_USD: v }, cwd: s.cwd, homedir: s.home });
  const r = load('2.5');
  assert.equal(r.config.daily_budget_usd, 2.5);
  assert.equal(r.sources.daily_budget_usd, 'env CHEAP_EYES_DAILY_BUDGET_USD');
  assert.equal(load('off').config.daily_budget_usd, null);
  assert.equal(load('OFF').config.daily_budget_usd, null);
  for (const bad of ['0', '-1', 'lots', '1e3']) {
    const e = errorOf(() => load(bad));
    assert.equal(e.envVar, 'CHEAP_EYES_DAILY_BUDGET_USD', bad);
    assert.match(e.message, /must be a positive number of USD or "off"/);
  }
});

test('an empty variable, or an unfilled launcher placeholder, means not set', () => {
  const s = setup();
  writeJson(path.join(s.cwd, 'cheap-eyes.json'), { read_roots: [ROOT], daily_budget_usd: 3 });
  for (const v of ['', '${user_config.read_roots}']) {
    const r = loadConfig({ env: { ...s.env, CHEAP_EYES_READ_ROOTS: v, CHEAP_EYES_DAILY_BUDGET_USD: v, CHEAP_EYES_SETTINGS_UI: v }, cwd: s.cwd, homedir: s.home });
    assert.equal(r.sources.read_roots, 'file');
    assert.equal(r.config.daily_budget_usd, 3);
    assert.equal(r.sources.daily_budget_usd, 'file');
    assert.equal(r.settingsUi, null);
  }
});

test('positional roots: resolved against the working directory, win over env and file', () => {
  const s = setup();
  writeJson(path.join(s.cwd, 'cheap-eyes.json'), { read_roots: [ROOT] });
  const r = loadConfig({ env: { ...s.env, CHEAP_EYES_READ_ROOTS: path.join(s.base, 'env') }, cwd: s.cwd, homedir: s.home, args: ['./serve', s.base] });
  assert.deepEqual(r.config.read_roots, [path.join(s.cwd, 'serve'), s.base]);
  assert.equal(r.sources.read_roots, 'arguments');
});

test('source labels: file, default, env; state_dir from env', () => {
  const s = setup();
  writeJson(path.join(s.cwd, 'cheap-eyes.json'), { read_roots: [ROOT], max_files: 9 });
  const r = loadConfig({ env: { ...s.env, CHEAP_EYES_STATE_DIR: path.join(s.base, 'st'), CHEAP_EYES_SETTINGS_UI: 'the extension settings' }, cwd: s.cwd, homedir: s.home });
  assert.equal(r.sources.max_files, 'file');
  assert.equal(r.sources.read_roots, 'file');
  assert.equal(r.sources.concurrency, 'default');
  assert.equal(r.sources.state_dir, 'env CHEAP_EYES_STATE_DIR');
  assert.equal(r.settingsUi, 'the extension settings');
  assert.equal(r.writeTarget, path.join(s.cwd, 'cheap-eyes.json'), 'set writes the file in force');
});

test('an explicit empty read_roots in the file counts as given: no default root', () => {
  const s = setup();
  writeJson(path.join(s.cwd, 'cheap-eyes.json'), { read_roots: [] });
  const proj = path.join(s.base, 'proj');
  fs.mkdirSync(proj);
  const r = loadConfig({ env: { ...s.env, CLAUDE_PROJECT_DIR: proj }, cwd: s.cwd, homedir: s.home, defaultRoot: true });
  assert.deepEqual(r.config.read_roots, []);
  assert.equal(r.sources.read_roots, 'file');
});

test('default root: CLAUDE_PROJECT_DIR when absolute and existing, else the working directory', () => {
  const s = setup();
  const proj = path.join(s.base, 'proj');
  fs.mkdirSync(proj);
  const withProj = loadConfig({ env: { ...s.env, CLAUDE_PROJECT_DIR: proj }, cwd: s.cwd, homedir: s.home, defaultRoot: true });
  assert.deepEqual(withProj.config.read_roots, [proj]);
  assert.equal(withProj.sources.read_roots, 'default: project folder');
  assert.equal(withProj.defaultRoot.from, 'CLAUDE_PROJECT_DIR');
  for (const bad of ['relative/proj', path.join(s.base, 'missing')]) {
    const r = loadConfig({ env: { ...s.env, CLAUDE_PROJECT_DIR: bad }, cwd: s.cwd, homedir: s.home, defaultRoot: true });
    assert.deepEqual(r.config.read_roots, [s.cwd], bad);
    assert.equal(r.defaultRoot.from, 'working directory');
  }
});

test('default root: the home directory, an ancestor of it and a root are refused; the server has none', () => {
  const s = setup();
  for (const cwd of [s.home, s.base, path.parse(s.base).root]) {
    const r = loadConfig({ env: s.env, cwd, homedir: s.home, defaultRoot: true });
    assert.deepEqual(r.config.read_roots, [], cwd);
    assert.equal(r.sources.read_roots, 'none');
    assert.equal(r.defaultRoot.path, null);
  }
  assert.match(defaultReadRoot({ env: {}, cwd: s.home, homedir: s.home }).reason, /home directory/);
  assert.match(defaultReadRoot({ env: {}, cwd: s.base, homedir: s.home }).reason, /contains the home directory/);
  // A folder below home is fine.
  assert.equal(defaultReadRoot({ env: {}, cwd: s.cwd, homedir: s.base }).path, s.cwd);
});

test('default root: Windows drive root and UNC share root refused (platform parameter)', () => {
  const deps = { platform: 'win32', homedir: 'C:\\Users\\u', realpath: (p) => p, isDir: () => true };
  assert.match(defaultReadRoot({ ...deps, env: {}, cwd: 'D:\\' }).reason, /drive root/);
  assert.match(defaultReadRoot({ ...deps, env: {}, cwd: '\\\\host\\share\\' }).reason, /drive root/);
  assert.match(defaultReadRoot({ ...deps, env: {}, cwd: 'c:\\users' }).reason, /contains the home directory/);
  assert.match(defaultReadRoot({ ...deps, env: {}, cwd: 'C:\\USERS\\U' }).reason, /is the home directory/);
  assert.deepEqual(defaultReadRoot({ ...deps, env: { CLAUDE_PROJECT_DIR: 'C:\\Users\\u\\proj' }, cwd: 'C:\\' }), { path: 'C:\\Users\\u\\proj', from: 'CLAUDE_PROJECT_DIR' });
  const posix = { platform: 'linux', homedir: '/home/u', realpath: (p) => p, isDir: () => true };
  assert.match(defaultReadRoot({ ...posix, env: {}, cwd: '/' }).reason, /filesystem root/);
  assert.match(defaultReadRoot({ ...posix, env: {}, cwd: '/home' }).reason, /contains the home directory/);
  assert.equal(defaultReadRoot({ ...posix, env: {}, cwd: '/srv/work' }).path, '/srv/work');
});

test('default root: symlinks are resolved before the check', () => {
  const s = setup();
  const link = path.join(s.base, 'to-home');
  try {
    fs.symlinkSync(s.home, link, 'junction');
  } catch {
    return; // no symlink rights on this machine
  }
  assert.match(defaultReadRoot({ env: {}, cwd: link, homedir: s.home }).reason, /home directory/);
});

test('serve has no default root: without defaultRoot nothing is chosen', () => {
  const s = setup();
  const proj = path.join(s.base, 'proj');
  fs.mkdirSync(proj);
  const r = loadConfig({ env: { ...s.env, CLAUDE_PROJECT_DIR: proj }, cwd: s.cwd, homedir: s.home });
  assert.deepEqual(r.config.read_roots, []);
  assert.equal(r.defaultRoot, null);
});

test('the example of docs/configuration.md is a valid config with no real model id; $comment is accepted and ignored', () => {
  const doc = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'configuration.md'), 'utf8');
  const block = /A short example[\s\S]*?```json\n([\s\S]*?)\n```/.exec(doc)?.[1];
  assert.ok(block, 'the example block is in docs/configuration.md');
  const raw = JSON.parse(block);
  const cfg = parseConfig({ ...raw, $comment: 'ignored' }, { platform: 'linux' });
  assert.deepEqual(Object.keys(cfg.models), ['fast']);
  assert.deepEqual(cfg.models.fast.params, { reasoning: { effort: 'none' } });
  assert.ok(cfg.models.fast.ids.every((id) => !id.includes('/')), 'a placeholder, not an OpenRouter id');
  assert.ok(!fs.existsSync(path.join(import.meta.dirname, '..', 'cheap-eyes.example.json')));
  assert.throws(() => parseConfig({ ...raw, $comment: 5 }, { platform: 'linux' }), /field "\$comment"/);
});
