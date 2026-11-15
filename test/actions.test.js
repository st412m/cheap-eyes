// Refusal texts that end with the action (where a person changes the setting).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { configErrorAction, rootsAction, settingAction } from '../src/actions.js';
import { ConfigError, parseConfig } from '../src/config.js';
import { expandFiles } from '../src/input/files.js';
import { eyesStats } from '../src/stats.js';
import { tmpDir } from './helpers.js';

test('settingAction: settings UI first, then the variable the value came from, then cheap-eyes set', () => {
  assert.equal(settingAction('daily_budget_usd', { settingsUi: 'the extension settings in Claude Desktop', sources: { daily_budget_usd: 'env CHEAP_EYES_DAILY_BUDGET_USD' } }), 'set daily_budget_usd in the extension settings in Claude Desktop');
  assert.equal(
    settingAction('daily_budget_usd', { sources: { daily_budget_usd: 'env CHEAP_EYES_DAILY_BUDGET_USD' } }),
    'change the environment variable CHEAP_EYES_DAILY_BUDGET_USD where the server is started, and restart it',
  );
  assert.equal(settingAction('max_files', { sources: { max_files: 'file' } }, '<n>'), 'run `cheap-eyes set max_files <n>` and restart the server');
  assert.equal(settingAction('max_files'), 'run `cheap-eyes set max_files <value>` and restart the server');
});

test('rootsAction: UI, env with its separator, arguments, refused default, plain', () => {
  assert.equal(rootsAction({ settingsUi: 'the app options in Home Assistant' }), 'add a folder to read_roots in the app options in Home Assistant');
  assert.match(rootsAction({ sources: { read_roots: 'env CHEAP_EYES_READ_ROOTS' } }, ';'), /environment variable CHEAP_EYES_READ_ROOTS \(separator ";"\)/);
  assert.match(rootsAction({ sources: { read_roots: 'arguments' } }), /arguments the client starts cheap-eyes with/);
  assert.match(
    rootsAction({ sources: { read_roots: 'none' }, defaultRoot: { path: null, candidate: '/home/u', reason: 'it is the home directory' } }),
    /^the project folder \/home\/u is not used as a default \(it is the home directory\): open the client in a project folder, or run `cheap-eyes set read_roots <dir>\.\.\.`/,
  );
  assert.match(rootsAction(), /^run `cheap-eyes set read_roots <dir>\.\.\.` \(the whole list, one folder per argument\) and restart the server$/);
});

test('configErrorAction: missing file, variable, UI, JSON, invalid fields', () => {
  assert.match(configErrorAction(new ConfigError('x', { kind: 'config-missing', file: '/c.json' })), /create that file or unset CHEAP_EYES_CONFIG/);
  const env = new ConfigError('x', { kind: 'env', envVar: 'CHEAP_EYES_READ_ROOTS' });
  assert.match(configErrorAction(env), /fix the environment variable CHEAP_EYES_READ_ROOTS where the server is started/);
  assert.match(configErrorAction(env, 'the container environment'), /fix the value in the container environment \(environment variable CHEAP_EYES_READ_ROOTS\)/);
  assert.match(configErrorAction(new ConfigError('x', { kind: 'json', file: '/c.json' })), /fix the JSON in \/c\.json/);
  assert.match(configErrorAction(new ConfigError('x', { file: '/c.json' })), /fix the fields named above in \/c\.json, or run `cheap-eyes set <key> <value>`/);
});

test('path refusals: no read roots, and outside the roots with the roots in force and the action', async () => {
  const d = tmpDir();
  const root = path.join(d, 'notes');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(d, 'x.md'), 'x\n');
  const none = parseConfig({ read_roots: [] });
  await assert.rejects(expandFiles([path.join(d, 'x.md')], { config: none }), /no read roots: file paths are refused \(.*x\.md\); URLs work\. To add one: run `cheap-eyes set read_roots/);
  await assert.rejects(expandFiles([path.join(d, '*.md')], { config: none }), /no read roots: file paths are refused/);
  const some = parseConfig({ read_roots: [root] });
  await assert.rejects(
    expandFiles([path.join(d, 'x.md')], { config: some, rootsHint: 'add a folder to read_roots in the app options in Home Assistant' }),
    (e) => {
      assert.ok(e.message.includes(`outside read roots: ${path.join(d, 'x.md')}; read roots: ${root}. To add one: add a folder to read_roots in the app options in Home Assistant`), e.message);
      return true;
    },
  );
});

test('eyes_stats: the first lines say what is missing, each with the action', async () => {
  const d = tmpDir();
  const ctx = { config: parseConfig({ read_roots: [] }), stateDir: { path: path.join(d, 'state') }, resultsDir: path.join(d, 'state', 'results'), sources: { read_roots: 'none' } };
  const deny = async () => {
    throw new TypeError('offline');
  };
  const out = (await eyesStats({}, ctx, { key: null, fetch: deny })).split('\n');
  assert.equal(out[0], 'eyes_stats');
  assert.match(out[1], /^missing: read roots — file paths are refused, URLs work; to add one: run `cheap-eyes set read_roots/);
  assert.match(out[2], /^missing: OpenRouter key is not set/);
  const full = { ...ctx, config: parseConfig({ read_roots: [d] }) };
  const ok = (await eyesStats({}, full, { key: 'FAKE-key-not-real', fetch: deny })).split('\n');
  assert.ok(!ok.some((l) => l.startsWith('missing:')), ok.join('\n'));
});
