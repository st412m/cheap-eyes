// Fake keys and tokens only. scan-secrets:allow-file
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { clearCatalogCache } from '../src/openrouter.js';
import { eyesRun } from '../src/run.js';
import { RESULT_ID_RE } from '../src/tools.js';
import { tmpDir } from './helpers.js';

// From step 2 the only network call dry_run may make is the public ZDR list;
// anything else fails the test.
export const ZDR_FIXTURE = [
  { model_id: 'vendor/model-a', provider_name: 'P1', context_length: 32000, max_completion_tokens: 2048, pricing: { prompt: '0.0000001', completion: '0.0000004', request: '0' } },
  { model_id: 'vendor/model-b', provider_name: 'P2', context_length: 64000, max_completion_tokens: 8192, pricing: { prompt: '0.0000002', completion: '0.0000008', request: '0' } },
  { model_id: 'vendor/raw', provider_name: 'P3', context_length: 16000, max_completion_tokens: null, pricing: { prompt: '0.0000001', completion: '0.0000001', request: '0' } },
];
let realFetch;
let fetchCalls;
let zdrFails;
beforeEach(() => {
  realFetch = globalThis.fetch;
  fetchCalls = [];
  zdrFails = false;
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    if (String(url) === 'https://openrouter.ai/api/v1/endpoints/zdr' && !zdrFails) {
      return new Response(JSON.stringify({ data: ZDR_FIXTURE }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`network is forbidden here: ${url}`);
  };
  clearCatalogCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

function setup(extra = {}) {
  const d = tmpDir();
  const roots = [path.join(d, 'vault'), path.join(d, 'notes')];
  for (const r of roots) fs.mkdirSync(r, { recursive: true });
  const config = parseConfig({
    read_roots: roots,
    models: { fast: { ids: ['vendor/model-a', 'vendor/model-b'], params: { temperature: 0, reasoning: { effort: 'none' } } } },
    defaults: { extract: 'fast', draft: 'fast', edits: 'fast' },
    max_context: 8000,
    ...extra,
  });
  const resultsDir = path.join(d, 'state', 'results');
  return { d, roots, config, ctx: { config, resultsDir }, resultsDir };
}

async function refused(promise, re) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.name, 'InputError', e.stack);
    assert.match(e.message, re);
    return true;
  });
}

test('dry_run stores the exact request bodies; the only network call is the ZDR list', async () => {
  const s = setup();
  const f = write(path.join(s.roots[0], 'wiki', 'router.md'), 'Router notes\npassword: hunter2\nuplink 192.0.2.1\n');
  const r = await eyesRun(
    { task: 'What is the uplink? key sk-' + 'or-v1-FAKEfake0123456789abcdef', mode: 'draft', files: [f], dry_run: true },
    s.ctx,
  );
  assert.deepEqual(fetchCalls, ['https://openrouter.ai/api/v1/endpoints/zdr']);
  assert.match(r.id, RESULT_ID_RE);
  const stored = JSON.parse(fs.readFileSync(path.join(s.resultsDir, `${r.id}.md`), 'utf8'));
  assert.deepEqual(stored, r.bodies);
  const body = stored[0];
  assert.equal(body.model, 'vendor/model-a');
  assert.deepEqual(body.provider, { zdr: true, data_collection: 'deny' });
  assert.equal(body.max_completion_tokens, 2048, 'capped at the ZDR max_completion_tokens of vendor/model-a');
  assert.equal(body.max_tokens, undefined);
  assert.deepEqual(body.plugins, [{ id: 'context-compression', enabled: false }]);
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.equal(body.usage, undefined);
  assert.equal(body.messages[0].role, 'system');
  const user = body.messages[1].content;
  assert.ok(user.includes('L1| Router notes'));
  assert.ok(user.includes('L2| password: [token]'));
  assert.ok(user.includes('L3| uplink 192.0.2.1'));
  assert.ok(!user.includes('hunter2'));
  assert.ok(user.includes('Task: What is the uplink? key [key]'));
  assert.ok(!user.includes('FAKEfake'));

  const check = JSON.parse(fs.readFileSync(path.join(s.resultsDir, `${r.id}.check.json`), 'utf8'));
  assert.equal(check.kind, 'dry_run');
  assert.deepEqual(check.masks, { kv_secret: 1 });
  assert.deepEqual(check.task_masks, { sk_key: 1 });
  assert.deepEqual(check.chunks[0].lines, { 'wiki/router.md': [[1, 3]] });

  // The header carries counts, never payload lines.
  assert.ok(r.header.includes(r.id));
  assert.ok(!r.header.includes('Router notes'));
  assert.ok(!r.header.includes('uplink'));
  assert.match(r.header, /masks: kv_secret 1; in task: sk_key 1/);
  assert.ok(Buffer.byteLength(r.header) <= 4096);
});

