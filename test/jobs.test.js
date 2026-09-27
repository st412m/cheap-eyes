// Step 3 end to end on a mocked fetch: checks in the header, async registry, cancel,
// failed jobs saved, empty-output hint, export, pass rate in stats.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { Ledger } from '../src/budget.js';
import { parseConfig } from '../src/config.js';
import { clearCatalogCache } from '../src/openrouter.js';
import { eyesResult } from '../src/result-tool.js';
import { readCheck, running } from '../src/results.js';
import { emptyOutputHint, eyesRun } from '../src/run.js';
import { eyesStats } from '../src/stats.js';
import { tmpDir } from './helpers.js';

const KEY = 'sk-' + 'or-v1-FAKE0000000000000000000000000000000000000000000000000000'; // fake, scan-secrets:allow
const ZDR = [{ model_id: 'v/a', provider_name: 'P', context_length: 32000, max_completion_tokens: 4096, pricing: { prompt: '0.0000002', completion: '0.0000004', request: '0' } }];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function chatOk(content, { finish = 'stop', cost = 0.0001 } = {}) {
  return json({ id: 'g', object: 'chat.completion', created: 1, model: 'v/a', choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }], usage: { prompt_tokens: 50, completion_tokens: 10, cost } });
}

function mockFetch(onChat) {
  let n = 0;
  return async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/endpoints/zdr')) return json({ data: ZDR });
    if (u.endsWith('/chat/completions')) return onChat(JSON.parse(init.body), ++n, init);
    throw new Error(`unexpected ${u}`);
  };
}

// A chat call that never answers until its request is aborted.
function hang(init) {
  return new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

function setup(extra = {}) {
  const d = tmpDir();
  const root = path.join(d, 'notes');
  const out = path.join(d, 'out');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const config = parseConfig({
    read_roots: [root],
    models: { fast: { ids: ['v/a'] } },
    defaults: { extract: 'fast', draft: 'fast', edits: 'fast' },
    ...extra(root, out),
  });
  const stateDir = path.join(d, 'state');
  const ctx = { config, stateDir: { path: stateDir }, resultsDir: path.join(stateDir, 'results') };
  return { d, root, out, config, ctx, stateDir, ledger: new Ledger(stateDir) };
}

const noExtra = () => ({});

function deps(s, fetch, more = {}) {
  return { key: KEY, fetch, ledger: s.ledger, sleep: async () => {}, ...more };
}

beforeEach(() => clearCatalogCache());

test('header carries the check summary and the first bad items; usage records the check', async () => {
  const s = setup(noExtra);
  const f = write(path.join(s.root, 'a.md'), 'alpha one\nbeta two\n');
  const r = await eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mockFetch(() => chatOk('L1| alpha one\nL2| beta TWO\nL9| invented'))));
  assert.match(r.header, /check \(extract\): refs ok 1 \/ bad 2 — ok 1, ok~ 0, partial 0, not-in-input 0/);
  assert.match(r.header, /L2 \[bad\] text differs from the source line/);
  assert.match(r.header, /L9 \[bad\] line not in this chunk's input/);
  const rec = JSON.parse(fs.readFileSync(path.join(s.stateDir, 'usage.jsonl'), 'utf8').trim());
  assert.equal(rec.check.mode, 'extract');
  assert.equal(rec.check.bad, 2);
  assert.ok(Math.abs(rec.check.pass_rate - 1 / 3) < 1e-9);
  const check = await readCheck(s.ctx.resultsDir, r.id);
  assert.equal(check.checks.summary.refs_bad, 2);
  const report = await eyesResult({ id: r.id, check: true }, s.ctx);
  assert.match(report.split('\n')[3], /"status":"bad"/);
  const stats = await eyesStats({ models: true }, s.ctx, deps(s, mockFetch(() => assert.fail())));
  assert.match(stats, /check pass extract 33% \(1\)/);
});

