import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { CLI_ARGS, isolatedEnv, tmpDir, writeJson } from './helpers.js';

// Minimal JSON-RPC client over the server's stdio.
function startServer(env) {
  const child = spawn(process.execPath, CLI_ARGS, { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
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
    assert.deepEqual(run.inputSchema.required.sort(), ['files', 'mode', 'task']);
    assert.deepEqual(run.inputSchema.properties.mode.enum, ['extract', 'draft', 'edits']);
    assert.equal(run.inputSchema.additionalProperties, false);

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

test('stdio server refuses to start on a bad config', async () => {
  const s = setup();
  const srv = startServer({ ...s.env, CHEAP_EYES_CONFIG: path.join(s.base, 'nope.json') });
  const code = await new Promise((resolve) => srv.child.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(srv.stderr(), /CHEAP_EYES_CONFIG not found/);
});