test('dry_run: ZDR list unavailable → chunk by max_context; without max_context → refuse with the reason', async () => {
  zdrFails = true;
  const s = setup();
  const f = write(path.join(s.roots[0], 'a.md'), 'x\n');
  const r = await eyesRun({ task: 't', mode: 'extract', files: [f], dry_run: true }, s.ctx);
  assert.match(r.header, /max_context 8000; ZDR list unavailable, id not checked/);
  assert.equal(r.bodies[0].model, 'vendor/model-a');
  const none = setup({ max_context: undefined });
  const g = write(path.join(none.roots[0], 'a.md'), 'x\n');
  await refused(eyesRun({ task: 't', mode: 'extract', files: [g], dry_run: true }, none.ctx), /ZDR list is unavailable .* and max_context is not set/);
  assert.ok(fetchCalls.every((u) => u.endsWith('/endpoints/zdr')));
});

test('dry_run: context comes from the ZDR list, capped by max_context', async () => {
  const s = setup({ max_context: undefined });
  const f = write(path.join(s.roots[0], 'a.md'), 'x\n');
  const r = await eyesRun({ task: 't', mode: 'extract', files: [f], dry_run: true }, s.ctx);
  assert.match(r.header, /context 32000 from the ZDR list/);
  const capped = setup({ max_context: 9000 });
  const g = write(path.join(capped.roots[0], 'a.md'), 'x\n');
  const r2 = await eyesRun({ task: 't', mode: 'extract', files: [g], dry_run: true }, capped.ctx);
  assert.match(r2.header, /context 9000 from the ZDR list, max_context 9000/);
});

test('a live run without a key is refused; dry_run takes neither async nor export_to', async () => {
  const s = setup();
  const f = write(path.join(s.roots[0], 'a.md'), 'x\n');
  await refused(eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, { key: null }), /OpenRouter key is not set/);
  await refused(eyesRun({ task: 't', mode: 'extract', files: [f], dry_run: true, async: true }, s.ctx), /async is not used with dry_run/);
  await refused(eyesRun({ task: 't', mode: 'extract', files: [f], dry_run: true, export_to: path.join(s.d, 'x.md') }, s.ctx), /export_to is not used with dry_run/);
});

