// `cheap-eyes hook install [--project]` / `hook remove` on temporary settings files only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { hookCommand, hookScriptPath, inNpxCache, installHook, removeHook, settingsPath } from '../src/hook-install.js';
import { CLI_ARGS, tmpDir, writeJson } from './helpers.js';

function place() {
  const base = tmpDir();
  return { base, homedir: path.join(base, 'home'), cwd: path.join(base, 'project') };
}

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('install adds one PreToolUse entry for Read with the absolute path of this installation', () => {
  const p = place();
  const r = installHook({ homedir: p.homedir, cwd: p.cwd });
  assert.equal(r.file, path.join(p.homedir, '.claude', 'settings.json'));
  assert.equal(r.changed, true);
  const script = hookScriptPath();
  assert.ok(path.isAbsolute(script) && fs.existsSync(script));
  assert.equal(r.command, `node "${script.replace(/\\/g, '/')}"`);
  assert.deepEqual(read(r.file), { hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: r.command }] }] } });
  assert.deepEqual(fs.readdirSync(path.dirname(r.file)), ['settings.json'], 'written through a temporary file and a rename');
});

test('install is idempotent and keeps every other key; --project writes .claude/settings.json of the folder', () => {
  const p = place();
  const file = writeJson(settingsPath({ homedir: p.homedir }), {
    model: 'opus',
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] },
  });
  installHook({ homedir: p.homedir });
  const once = fs.readFileSync(file, 'utf8');
  const again = installHook({ homedir: p.homedir });
  assert.equal(again.changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), once, 'nothing rewritten');
  const json = read(file);
  assert.equal(json.model, 'opus');
  assert.deepEqual(json.permissions, { allow: ['Bash(ls:*)'] });
  assert.deepEqual(json.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo stop' }] }]);
  assert.deepEqual(json.hooks.PreToolUse.map((g) => g.matcher), ['Bash', 'Read']);
  const proj = installHook({ project: true, cwd: p.cwd, homedir: p.homedir });
  assert.equal(proj.file, path.join(p.cwd, '.claude', 'settings.json'));
  assert.ok(fs.existsSync(proj.file));
});

test('install replaces a cheap-eyes hook of another installation path', () => {
  const p = place();
  const file = writeJson(settingsPath({ homedir: p.homedir }), {
    hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'node /old/lib/node_modules/cheap-eyes/hooks/block-large-reads.js' }] }] },
  });
  const r = installHook({ homedir: p.homedir });
  assert.equal(r.replaced, 1);
  assert.deepEqual(read(file).hooks.PreToolUse, [{ matcher: 'Read', hooks: [{ type: 'command', command: hookCommand() }] }]);
});

test('a settings file that is not valid JSON is refused and left as it is', () => {
  const p = place();
  const file = settingsPath({ homedir: p.homedir });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ "model": "opus", }');
  assert.throws(() => installHook({ homedir: p.homedir }), /is not valid JSON; it was left as it is/);
  assert.throws(() => removeHook({ homedir: p.homedir }), /is not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "model": "opus", }');
});

test('remove takes out only the cheap-eyes hook; empty groups and lists go; a file without it is untouched', () => {
  const p = place();
  const file = writeJson(settingsPath({ homedir: p.homedir }), { theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] }] } });
  installHook({ homedir: p.homedir });
  assert.deepEqual(removeHook({ homedir: p.homedir }), { file, removed: 1 });
  assert.deepEqual(read(file), { theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] }] } });
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(removeHook({ homedir: p.homedir }), { file, removed: 0 });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const q = place();
  const only = installHook({ homedir: q.homedir });
  removeHook({ homedir: q.homedir });
  assert.deepEqual(read(only.file), {}, 'an emptied hooks object goes too');
  assert.deepEqual(removeHook({ homedir: place().homedir }).removed, 0, 'no file: nothing to do, nothing created');
});

test('install refuses to run from the npx cache', () => {
  const p = place();
  const script = path.join(p.base, 'npm-cache', '_npx', 'be907c71', 'node_modules', 'cheap-eyes', 'hooks', 'block-large-reads.js');
  assert.equal(inNpxCache(script), true);
  assert.equal(inNpxCache(hookScriptPath()), false);
  assert.throws(() => installHook({ homedir: p.homedir, script }), /runs from the npx cache .*: install it first with `npm install -g cheap-eyes`/);
  assert.equal(fs.existsSync(settingsPath({ homedir: p.homedir })), false);
});

test('the command: hook install and hook remove on a temporary home', () => {
  const p = place();
  fs.mkdirSync(p.cwd, { recursive: true });
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: p.homedir, USERPROFILE: p.homedir };
  const run = (args) => spawnSync(process.execPath, [...CLI_ARGS, 'hook', ...args], { env, cwd: p.cwd, encoding: 'utf8' });
  const inst = run(['install']);
  assert.equal(inst.status, 0, inst.stderr);
  assert.match(inst.stdout, /Added the hook in .*settings\.json:\n  PreToolUse, matcher Read: node ".*block-large-reads\.js"/);
  assert.match(run(['install']).stdout, /The hook is already in/);
  assert.match(run(['remove']).stdout, /Removed the hook from/);
  const proj = run(['install', '--project']);
  assert.ok(fs.existsSync(path.join(p.cwd, '.claude', 'settings.json')), proj.stdout + proj.stderr);
  assert.equal(run(['wipe']).status, 2);
});