test('empty output with finish_reason length: a hint in the header and in check.json', async () => {
  const s = setup(noExtra);
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const r = await eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mockFetch(() => chatOk('', { finish: 'length' }))));
  const hint = emptyOutputHint(1);
  assert.equal(hint, 'chunk 1: empty output, max_completion_tokens spent on reasoning — set params.reasoning.effort "none" for this alias or raise max_tokens');
  assert.ok(r.header.includes(hint), r.header);
  const check = await readCheck(s.ctx.resultsDir, r.id);
  assert.equal(check.chunks[0].hint, hint);
  const plain = await eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mockFetch(() => chatOk('L1| alp', { finish: 'length' }))));
  assert.ok(!plain.header.includes('empty output'), 'no hint when there is output');
});

test('async: the id comes back at once; eyes_result shows running, then the result', async () => {
  const s = setup(noExtra);
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  let release;
  const gate = new Promise((r) => (release = r));
  const r = await eyesRun({ task: 't', mode: 'extract', files: [f], async: true }, s.ctx, deps(s, mockFetch(async () => (await gate, chatOk('L1| alpha')))));
  assert.equal(r.async, true);
  assert.match(r.header, /^eyes_run started \(async\): \S+\n/);
  assert.match(await eyesResult({ id: r.id }, s.ctx), /^status: running\nprogress: 0\/1 chunks/);
  release();
  await running.get(r.id).promise;
  const out = await eyesResult({ id: r.id }, s.ctx);
  assert.match(out, /^status: done\neyes_run result: /);
  assert.match(out, /check \(extract\): refs ok 1 \/ bad 0/);
  assert.equal(running.has(r.id), false);
});

test('cancel: aborts a running job; finished chunks are kept and the job is saved as cancelled', async () => {
  const s = setup(() => ({ max_context: 3000, concurrency: 2 }));
  const text = Array.from({ length: 200 }, (_, i) => `row ${i + 1} ${'w'.repeat(30)}`).join('\n');
  const f = write(path.join(s.root, 'long.md'), text);
  const fetch = mockFetch((body, n, init) => (n === 1 ? chatOk('L1| row 1 wwwwwwwwwwwwwwwwwwwwwwwwwwwwww') : hang(init)));
  const r = await eyesRun({ task: 't', mode: 'extract', files: [f], async: true }, s.ctx, deps(s, fetch));
  const job = running.get(r.id);
  while (job.progress.done < 1) await new Promise((res) => setTimeout(res, 5));
  const out = await eyesResult({ id: r.id, cancel: true }, s.ctx);
  assert.match(out, /^status: cancelled\nerror: cancelled\neyes_run result: \S+ — CANCELLED/);
  const check = await readCheck(s.ctx.resultsDir, r.id);
  assert.equal(check.status, 'cancelled');
  assert.equal(check.chunks.filter((c) => c.status === 'done').length, 1);
  assert.match(await eyesResult({ id: r.id, offset: 1 }, s.ctx), /L1\| row 1/);
  const rec = JSON.parse(fs.readFileSync(path.join(s.stateDir, 'usage.jsonl'), 'utf8').trim());
  assert.equal(rec.status, 'cancelled');
  assert.equal(rec.chunks_done, 1);
  assert.equal(s.ledger.reserved, 0);
});

test('a failed job is saved with status failed, its finished chunks and their cost', async () => {
  const s = setup(() => ({ max_context: 3000, concurrency: 1 }));
  const text = Array.from({ length: 200 }, (_, i) => `row ${i + 1} ${'w'.repeat(30)}`).join('\n');
  const f = write(path.join(s.root, 'long.md'), text);
  const fetch = mockFetch((body, n) => (n === 1 ? chatOk('- first (L1)') : json({ error: { code: 400, message: 'bad request' } }, 400)));
  let id;
  await assert.rejects(eyesRun({ task: 't', mode: 'draft', files: [f] }, s.ctx, deps(s, fetch)), (e) => {
    const m = /result (\S+) saved as failed with 1\/\d+ chunk\(s\); spent \$0\.000100/.exec(e.message);
    assert.ok(m, e.message);
    id = m[1];
    return true;
  });
  const out = await eyesResult({ id }, s.ctx);
  assert.match(out, /^status: failed\nerror: .*HTTP 400/);
  const check = await readCheck(s.ctx.resultsDir, id);
  assert.equal(check.cost, 0.0001);
  assert.equal(check.chunks[0].status, 'done');
  assert.equal(check.chunks[1].status, 'not finished');
  assert.match(await eyesResult({ id, offset: 1 }, s.ctx), /- first \(L1\)/);
});

