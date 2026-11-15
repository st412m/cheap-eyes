import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { CLI_ARGS, isolatedEnv, tmpDir, writeJson } from './helpers.js';

// Minimal JSON-RPC client over the server's stdio.
function startServer(env, cwd) {
  const child = spawn(process.execPath, CLI_ARGS, { cwd, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const nonJson = [];
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      nonJson.push(line);
      return;
    }
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  let next = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = next++;
      const t = setTimeout(() => reject(new Error(`timeout on ${method}; stderr: ${stderr}`)), 10000);
      pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const stop = () =>
    new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
      child.stdin.end();
    });
  return { child, request, notify, stop, nonJson, stderr: () => stderr };
}

function setup() {
  const base = tmpDir();
  const root = path.join(base, 'notes');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.md'), 'hello\npassword: hunter2\n');
  const file = writeJson(path.join(base, 'cfg.json'), {
    read_roots: [root],
    models: { fast: { ids: ['vendor/model-a'] } },
    defaults: { extract: 'fast' },
    max_context: 8000,
  });
  const state = path.join(base, 'state');
  return { base, root, state, env: isolatedEnv(path.join(base, 'home'), { CHEAP_EYES_CONFIG: file, CHEAP_EYES_STATE_DIR: state }) };
}

test('stdio server: three tools, stubs answer isError, id is validated, stdout stays JSON', async () => {
  const s = setup();
  const srv = startServer(s.env);
  try {
    const init = await srv.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    assert.equal(init.result.serverInfo.name, 'cheap-eyes');
    srv.notify('notifications/initialized');

    const list = await srv.request('tools/list', {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['eyes_result', 'eyes_run', 'eyes_stats']);
    const run = list.result.tools.find((t) => t.name === 'eyes_run');
    // task is optional for grep and schema; the handler checks it per mode.
    assert.deepEqual(run.inputSchema.required.sort(), ['files', 'mode']);
    assert.deepEqual(run.inputSchema.properties.mode.enum, ['extract', 'draft', 'edits', 'grep', 'schema']);
    assert.equal(run.inputSchema.additionalProperties, false);
    // Every tool carries a title and all four annotation hints.
    for (const tool of list.result.tools) {
      assert.equal(typeof tool.title, 'string', tool.name);
      assert.equal(tool.annotations.title, tool.title);
      for (const h of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof tool.annotations[h], 'boolean', `${tool.name}.${h}`);
    }

    const unknown = await srv.request('tools/call', { name: 'eyes_result', arguments: { id: '2026-09-26_120000-extract-abcdef' } });
    assert.equal(unknown.result.isError, true);
    assert.match(unknown.result.content[0].text, /unknown result id/);

    const stats = await srv.request('tools/call', { name: 'eyes_stats', arguments: {} });
    assert.equal(stats.result.isError, undefined, JSON.stringify(stats.result));
    assert.match(stats.result.content[0].text, /today \(UTC \d{4}-\d{2}-\d{2}\): jobs 0/);
    assert.match(stats.result.content[0].text, /budget: daily_budget_usd \$1/);
    assert.match(stats.result.content[0].text, /key: not set/);

    const live = await srv.request('tools/call', { name: 'eyes_run', arguments: { task: 't', mode: 'extract', files: [path.join(s.root, 'a.md')] } });
    assert.equal(live.result.isError, true);
    assert.match(live.result.content[0].text, /OpenRouter key is not set/);

    const badId = await srv.request('tools/call', { name: 'eyes_result', arguments: { id: '../x' } });
    assert.equal(badId.result.isError, true);
    assert.match(badId.result.content[0].text, /not a result id/);

    const online = await srv.request('tools/call', {
      name: 'eyes_run',
      arguments: { task: 't', mode: 'extract', files: ['/x'], model: "vendor/m:free:nitro" },
    });
    assert.equal(online.result.isError, true);
    assert.match(online.result.content[0].text, /":nitro" model variant is refused/);

    const dry = await srv.request('tools/call', {
      name: 'eyes_run',
      arguments: { task: 't', mode: 'extract', files: [path.join(s.root, 'a.md')], dry_run: true },
    });
    assert.equal(dry.result.isError, undefined, JSON.stringify(dry.result));
    assert.match(dry.result.content[0].text, /DRY RUN/);
    assert.ok(!dry.result.content[0].text.includes('hunter2'));
    const id = /result: (\S+)/.exec(dry.result.content[0].text)[1];
    assert.ok(fs.existsSync(path.join(s.state, 'results', `${id}.md`)));
    const read = await srv.request('tools/call', { name: 'eyes_result', arguments: { id, offset: 1, limit: 5 } });
    assert.equal(read.result.isError, undefined, JSON.stringify(read.result));
    assert.match(read.result.content[0].text, /^lines 1–5 of \d+; more: next offset 6\n--- untrusted model output ---\n\[/);

    const rel = await srv.request('tools/call', { name: 'eyes_run', arguments: { task: 't', mode: 'extract', files: ['a.md'], dry_run: true } });
    assert.equal(rel.result.isError, true);
    assert.match(rel.result.content[0].text, /eyes_run: relative path refused: a\.md/);

    assert.equal(fs.existsSync(path.join(s.state, 'results')), true, 'state dir and results/ are created on start');
  } finally {
    const code = await srv.stop();
    assert.equal(code, 0);
  }
  assert.deepEqual(srv.nonJson, [], 'nothing but JSON-RPC on stdout');
});

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } };

async function waitFor(srv, re) {
  for (let i = 0; i < 200 && !re.test(srv.stderr()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(srv.stderr(), re);
}

test('stdio with a broken settings file starts in the setup state: tools listed, every call names the field and the action', async () => {
  const s = setup();
  const bad = writeJson(path.join(s.base, 'bad.json'), { read_roots: [s.root], max_filez: 3 });
  const srv = startServer({ ...s.env, CHEAP_EYES_CONFIG: bad });
  try {
    await srv.request('initialize', INIT);
    srv.notify('notifications/initialized');
    const list = await srv.request('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['eyes_result', 'eyes_run', 'eyes_stats']);
    for (const name of ['eyes_run', 'eyes_result', 'eyes_stats']) {
      const args = name === 'eyes_run' ? { mode: 'grep', files: ['/x'], grep: { pattern: 'x' } } : name === 'eyes_result' ? { id: '2026-09-26_120000-extract-abcdef' } : {};
      const r = await srv.request('tools/call', { name, arguments: args });
      assert.equal(r.result.isError, true, name);
      const t = r.result.content[0].text;
      assert.match(t, /settings cannot be used: .*bad\.json: invalid config/s, name);
      assert.match(t, /unknown field "max_filez"/);
      assert.match(t, /to fix: fix the fields named above in .*bad\.json, or run `cheap-eyes set <key> <value>`/);
    }
    assert.match(srv.stderr(), /on stdio in setup state/);
  } finally {
    assert.equal(await srv.stop(), 0);
  }
  assert.deepEqual(srv.nonJson, []);
});

test('stdio setup state: CHEAP_EYES_CONFIG missing, and an invalid variable with a settings UI', async () => {
  const s = setup();
  const missing = startServer({ ...s.env, CHEAP_EYES_CONFIG: path.join(s.base, 'nope.json') });
  try {
    await missing.request('initialize', INIT);
    const r = await missing.request('tools/call', { name: 'eyes_stats', arguments: {} });
    assert.match(r.result.content[0].text, /CHEAP_EYES_CONFIG not found: .*nope\.json\nto fix: create that file or unset CHEAP_EYES_CONFIG/);
  } finally {
    assert.equal(await missing.stop(), 0);
  }
  const envBad = startServer({ ...s.env, CHEAP_EYES_DAILY_BUDGET_USD: 'lots', CHEAP_EYES_SETTINGS_UI: 'the extension settings in Claude Desktop' });
  try {
    await envBad.request('initialize', INIT);
    const r = await envBad.request('tools/call', { name: 'eyes_stats', arguments: {} });
    assert.match(r.result.content[0].text, /env CHEAP_EYES_DAILY_BUDGET_USD: must be a positive number/);
    assert.match(r.result.content[0].text, /to fix: fix the value in the extension settings in Claude Desktop \(environment variable CHEAP_EYES_DAILY_BUDGET_USD\)/);
  } finally {
    assert.equal(await envBad.stop(), 0);
  }
});

function noFileEnv(base, extra = {}) {
  return isolatedEnv(path.join(base, 'home'), { HOME: path.join(base, 'home'), USERPROFILE: path.join(base, 'home'), CHEAP_EYES_STATE_DIR: path.join(base, 'state'), ...extra });
}

test('stdio without a settings file starts with the project folder as the read root; a file job passes the root check', async () => {
  const base = tmpDir();
  const proj = path.join(base, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'a.md'), 'hello\n');
  const srv = startServer(noFileEnv(base, { CLAUDE_PROJECT_DIR: proj }));
  try {
    await srv.request('initialize', INIT);
    await waitFor(srv, /on stdio; settings file none; read roots: .* \(default: project folder\)/);
    assert.ok(srv.stderr().includes(`read roots: ${proj} (default: project folder)`), srv.stderr());
    const grep = await srv.request('tools/call', { name: 'eyes_run', arguments: { mode: 'grep', files: [path.join(proj, 'a.md')], grep: { pattern: 'hello' } } });
    assert.equal(grep.result.isError, undefined, JSON.stringify(grep.result));
    const live = await srv.request('tools/call', { name: 'eyes_run', arguments: { task: 't', mode: 'extract', files: [path.join(proj, 'a.md')] } });
    assert.match(live.result.content[0].text, /OpenRouter key is not set: set the environment variable CHEAP_EYES_OPENROUTER_KEY .*`cheap-eyes init`/);
  } finally {
    assert.equal(await srv.stop(), 0);
  }
});

test('stdio from the home folder: no default root, refusals and eyes_stats name the action', async () => {
  const base = tmpDir();
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'a.md'), 'hello\n');
  const srv = startServer(noFileEnv(base, { CLAUDE_PROJECT_DIR: home }));
  try {
    await srv.request('initialize', INIT);
    await waitFor(srv, /read roots: none \(the project folder .* is not used as a default: it is the home directory\)/);
    const r = await srv.request('tools/call', { name: 'eyes_run', arguments: { mode: 'grep', files: [path.join(home, 'a.md')], grep: { pattern: 'x' } } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /no read roots: file paths are refused .*URLs work\. To add one: the project folder .* is not used as a default \(it is the home directory\): open the client in a project folder, or run `cheap-eyes set read_roots <dir>\.\.\.`/);
    const stats = await srv.request('tools/call', { name: 'eyes_stats', arguments: {} });
    const lines = stats.result.content[0].text.split('\n');
    assert.match(lines[1], /^missing: read roots — file paths are refused, URLs work; to add one: /);
    assert.match(lines[2], /^missing: OpenRouter key is not set/);
  } finally {
    assert.equal(await srv.stop(), 0);
  }
});

test('stdio takes read roots as arguments; a bare word is still a command', async () => {
  const base = tmpDir();
  const a = path.join(base, 'serve');
  fs.mkdirSync(a);
  const child = spawn(process.execPath, [...CLI_ARGS, './serve', path.join(base, 'gone')], {
    cwd: base,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...noFileEnv(base) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  for (let i = 0; i < 200 && !/on stdio/.test(err); i++) await new Promise((r) => setTimeout(r, 50));
  child.stdin.end();
  await new Promise((r) => child.on('exit', r));
  assert.ok(err.includes(`read roots: ${a}, ${path.join(base, 'gone')} (arguments)`), err);
  assert.match(err, /warning: read root missing: .*gone/);
});
