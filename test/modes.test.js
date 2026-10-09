// Mode grep (no model, no network), per-mode max_tokens defaults and the re-split of
// chunks cut by finish_reason "length". Mocked fetch only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { Ledger } from '../src/budget.js';
import { parseConfig } from '../src/config.js';
import { clearCatalogCache } from '../src/openrouter.js';
import { eyesResult } from '../src/result-tool.js';
import { readCheck } from '../src/results.js';
import { eyesRun } from '../src/run.js';
import { eyesStats } from '../src/stats.js';
import { tmpDir } from './helpers.js';

const FX = path.join(import.meta.dirname, 'fixtures', 'formats');
const KEY = 'sk-' + 'or-v1-FAKE0000000000000000000000000000000000000000000000000000'; // fake, scan-secrets:allow
const ZDR = [{ model_id: 'v/a', provider_name: 'P', context_length: 200000, max_completion_tokens: null, pricing: { prompt: '0.0000002', completion: '0.0000004', request: '0' } }];

let realFetch;
beforeEach(() => {
  clearCatalogCache();
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function setup() {
  const d = tmpDir();
  const root = path.join(d, 'notes');
  fs.mkdirSync(root, { recursive: true });
  const config = parseConfig({ read_roots: [root], models: { fast: { ids: ['v/a'] } }, defaults: { extract: 'fast', draft: 'fast', edits: 'fast' } });
  const stateDir = path.join(d, 'state');
  return { root, config, stateDir, ctx: { config, stateDir: { path: stateDir }, resultsDir: path.join(stateDir, 'results') } };
}

function json(b) {
  return new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
}

// A fetch that serves the ZDR list and answers chat calls with onChat(body, n).
function mockFetch(onChat) {
  const chats = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/endpoints/zdr')) return json({ data: ZDR });
    if (u.endsWith('/chat/completions')) {
      const body = JSON.parse(init.body);
      chats.push(body);
      const { content, finish = 'stop' } = onChat(body, chats.length);
      return json({ id: 'g', model: 'v/a', choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 } });
    }
    throw new Error(`unexpected ${u}`);
  };
  fn.chats = chats;
  return fn;
}

// ---- grep ----

test('grep: no model, no network call at all, no key; result, check.json and usage as usual with cost 0', async () => {
  const s = setup();
  fs.copyFileSync(path.join(FX, 'text.pdf'), path.join(s.root, 'text.pdf'));
  fs.writeFileSync(path.join(s.root, 'a.md'), 'alpha voltage one\nbeta\npassword: hunter2-not-real\ngamma\n');
  const calls = [];
  const deny = async (url) => {
    calls.push(String(url));
    throw new Error(`network call in grep mode: ${url}`);
  };
  globalThis.fetch = deny;
  const r = await eyesRun({ mode: 'grep', files: [path.join(s.root, 'a.md'), path.join(s.root, 'text.pdf')], grep: { pattern: 'voltage|password', ignore_case: true, context: 0 } }, s.ctx, { key: null, fetch: deny });
  assert.deepEqual(calls, []);
  assert.match(r.header, /^eyes_run result: \d{4}-\d{2}-\d{2}_\d{6}-grep-[0-9a-f]{6}\nmode: grep \(no model call, cost \$0\); files: 2; matches: 4; lines: 4\n/);
  assert.match(r.header, /\nmatches per file: a\.md 2, text\.pdf 2\n/);
  assert.match(r.header, /\n--- source text \(masked\) ---\n=== file: a\.md ===\nL1\| alpha voltage one\n/);
  assert.ok(!r.header.includes('untrusted model output'));
  // Page tags on PDF lines; masking before grep; file headers for every file.
  assert.match(r.text, /=== file: text\.pdf ===\n… \(lines 1–8 skipped\)\n--- page 1 ---\nL9 \(p\.1\)\| Voltage 3\.0 3\.6\nL10 \(p\.1\)\| password: \[token\]\n/);
  assert.ok(!r.text.includes('hunter2-not-real'));
  assert.match(r.text, /\nL3\| password: \[token\]\n/);
  assert.match(r.header, /\nmasks: kv_secret 2;/);
  const check = await readCheck(s.ctx.resultsDir, r.id);
  assert.equal(check.kind, 'grep');
  assert.deepEqual(check.counts, { files: 2, matches: 4, lines: 4 });
  assert.equal(check.checks, undefined);
  const rec = JSON.parse(fs.readFileSync(path.join(s.stateDir, 'usage.jsonl'), 'utf8'));
  assert.equal(rec.mode, 'grep');
  assert.equal(rec.cost, 0);
  assert.equal(rec.model, null);
  assert.equal(rec.matches, 4);
  // eyes_result: source-text frame; no check report.
  const page = await eyesResult({ id: r.id, offset: 1, limit: 2 }, s.ctx);
  assert.match(page, /^lines 1–2 of \d+; more: next offset 3\n--- source text \(masked\) ---\n=== file: a\.md ===\nL1\| alpha voltage one\n--- end of source text ---$/);
  assert.match(await eyesResult({ id: r.id, check: true }, s.ctx), /no check report for this result \(kind: grep\)/);
  const stats = await eyesStats({}, s.ctx, { key: null, fetch: deny });
  assert.match(stats, /alias \(grep, no model\): jobs 1, cost \$0\.0000/);
});