test('export: export_dir copies every finished result and its check.json; export_to per call', async () => {
  const s = setup((root, out) => ({ write_roots: [out], export_dir: path.join(out, 'eyes') }));
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const fetch = mockFetch(() => chatOk('L1| alpha'));
  const r = await eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, fetch));
  const md = path.join(s.out, 'eyes', `${r.id}.md`);
  assert.equal(fs.readFileSync(md, 'utf8'), 'L1| alpha\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.out, 'eyes', `${r.id}.check.json`), 'utf8')).status, 'done');
  assert.match(r.header, /^export: .*\.md, .*\.check\.json$/m);
  const r2 = await eyesRun({ task: 't', mode: 'extract', files: [f], export_to: path.join(s.out, 'mine.md') }, s.ctx, deps(s, fetch));
  assert.ok(fs.existsSync(path.join(s.out, 'mine.md')));
  assert.ok(fs.existsSync(path.join(s.out, 'mine.check.json')));
  const again = await eyesRun({ task: 't', mode: 'extract', files: [f], export_to: path.join(s.out, 'mine.md') }, s.ctx, deps(s, fetch));
  assert.match(again.header, /export failed: .*exists \(overwrite: true/);
  const ow = await eyesRun({ task: 't', mode: 'extract', files: [f], export_to: path.join(s.out, 'mine.md'), overwrite: true }, s.ctx, deps(s, fetch));
  assert.match(ow.header, /^export: /m);
  assert.ok(r2.id !== ow.id);
});

test('export_to is checked before any model call', async () => {
  const s = setup((root, out) => ({ write_roots: [out] }));
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const fetch = mockFetch(() => assert.fail('no chat call'));
  await assert.rejects(eyesRun({ task: 't', mode: 'extract', files: [f], export_to: path.join(s.out, '.vault-trash', 'x.md') }, s.ctx, deps(s, fetch)), /dotfiles and dot-directories/);
  await assert.rejects(eyesRun({ task: 't', mode: 'extract', files: [f], export_to: path.join(s.d, 'x.md') }, s.ctx, deps(s, fetch)), /outside write_roots/);
  const off = setup(noExtra);
  const g = write(path.join(off.root, 'a.md'), 'alpha\n');
  await assert.rejects(eyesRun({ task: 't', mode: 'extract', files: [g], export_to: path.join(off.out, 'x.md') }, off.ctx, deps(off, fetch)), /export is off: write_roots is empty/);
});

test('draft and edits results are checked and stored', async () => {
  const s = setup(noExtra);
  const f = write(path.join(s.root, 'a.md'), 'uplink 192.0.2.1\nretry=3\n');
  const d = await eyesRun({ task: 't', mode: 'draft', files: [f] }, s.ctx, deps(s, mockFetch(() => chatOk('- uplink 192.0.2.1 (L1)\n- uplink 192.0.2.9 (L1)'))));
  assert.match(d.header, /check \(draft\): refs ok 2 \/ bad 0 — lines 2: ok 1, flagged 0, bad 1/);
  assert.match(d.header, /token not in cited lines: 192\.0\.2\.9/);
  const e = await eyesRun({ task: 't', mode: 'edits', files: [f] }, s.ctx, deps(s, mockFetch(() => chatOk('{"file":"","line":2,"old":"retry=3","new":"retry=5","why":"x"}'))));
  assert.match(e.header, /check \(edits\): refs ok 1 \/ bad 0 — valid 1, rejected 0 \(never applied\)/);
  assert.equal(fs.readFileSync(path.join(s.root, 'a.md'), 'utf8'), 'uplink 192.0.2.1\nretry=3\n', 'the server never applies edits');
});