test('model choice: alias, default per mode, raw ids only when allowed', async () => {
  const s = setup();
  const f = write(path.join(s.roots[0], 'a.md'), 'x\n');
  await refused(eyesRun({ task: 't', mode: 'extract', files: [f], dry_run: true, model: 'vendor/raw' }, s.ctx), /unknown model alias: vendor\/raw \(raw OpenRouter ids are off/);
  const raw = setup({ allow_raw_model_ids: true });
  const g = write(path.join(raw.roots[0], 'a.md'), 'x\n');
  const r = await eyesRun({ task: 't', mode: 'extract', files: [g], dry_run: true, model: 'vendor/raw' }, raw.ctx);
  assert.equal(r.bodies[0].model, 'vendor/raw');
  assert.equal(r.bodies[0].temperature, undefined);
  const none = setup({ defaults: {} });
  const h = write(path.join(none.roots[0], 'a.md'), 'x\n');
  await refused(eyesRun({ task: 't', mode: 'edits', files: [h], dry_run: true }, none.ctx), /set defaults\.edits/);
});

test('multi-file: headers, name collisions get the root segment', async () => {
  const s = setup();
  const a = write(path.join(s.roots[0], 'x.md'), 'from vault\n');
  const b = write(path.join(s.roots[1], 'x.md'), 'from notes\n');
  const r = await eyesRun({ task: 't', mode: 'extract', files: [a, b], dry_run: true }, s.ctx);
  const user = r.bodies[0].messages[1].content;
  assert.ok(user.includes('=== file: vault/x.md ===\nL1| from vault'));
  assert.ok(user.includes('=== file: notes/x.md ===\nL1| from notes'));
  assert.deepEqual(Object.keys(r.job.chunks[0].lines).sort(), ['notes/x.md', 'vault/x.md']);
});

test('UTF-16 LE input, range, time and grep together keep original numbering', async () => {
  const s = setup();
  const lines = [
    '2026-09-26 09:00:00 INFO a',
    '2026-09-26 10:00:00 ERROR boom',
    'Traceback (most recent call last):',
    '  raise ValueError',
    '2026-09-26 10:05:00 INFO fine',
    '2026-09-26 10:10:00 ERROR again',
    '2026-09-26 12:00:00 ERROR too late',
  ];
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf16le')]);
  const f = write(path.join(s.roots[0], 'ha.log'), buf);
  const r = await eyesRun(
    {
      task: 'errors',
      mode: 'extract',
      files: [`${f}#L2-L7`],
      time: { since: '2026-09-26T09:30:00', until: '2026-09-26T11:00:00' },
      grep: { pattern: 'ERROR', context: 0 },
      dry_run: true,
    },
    s.ctx,
  );
  const user = r.bodies[0].messages[1].content;
  assert.ok(user.includes('… (line 1 skipped)\nL2| 2026-09-26 10:00:00 ERROR boom\n… (lines 3–5 skipped)\nL6| 2026-09-26 10:10:00 ERROR again\n… (line 7 skipped)'), user);
  assert.equal(r.job.files[0].encoding, 'utf-16le');
});

test('glob: binaries and oversized files are skipped and reported; a literal binary is refused', async () => {
  const s = setup({ max_file_bytes: 100 });
  write(path.join(s.roots[0], 'ok.md'), 'fine\n');
  const bin = write(path.join(s.roots[0], 'img.png'), Buffer.from([0x89, 0x50, 0, 0, 1]));
  write(path.join(s.roots[0], 'big.md'), 'y'.repeat(200));
  const r = await eyesRun({ task: 't', mode: 'extract', files: [path.join(s.roots[0], '*')], dry_run: true }, s.ctx);
  assert.deepEqual(r.job.files.map((f) => f.name), ['ok.md']);
  assert.match(r.header, /skipped: 2/);
  assert.match(r.header, /img\.png \(binary file refused\)/);
  assert.match(r.header, /big\.md \(file too large\)/);
  await refused(eyesRun({ task: 't', mode: 'extract', files: [bin], dry_run: true }, s.ctx), /binary file refused: .*img\.png/);
});

test('max_job_bytes refuses the job after filtering', async () => {
  const s = setup({ max_job_bytes: 70 });
  const f = write(path.join(s.roots[0], 'a.md'), 'z'.repeat(40) + '\n' + 'q'.repeat(40) + '\n');
  await refused(eyesRun({ task: 't', mode: 'extract', files: [f], dry_run: true }, s.ctx), /job too large after filtering: \d+ bytes > max_job_bytes 70/);
  const r = await eyesRun({ task: 't', mode: 'extract', files: [f], dry_run: true, grep: { pattern: '^z', context: 0 } }, s.ctx);
  assert.equal(r.job.files[0].lines_sent, 1);
});

test('chunks follow max_context: a long file becomes several request bodies', async () => {
  const s = setup({ max_context: 3000 });
  const text = Array.from({ length: 300 }, (_, i) => `row ${i + 1} ${'w'.repeat(30)}`).join('\n');
  const f = write(path.join(s.roots[0], 'long.md'), text);
  const r = await eyesRun({ task: 't', mode: 'extract', files: [f], dry_run: true }, s.ctx);
  assert.ok(r.bodies.length > 1);
  assert.equal(r.bodies.length, r.job.chunks.length);
  const check = JSON.parse(fs.readFileSync(path.join(s.resultsDir, `${r.id}.check.json`), 'utf8'));
  assert.equal(check.chunks.length, r.bodies.length);
  assert.match(r.header, new RegExp(`chunks: ${r.bodies.length}`));
});

test('nothing left after filters is an error, not an empty request', async () => {
  const s = setup();
  const f = write(path.join(s.roots[0], 'a.md'), 'alpha\nbeta\n');
  await refused(eyesRun({ task: 't', mode: 'extract', files: [f], dry_run: true, grep: { pattern: 'gamma' } }, s.ctx), /nothing left after filters/);
});

test('grep runs over masked text: a secret cannot be probed character by character', async () => {
  const s = setup();
  const f = write(path.join(s.roots[0], 'app.yaml'), 'name: demo\napi_key: "abcdef123"\nport: 8123\n');
  for (const probe of ['api_key: "a', 'api_key: "ab', 'abcdef', 'hunter|abc']) {
    await refused(
      eyesRun({ task: 't', mode: 'extract', files: [f], dry_run: true, grep: { pattern: probe, context: 0 } }, s.ctx),
      /nothing left after filters/,
    );
  }
  const r = await eyesRun({ task: 't', mode: 'extract', files: [f], dry_run: true, grep: { pattern: String.raw`api_key: "\[token\]"`, context: 0 } }, s.ctx);
  assert.equal(r.job.files[0].lines_sent, 1);
  assert.deepEqual(r.job.masks, { kv_secret: 1 });
});

test('mask counts cover only the lines actually sent', async () => {
  const s = setup();
  const f = write(path.join(s.roots[0], 'a.env.md'), 'password=one\nx\npassword=two\n');
  const r = await eyesRun({ task: 't', mode: 'extract', files: [f], dry_run: true, grep: { pattern: '^x$', context: 0 } }, s.ctx);
  assert.deepEqual(r.job.masks, {});
});