test('grep: needs a pattern; dry_run and schema refused; task is an optional label', async () => {
  const s = setup();
  const f = path.join(s.root, 'a.md');
  fs.writeFileSync(f, 'one\n');
  const deps = { key: null, fetch: async () => assert.fail('network') };
  await assert.rejects(eyesRun({ mode: 'grep', files: [f] }, s.ctx, deps), /mode grep needs "grep"/);
  await assert.rejects(eyesRun({ mode: 'grep', files: [f], grep: { pattern: 'o' }, dry_run: true }, s.ctx, deps), /dry_run is not used with mode grep/);
  await assert.rejects(eyesRun({ mode: 'grep', files: [f], grep: { pattern: 'o' }, schema: { a: 'string' } }, s.ctx, deps), /"schema" is used only with mode schema/);
  const r = await eyesRun({ mode: 'grep', task: 'where is one', files: [f], grep: { pattern: 'one' } }, s.ctx, deps);
  assert.match(r.header, /\ntask: where is one\n/);
  await assert.rejects(eyesRun({ mode: 'extract', files: [f] }, s.ctx, { key: KEY, fetch: deps.fetch }), /mode extract needs "task"/);
});

// ---- max_tokens per mode ----

test('max_tokens defaults per mode: extract 16000, schema 8000, draft and edits 4096; an explicit value wins', async () => {
  const s = setup();
  const f = path.join(s.root, 'a.md');
  fs.writeFileSync(f, 'alpha\n');
  const answers = { extract: 'L1| alpha', draft: 'Alpha (L1)', edits: '', schema: '{"a": {"value": "alpha", "ref": "L1", "quote": "alpha"}}' };
  const want = { extract: 16000, draft: 4096, edits: 4096, schema: 8000 };
  for (const mode of Object.keys(want)) {
    const fetch = mockFetch(() => ({ content: answers[mode] }));
    const args = { mode, files: [f], ...(mode === 'schema' ? { schema: { a: 'string' } } : { task: 't' }) };
    await eyesRun(args, s.ctx, { key: KEY, fetch, ledger: new Ledger(s.stateDir), sleep: async () => {} });
    assert.equal(fetch.chats[0].max_completion_tokens, want[mode], mode);
  }
  const fetch = mockFetch(() => ({ content: 'L1| alpha' }));
  await eyesRun({ mode: 'extract', task: 't', files: [f], max_tokens: 777 }, s.ctx, { key: KEY, fetch, ledger: new Ledger(s.stateDir), sleep: async () => {} });
  assert.equal(fetch.chats[0].max_completion_tokens, 777);
});

// ---- re-split ----

const LINES = Array.from({ length: 20 }, (_, i) => `entry ${i + 1}`);
const shown = (body) => [...body.messages[1].content.matchAll(/^L(\d+)\| /gm)].map((m) => Number(m[1]));

test('re-split: a chunk cut by "length" is split in two, both halves run once, merged without duplicates', async () => {
  const s = setup();
  const f = path.join(s.root, 'log.md');
  fs.writeFileSync(f, LINES.join('\n') + '\n');
  // The whole file is cut short; each half is answered in full.
  const fetch = mockFetch((body) => {
    const n = shown(body);
    if (n.length === 20) return { content: 'L1| entry 1\nL2| entry 2', finish: 'length' };
    return { content: n.map((k) => `L${k}| entry ${k}`).join('\n') };
  });
  const r = await eyesRun({ mode: 'extract', task: 't', files: [f], max_tokens: 500 }, s.ctx, { key: KEY, fetch, ledger: new Ledger(s.stateDir), sleep: async () => {} });
  assert.equal(fetch.chats.length, 3);
  assert.deepEqual(shown(fetch.chats[1]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(shown(fetch.chats[2]), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 'second half carries 5 lines of overlap');
  assert.ok(fetch.chats.every((b) => b.max_completion_tokens === 500), 'an explicit max_tokens is kept on the halves');
  assert.match(r.header, /\nre-split after truncation: 1 chunk\(s\)\n/);
  assert.doesNotMatch(r.header, /TRUNCATED/);
  assert.equal(r.text, LINES.map((l, i) => `L${i + 1}| ${l}`).join('\n') + '\n');
  const check = await readCheck(s.ctx.resultsDir, r.id);
  assert.deepEqual(check.chunks.map((c) => [c.index, c.resplit_of]), [[1, 1], [2, 1]]);
  assert.equal(check.checks.summary.ok, 20);
  const rec = JSON.parse(fs.readFileSync(path.join(s.stateDir, 'usage.jsonl'), 'utf8'));
  assert.ok(Math.abs(rec.cost - 0.003) < 1e-9, 'the cut answer is billed too');
  assert.equal(rec.resplit, 1);
});

test('re-split: a half cut again stays truncated; draft is never re-split', async () => {
  const s = setup();
  const f = path.join(s.root, 'log.md');
  fs.writeFileSync(f, LINES.join('\n') + '\n');
  const fetch = mockFetch((body) => {
    const n = shown(body);
    return { content: `L${n[0]}| entry ${n[0]}`, finish: n.length >= 15 ? 'length' : 'stop' };
  });
  const r = await eyesRun({ mode: 'extract', task: 't', files: [f] }, s.ctx, { key: KEY, fetch, ledger: new Ledger(s.stateDir), sleep: async () => {} });
  assert.equal(fetch.chats.length, 3, 'no second round of splitting');
  assert.match(r.header, /re-split after truncation: 1 chunk\(s\)\nTRUNCATED chunks \(finish_reason length\): 2\n/);
  const draft = mockFetch(() => ({ content: 'Entry (L1)', finish: 'length' }));
  const d = await eyesRun({ mode: 'draft', task: 't', files: [f] }, s.ctx, { key: KEY, fetch: draft, ledger: new Ledger(s.stateDir), sleep: async () => {} });
  assert.equal(draft.chats.length, 1);
  assert.match(d.header, /TRUNCATED chunks \(finish_reason length\): 1/);
});
