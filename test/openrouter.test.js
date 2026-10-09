// Step 2 on a mocked fetch: resolution, request body, retries, fallback, truncation,
// budget reservation, usage log hygiene, error text, eyes_stats. No real network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { Ledger } from '../src/budget.js';
import { parseConfig } from '../src/config.js';
import { candidates, capMaxTokens, screenIds, summarizeZdr, worstCaseCost } from '../src/models.js';
import { clearCatalogCache, OpenRouter, safeErrorText } from '../src/openrouter.js';
import { eyesRun, FRAME_CLOSE, FRAME_OPEN, neutralize } from '../src/run.js';
import { eyesStats } from '../src/stats.js';
import { tmpDir } from './helpers.js';

const KEY = 'sk-' + 'or-v1-FAKE0000000000000000000000000000000000000000000000000000'; // fake, scan-secrets:allow
const ZDR = 'https://openrouter.ai/api/v1/endpoints/zdr';
const CHAT = 'https://openrouter.ai/api/v1/chat/completions';

const ep = (model_id, provider_name, ctx, maxOut, pin, pout) => ({
  model_id,
  provider_name,
  context_length: ctx,
  max_completion_tokens: maxOut,
  pricing: { prompt: String(pin / 1e6), completion: String(pout / 1e6), request: '0' },
});

// Prices in USD per 1M tokens.
const ZDR_LIST = [
  ep('v/a', 'P1', 32000, 2048, 0.1, 0.4),
  ep('v/a', 'P2', 16000, 4096, 0.2, 0.3), // v/a: min ctx 16000, min out 2048, max in 0.2, max out 0.4
  ep('v/b', 'P3', 64000, 8192, 0.5, 1.0),
  ep('v/pricey', 'P4', 64000, 8192, 50, 100),
  ep('v/tiny', 'P5', 1000, 500, 0.01, 0.01),
  ep('x/free-text', 'P6', 128000, 8192, 0.02, 0.05),
  ep('x/image-only', 'P7', 128000, 8192, 0.01, 0.01),
];
const TEXT_MODELS = [{ id: 'v/a' }, { id: 'v/b' }, { id: 'v/pricey' }, { id: 'v/tiny' }, { id: 'x/free-text', canonical_slug: 'x/free-text-2026' }];

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function chatOk(model, content, { finish = 'stop', cost = 0.0001, pin = 100, pout = 20, reasoning } = {}) {
  return json({
    id: 'gen-1',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content, ...(reasoning ? { reasoning } : {}) } }],
    usage: { prompt_tokens: pin, completion_tokens: pout, total_tokens: pin + pout, cost },
  });
}

const USER = 'https://openrouter.ai/api/v1/models/user';

// A fetch mock. `onChat(body, n)` answers chat calls; all URLs are recorded.
// `user`: the account's allowed models (GET /models/user), an array of ids, or an HTTP
// status to fail with; by default every text model is allowed.
function mockFetch(onChat, { zdr = ZDR_LIST, key, user } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: u, method: init.method ?? 'GET', body, auth: init.headers?.authorization ?? null });
    if (new URL(u).hostname !== 'openrouter.ai') throw new Error(`foreign host: ${u}`);
    if (u === ZDR) return json({ data: zdr });
    if (u === 'https://openrouter.ai/api/v1/models') return json({ data: TEXT_MODELS });
    if (u === USER) {
      if (!init.headers?.authorization) return json({ error: { code: 401, message: 'Missing Authentication header' } }, 401);
      if (typeof user === 'number') return json({ error: { code: user, message: 'upstream trouble' } }, user);
      if (user) return json({ data: user.map((id) => ({ id, canonical_slug: id })) });
      // Default: the account allows every text model (the list is text-output only).
      const extra = [...new Set(zdr.map((e) => e.model_id))].filter((id) => id !== 'x/image-only' && !TEXT_MODELS.some((m) => m.id === id));
      return json({ data: [...TEXT_MODELS, ...extra.map((id) => ({ id }))] });
    }
    if (u === 'https://openrouter.ai/api/v1/key') return json({ data: { label: 'sk-or-v1-FAK...000', limit: 10, limit_remaining: 7.5, limit_reset: 'daily', usage_daily: 2.5, ...key } });
    if (u === CHAT) return onChat(body, calls.filter((c) => c.url === CHAT).length);
    throw new Error(`unexpected url ${u}`);
  };
  return { fetch, calls, chats: () => calls.filter((c) => c.url === CHAT) };
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

function setup(extra = {}) {
  const d = tmpDir();
  const root = path.join(d, 'notes');
  fs.mkdirSync(root, { recursive: true });
  const config = parseConfig({
    read_roots: [root],
    models: {
      fast: { ids: ['v/a', 'v/b'], params: { temperature: 0 } },
      pricey: { ids: ['v/pricey'] },
      ghost: { ids: ['v/none', 'v/pricey', 'v/tiny'] },
    },
    defaults: { extract: 'fast', draft: 'fast', edits: 'fast' },
    max_price_usd_per_mtok: { in: 1, out: 2 },
    ...extra,
  });
  const stateDir = path.join(d, 'state');
  const ctx = { config, stateDir: { path: stateDir }, resultsDir: path.join(stateDir, 'results') };
  return { d, root, config, ctx, stateDir, ledger: new Ledger(stateDir) };
}

function deps(s, mock, more = {}) {
  return { key: KEY, fetch: mock.fetch, ledger: s.ledger, sleep: async () => {}, ...more };
}

async function refused(promise, re) {
  await assert.rejects(promise, (e) => {
    assert.match(e.message, re);
    return true;
  });
}

beforeEach(() => clearCatalogCache());

// ---- live facts ----

test('summarizeZdr: smallest context and max output, highest prices per id', () => {
  const z = summarizeZdr(ZDR_LIST);
  const a = z.get('v/a');
  assert.equal(a.endpoints, 2);
  assert.deepEqual(a.providers, ['P1', 'P2']);
  assert.equal(a.context, 16000);
  assert.equal(a.maxOut, 2048);
  assert.ok(Math.abs(a.priceIn - 0.2) < 1e-9);
  assert.ok(Math.abs(a.priceOut - 0.4) < 1e-9);
  const missing = summarizeZdr([{ model_id: 'q/q', context_length: 1000, pricing: {} }]).get('q/q');
  assert.equal(missing.priceIn, Infinity, 'a missing price is unknown, never free');
});

test('screenIds: no ZDR endpoint, over price cap, usable with context capped by max_context', () => {
  const s = setup({ max_context: 12000 });
  const r = screenIds(['v/none', 'v/pricey', 'v/a'], summarizeZdr(ZDR_LIST), s.config);
  assert.deepEqual(r.map((x) => [x.id, x.ok, x.reason?.split(' (')[0] ?? null]), [
    ['v/none', false, 'no ZDR endpoint'],
    ['v/pricey', false, 'over price cap'],
    ['v/a', true, null],
  ]);
  assert.equal(r[2].context, 12000);
});

test('capMaxTokens and worst case cost', () => {
  const a = summarizeZdr(ZDR_LIST).get('v/a');
  assert.equal(capMaxTokens(4096, a, 16000, 1000), 2048);
  assert.equal(capMaxTokens(1000, a, 16000, 1000), 1000);
  assert.equal(capMaxTokens(4096, { maxOut: null }, 3000, 1000), 2000);
  assert.ok(Math.abs(worstCaseCost(a, 1_000_000, 1_000_000) - 0.6) < 1e-9);
});

test('candidates: ZDR text models not in config, filtered, cheapest first, at most 10', () => {
  const s = setup();
  const z = summarizeZdr(ZDR_LIST);
  assert.deepEqual(candidates(s.config, z, TEXT_MODELS).map((c) => c.id), ['x/free-text']);
  const bare = setup({ models: {}, defaults: {} });
  assert.deepEqual(candidates(bare.config, z, TEXT_MODELS).map((c) => c.id), ['v/tiny', 'x/free-text', 'v/a', 'v/b', 'v/pricey']);
  assert.deepEqual(candidates(bare.config, z, TEXT_MODELS, { min_context: 20000, max_price_in: 1 }).map((c) => c.id), ['x/free-text', 'v/b']);
});

// ---- resolution ----

test('resolution: no endpoint / over price cap / context too small are refused with every reason', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'x'.repeat(3000) + '\n');
  const mock = mockFetch(() => assert.fail('no chat call expected'));
  await refused(
    eyesRun({ task: 't', mode: 'extract', files: [f], model: 'ghost' }, s.ctx, deps(s, mock)),
    /no usable model for alias ghost: v\/none: no ZDR endpoint; v\/pricey: over price cap .*; v\/tiny: context too small/,
  );
  assert.equal(mock.chats().length, 0);
});

test('resolution: the first usable id is used; the body carries provider.zdr, data_collection, plugins, max_completion_tokens', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'alpha\nbeta\n');
  const mock = mockFetch((body) => chatOk(body.model, 'L1| alpha'));
  const r = await eyesRun({ task: 'find alpha', mode: 'extract', files: [f] }, s.ctx, deps(s, mock));
  const [call] = mock.chats();
  assert.equal(call.method, 'POST');
  assert.equal(call.auth, `Bearer ${KEY}`);
  const b = call.body;
  assert.equal(b.model, 'v/a');
  assert.deepEqual(b.provider, { zdr: true, data_collection: 'deny' });
  assert.deepEqual(b.plugins, [{ id: 'context-compression', enabled: false }]);
  assert.equal(b.max_completion_tokens, 2048, 'default 4096 capped by the ZDR max_completion_tokens');
  assert.equal(b.max_tokens, undefined);
  assert.equal(b.usage, undefined, 'no deprecated usage.include');
  assert.equal(b.service_tier, undefined);
  assert.equal(b.models, undefined, 'fallback is done by the server, not by OpenRouter models[]');
  assert.equal(b.temperature, 0);
  assert.match(r.header, /model: alias fast -> v\/a \(used: v\/a\)/);
});

test('max_tokens: explicit value is kept when below the ZDR cap', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const mock = mockFetch((body) => chatOk(body.model, 'L1| alpha'));
  await eyesRun({ task: 't', mode: 'extract', files: [f], max_tokens: 300 }, s.ctx, deps(s, mock));
  assert.equal(mock.chats()[0].body.max_completion_tokens, 300);
});

// ---- retries and fallback ----

test('429 is retried twice honouring Retry-After, then succeeds', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const sleeps = [];
  const mock = mockFetch((body, n) =>
    n <= 2 ? json({ error: { code: 429, message: 'Rate limit exceeded' } }, 429, { 'retry-after': '2' }) : chatOk(body.model, 'L1| alpha'),
  );
  const r = await eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock, { sleep: async (ms) => sleeps.push(ms) }));
  assert.equal(mock.chats().length, 3);
  assert.deepEqual(sleeps, [2000, 2000]);
  const check = JSON.parse(fs.readFileSync(path.join(s.ctx.resultsDir, `${r.id}.check.json`), 'utf8'));
  assert.equal(check.chunks[0].attempts, 3);
});

test('503 (no provider) after retries → the next id of the alias; the id used is logged', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const sleeps = [];
  const mock = mockFetch((body) =>
    body.model === 'v/a' ? json({ error: { code: 503, message: 'No endpoints found matching your data policy' } }, 503) : chatOk('v/b-2026-09', 'L1| alpha'),
  );
  const r = await eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock, { sleep: async (ms) => sleeps.push(ms) }));
  assert.deepEqual(mock.chats().map((c) => c.body.model), ['v/a', 'v/a', 'v/a', 'v/b']);
  assert.deepEqual(sleeps, [1000, 3000]);
  assert.equal(mock.chats()[0].body.max_completion_tokens, 2048, 'extract default 16000 capped by v/a');
  assert.equal(mock.chats()[3].body.max_completion_tokens, 8192, 'fallback id gets its own cap');
  assert.match(r.header, /-> v\/a \(used: v\/b-2026-09\)/);
  const usage = fs.readFileSync(path.join(s.stateDir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(usage.at(-1).models_used, ['v/b-2026-09']);
});

test('an error inside a 200 body counts as an error', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const mock = mockFetch((body, n) => (n === 1 ? json({ error: { code: 502, message: 'provider died', metadata: { error_type: 'provider_unavailable' } } }) : chatOk(body.model, 'ok')));
  await eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock));
  assert.equal(mock.chats().length, 2);
});

test('4xx other than 404/429 is not retried and fails the job with a clipped, masked message', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const long = `bad request with ${KEY} ` + 'z'.repeat(2000);
  const mock = mockFetch(() => json({ error: { code: 400, message: long } }, 400));
  await assert.rejects(eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock)), (e) => {
    assert.match(e.message, /HTTP 400/);
    assert.ok(!e.message.includes(KEY), 'the key never appears');
    assert.ok(e.message.length < 800, `clipped: ${e.message.length}`);
    return true;
  });
  assert.equal(mock.chats().length, 1);
  assert.equal(safeErrorText('x'.repeat(900)).length, 500);
});

test('network errors and timeouts are retried like 5xx', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  let n = 0;
  const mock = mockFetch((body) => {
    n++;
    if (n === 1) throw new TypeError('fetch failed');
    return chatOk(body.model, 'ok');
  });
  await eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock));
  assert.equal(n, 2);
});

// ---- result ----

test('finish_reason length marks the chunk truncated in the header and check.json', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const mock = mockFetch((body) => chatOk(body.model, 'L1| alp', { finish: 'length', reasoning: 'secret thoughts' }));
  const r = await eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock));
  assert.match(r.header, /TRUNCATED chunks \(finish_reason length\): 1/);
  const check = JSON.parse(fs.readFileSync(path.join(s.ctx.resultsDir, `${r.id}.check.json`), 'utf8'));
  assert.equal(check.chunks[0].truncated, true);
  const all = fs.readFileSync(path.join(s.ctx.resultsDir, `${r.id}.md`), 'utf8') + JSON.stringify(check);
  assert.ok(!all.includes('secret thoughts'), 'the reasoning field is never stored');
});

test('header: framed preview of at most 20 lines × 200 chars, total lines, ≤ 4 KB; frame markers neutralised', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const out = [FRAME_CLOSE, ...Array.from({ length: 30 }, (_, i) => `line ${i} ${'y'.repeat(300)}`)].join('\n');
  const mock = mockFetch((body) => chatOk(body.model, out));
  const r = await eyesRun({ task: 't', mode: 'draft', files: [f] }, s.ctx, deps(s, mock));
  assert.ok(Buffer.byteLength(r.header) <= 4096, `${Buffer.byteLength(r.header)} bytes`);
  assert.match(r.header, /result lines: 31 \(first 20 below/);
  const inside = r.header.slice(r.header.indexOf(FRAME_OPEN) + FRAME_OPEN.length, r.header.lastIndexOf(FRAME_CLOSE));
  assert.ok(!inside.split('\n').includes(FRAME_CLOSE), 'a forged end marker is neutralised');
  for (const l of inside.split('\n')) assert.ok(l.length <= 201, l.length);
  assert.ok(r.header.endsWith(FRAME_CLOSE));
});

test('several chunks run in parallel; draft notes go under chunk headers', async () => {
  const s = setup({ max_context: 3000 });
  const text = Array.from({ length: 200 }, (_, i) => `row ${i + 1} ${'w'.repeat(30)}`).join('\n');
  const f = write(path.join(s.root, 'long.md'), text);
  let inFlight = 0;
  let peak = 0;
  const mock = mockFetch(async (body) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return chatOk(body.model, 'note (L1)');
  });
  const r = await eyesRun({ task: 't', mode: 'draft', files: [f] }, s.ctx, deps(s, mock));
  assert.ok(mock.chats().length > 3);
  assert.equal(peak, 3, 'concurrency 3');
  assert.match(r.text, /^=== chunk 1 \(long\.md:L1–L\d+\) ===\nnote \(L1\)\n=== chunk 2 \(long\.md:L\d+–L\d+\) ===/);
});

// ---- budget ----

test('budget: reservation with 3 lanes never overshoots; the job is refused when the next call would exceed it', async () => {
  // v/a worst case per chunk ≈ prompt × 0.2 + 2048 × 0.4 per 1M ≈ $0.0010; budget fits three reservations.
  const s = setup({ max_context: 3000, daily_budget_usd: 0.0032 });
  const text = Array.from({ length: 200 }, (_, i) => `row ${i + 1} ${'w'.repeat(30)}`).join('\n');
  const f = write(path.join(s.root, 'long.md'), text);
  let peakReserved = 0;
  const mock = mockFetch(async (body) => {
    peakReserved = Math.max(peakReserved, s.ledger.spent + s.ledger.reserved);
    await new Promise((r) => setTimeout(r, 10));
    return chatOk(body.model, 'x', { cost: 0.0009 });
  });
  await assert.rejects(eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock)), /daily budget exceeded/);
  assert.ok(peakReserved <= 0.0032 + 1e-12, `peak ${peakReserved}`);
  assert.ok(s.ledger.spent <= 0.0032);
  assert.equal(s.ledger.reserved, 0, 'every reservation is settled');
  const usage = fs.readFileSync(path.join(s.stateDir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(usage.at(-1).status, 'failed');
  assert.equal(usage.at(-1).error, 'budget');
  assert.ok(usage.at(-1).cost > 0);
});

test('budget: spend already in today\'s usage log counts; null switches the local cap off', async () => {
  const s = setup({ daily_budget_usd: 0.001 });
  fs.mkdirSync(s.stateDir, { recursive: true });
  fs.writeFileSync(path.join(s.stateDir, 'usage.jsonl'), JSON.stringify({ ts: new Date().toISOString(), tool: 'eyes_run', cost: 0.001 }) + '\n');
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const mock = mockFetch((body) => chatOk(body.model, 'ok'));
  await refused(eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock)), /daily budget exceeded: spent \$0\.0010/);
  assert.equal(mock.chats().length, 0);
  const off = setup({ daily_budget_usd: null });
  const g = write(path.join(off.root, 'a.md'), 'alpha\n');
  await eyesRun({ task: 't', mode: 'extract', files: [g] }, off.ctx, deps(off, mock));
});

test('budget ledger: a reservation is settled to the real cost', async () => {
  const l = new Ledger(tmpDir());
  await l.ensure();
  const h = l.reserve(0.5, 1);
  assert.equal(l.reserved, 0.5);
  assert.throws(() => l.reserve(0.6, 1), /daily budget exceeded/);
  l.settle(h, 0.1);
  assert.equal(l.reserved, 0);
  assert.ok(Math.abs(l.spent - 0.1) < 1e-12);
  l.reserve(0.9, 1);
});

// ---- usage log hygiene ----

test('usage log carries names, sizes, tokens, cost — never task, content or output', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'secret-notes.md'), 'CONTENT-MARKER line\n');
  const mock = mockFetch((body) => chatOk(body.model, 'OUTPUT-MARKER'));
  await eyesRun({ task: 'TASK-MARKER please', mode: 'extract', files: [f] }, s.ctx, deps(s, mock));
  const raw = fs.readFileSync(path.join(s.stateDir, 'usage.jsonl'), 'utf8');
  for (const m of ['TASK-MARKER', 'CONTENT-MARKER', 'OUTPUT-MARKER', KEY]) assert.ok(!raw.includes(m), m);
  const rec = JSON.parse(raw.trim());
  assert.deepEqual(Object.keys(rec).sort(), [
    'alias', 'check', 'chunks', 'chunks_done', 'cost', 'cost_estimated', 'failed_attempts', 'files', 'mode', 'models_used', 'ms', 'primary', 'result_id', 'status', 'tokens_in', 'tokens_out', 'tool', 'truncated', 'ts', 'usage_cost_missing',
  ]);
  assert.equal(rec.cost_estimated, false);
  assert.deepEqual(rec.files, [{ name: 'secret-notes.md', bytes: 20 }]);
  assert.equal(rec.tokens_in, 100);
  assert.equal(rec.cost, 0.0001);
});

test('every request goes to openrouter.ai only', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const mock = mockFetch((body) => chatOk(body.model, 'ok'));
  await eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock));
  await eyesStats({ models: true, candidates: {} }, s.ctx, deps(s, mock));
  for (const c of mock.calls) assert.equal(new URL(c.url).hostname, 'openrouter.ai');
  assert.ok(mock.calls.find((c) => c.url === ZDR).auth === null, 'the public ZDR list is fetched without the key');
});

test('the ZDR list is cached for 6 h', async () => {
  let t = 0;
  const mock = mockFetch(() => assert.fail());
  const or = new OpenRouter({ fetch: mock.fetch, now: () => t });
  await or.zdrEndpoints();
  t = 5 * 3600e3;
  await or.zdrEndpoints();
  assert.equal(mock.calls.length, 1);
  t = 6 * 3600e3 + 1;
  await or.zdrEndpoints();
  assert.equal(mock.calls.length, 2);
});

// ---- eyes_stats ----

test('eyes_stats: today and all-time totals, key status without the label, model table and candidates', async () => {
  const s = setup();
  fs.mkdirSync(s.stateDir, { recursive: true });
  const today = new Date().toISOString();
  const lines = [
    { ts: '2020-01-01T00:00:00.000Z', tool: 'eyes_run', alias: 'fast', models_used: ['v/a'], cost: 0.5, tokens_in: 10, tokens_out: 5, status: 'done' },
    { ts: today, tool: 'eyes_run', alias: 'fast', models_used: ['v/b'], cost: 0.25, tokens_in: 20, tokens_out: 7, status: 'done' },
  ];
  fs.writeFileSync(path.join(s.stateDir, 'usage.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const mock = mockFetch(() => assert.fail());
  const out = await eyesStats({ models: true, candidates: { max_price_in: 1 } }, s.ctx, deps(s, mock));
  assert.match(out, /today \(UTC \d{4}-\d{2}-\d{2}\): jobs 1, cost \$0\.2500, tokens in 20 \/ out 7/);
  assert.match(out, /all time: jobs 2, cost \$0\.7500/);
  assert.match(out, /model v\/b: jobs 1/);
  assert.match(out, /budget: daily_budget_usd \$1; spent today \$0\.2500, reserved \$0\.0000/);
  assert.match(out, /key: limit \$10, remaining \$7\.5, reset daily, usage today \(UTC\) \$2\.5/);
  assert.ok(!out.includes('sk-or-v1-FAK'), 'the key label is never shown');
  assert.match(out, /\ndefaults: extract -> fast, draft -> fast, edits -> fast, schema -> fast \(extract default\)\naccount: 5 models allowed \(GET \/models\/user\)/, 'defaults per mode come first');
  assert.match(out, /fast -> v\/a {2}\(jobs 2, avg cost \$0\.3750/);
  assert.match(out, /\* v\/a +zdr 2, ctx 16000, max out 2048, in \$0\.2 \/ out \$0\.4 per 1M/);
  assert.match(out, /pricey -> NO USABLE ID/);
  assert.match(out, /ghost -> v\/tiny/, 'the table screens endpoints and price; context is checked per job');
  assert.match(out, /v\/none +zdr 0.*\[no ZDR endpoint\]/);
  assert.match(out, /candidates \(ZDR text models not in config/);
  assert.match(out, /x\/free-text/);
  assert.ok(!out.includes('x/image-only'));
});

// ---- account availability (GET /models/user: guardrails, privacy settings) ----

test('account: a blocked first id is skipped without a model call; the second id is used', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'alpha\nbeta\n');
  const mock = mockFetch((body) => chatOk(body.model, 'L1| alpha'), { user: ['v/b', 'x/free-text'] });
  const r = await eyesRun({ task: 'find alpha', mode: 'extract', files: [f] }, s.ctx, deps(s, mock));
  assert.deepEqual(mock.chats().map((c) => c.body.model), ['v/b'], 'v/a is never sent to chat/completions');
  assert.match(r.header, /model: alias fast -> v\/b \(used: v\/b\)/);
  assert.doesNotMatch(r.header, /account availability/);
  const u = mock.calls.find((c) => c.url === USER);
  assert.equal(u.auth, `Bearer ${KEY}`, '/models/user is read with the key');
});

test('account: every id blocked → refused naming the ids, no model call', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const mock = mockFetch(() => assert.fail('no chat call expected'), { user: ['x/free-text'] });
  await refused(
    eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock)),
    /^no usable model for alias fast: v\/a, v\/b: blocked by the account's guardrails or privacy settings — allow it at openrouter\.ai → Guardrails$/,
  );
  assert.equal(mock.chats().length, 0);
});

test('account: blocked ids are named together with the other reasons', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'x'.repeat(3000) + '\n');
  const mock = mockFetch(() => assert.fail('no chat call expected'), { user: ['v/none', 'v/tiny'] });
  await refused(
    eyesRun({ task: 't', mode: 'extract', files: [f], model: 'ghost' }, s.ctx, deps(s, mock)),
    /no usable model for alias ghost: v\/pricey: blocked by the account's guardrails .*Guardrails; v\/none: no ZDR endpoint; v\/tiny: context too small/,
  );
});

test('account: /models/user down → availability unknown, shown, and the call proceeds', async () => {
  for (const user of [500, 403]) {
    clearCatalogCache();
    const s = setup();
    const f = write(path.join(s.root, 'a.md'), 'alpha\n');
    const mock = mockFetch((body) => chatOk(body.model, 'L1| alpha'), { user });
    const r = await eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock));
    assert.deepEqual(mock.chats().map((c) => c.body.model), ['v/a'], `HTTP ${user}: nothing is treated as blocked`);
    assert.match(r.header, new RegExp(`account availability: unknown \\(GET /models/user: HTTP ${user}: `));
    const stats = await eyesStats({ models: true, candidates: {} }, s.ctx, deps(s, mock));
    assert.match(stats, new RegExp(`account: availability unknown \\(GET /models/user: HTTP ${user}: .*no id is treated as blocked`));
    assert.doesNotMatch(stats, /blocked by account\]/);
    assert.match(stats, /candidates \(ZDR text models not in config, cheapest first; suggestions only; account availability unknown\)/);
  }
});

test('account: /models/user is cached with the ZDR list (6 h) and never fetched by dry_run', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const mock = mockFetch((body) => chatOk(body.model, 'L1| alpha'));
  await eyesRun({ task: 't', mode: 'extract', files: [f], dry_run: true }, s.ctx, deps(s, mock));
  assert.equal(mock.calls.filter((c) => c.url === USER).length, 0, 'dry_run fetches only the ZDR list');
  await eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock));
  await eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock));
  assert.equal(mock.calls.filter((c) => c.url === USER).length, 1);
  assert.ok(!mock.calls.some((c) => c.url.includes(KEY)), 'the key never appears in a URL');
});

test('eyes_stats: blocked ids are marked, resolution skips them, candidates list only allowed models', async () => {
  const s = setup();
  const mock = mockFetch(() => assert.fail(), { user: ['v/b', 'v/tiny', 'v/pricey'] });
  const out = await eyesStats({ models: true, candidates: {} }, s.ctx, deps(s, mock));
  assert.match(out, /account: 3 models allowed/);
  assert.match(out, /fast -> v\/b /);
  assert.match(out, /  v\/a +zdr 2, .*\[blocked by account\]/);
  assert.match(out, /\* v\/b +zdr 1, /);
  assert.match(out, /  v\/none +zdr 0, .*\[no ZDR endpoint\]/, 'an id with no ZDR endpoint is not sent to Guardrails');
  assert.match(out, /candidates: none match\b/, 'x/free-text is cheap and ZDR, but the account does not allow it');
  assert.ok(!out.includes('x/free-text'));
});

test('eyes_stats and the model table: defaults per mode, "(not set)" when a mode has none', async () => {
  const s = setup({ defaults: { draft: 'fast' } });
  const mock = mockFetch(() => assert.fail());
  const out = await eyesStats({ models: true }, s.ctx, deps(s, mock));
  assert.match(out, /\ndefaults: extract -> \(not set\), draft -> fast, edits -> \(not set\), schema -> \(not set\)\n/);
});

test('eyes_stats without a key and without network still reports local numbers', async () => {
  const s = setup();
  const failing = { fetch: async () => { throw new TypeError('offline'); } };
  const out = await eyesStats({ models: true }, s.ctx, { ...deps(s, failing), key: null });
  assert.match(out, /key: not set/);
  assert.match(out, /models: unavailable/);
});

// ---- step 2 fixes: unknown price, max_prompt_tokens, estimated cost, frame markers ----

test('an id without a price is refused even when no price cap is set; the ledger never sees Infinity', async () => {
  const noPrice = [{ model_id: 'v/np', provider_name: 'P', context_length: 32000, max_completion_tokens: 1000, pricing: { prompt: '0.0000001' } }];
  const s = setup({ max_price_usd_per_mtok: undefined, daily_budget_usd: null, models: { np: { ids: ['v/np'] } }, defaults: { extract: 'np' } });
  const [r] = screenIds(['v/np'], summarizeZdr(noPrice), s.config);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'price unknown');
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const mock = mockFetch(() => assert.fail('no chat call'), { zdr: noPrice });
  await refused(eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock)), /v\/np: price unknown/);
  assert.equal(mock.chats().length, 0);
  assert.equal(s.ledger.reserved, 0);
  assert.ok(Number.isFinite(s.ledger.spent));
});

test('ledger: a non-finite or negative amount is a BudgetError; an unreadable cost settles at the reservation', async () => {
  const l = new Ledger(tmpDir());
  await l.ensure();
  for (const bad of [Infinity, NaN, -1, undefined, '1']) {
    assert.throws(() => l.reserve(bad, null), (e) => e.name === 'BudgetError' && /unknown cost/.test(e.message), String(bad));
  }
  assert.equal(l.reserved, 0);
  const h = l.reserve(0.25, null);
  l.settle(h, NaN);
  assert.equal(l.reserved, 0);
  assert.equal(l.spent, 0.25);
});

test('max_prompt_tokens: smallest non-zero per id; chunks never exceed it', async () => {
  const list = [
    { ...ep('v/mp', 'P1', 64000, 4096, 0.1, 0.1), max_prompt_tokens: 3000 },
    { ...ep('v/mp', 'P2', 64000, 4096, 0.1, 0.1), max_prompt_tokens: 0 },
    { ...ep('v/mp', 'P3', 64000, 4096, 0.1, 0.1), max_prompt_tokens: null },
    { ...ep('v/mp', 'P4', 64000, 4096, 0.1, 0.1), max_prompt_tokens: 5000 },
  ];
  assert.equal(summarizeZdr(list).get('v/mp').maxPrompt, 3000);
  assert.equal(summarizeZdr([ep('v/x', 'P', 1000, 10, 1, 1)]).get('v/x').maxPrompt, null);

  const s = setup({ models: { mp: { ids: ['v/mp'] } }, defaults: { draft: 'mp' } });
  const text = Array.from({ length: 400 }, (_, i) => `row ${i + 1} ${'w'.repeat(30)}`).join('\n');
  const f = write(path.join(s.root, 'long.md'), text);
  const mock = mockFetch((body) => chatOk(body.model, 'n'), { zdr: list });
  const r = await eyesRun({ task: 't', mode: 'draft', files: [f] }, s.ctx, deps(s, mock));
  // Without the cap, 40% of 64000 would fit everything in one chunk.
  assert.ok(r.plan.chunks.length > 1, `${r.plan.chunks.length} chunks`);
  for (const c of r.plan.chunks) assert.ok(c.promptTokens <= 3000, `${c.promptTokens}`);
});

test('max_prompt_tokens: a fallback id whose max prompt is below the chunk is skipped', async () => {
  const list = [ep('v/a', 'P1', 32000, 2048, 0.1, 0.1), { ...ep('v/b', 'P2', 64000, 4096, 0.1, 0.1), max_prompt_tokens: 300 }];
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), Array.from({ length: 40 }, (_, i) => `line ${i} ${'q'.repeat(40)}`).join('\n'));
  const mock = mockFetch(() => json({ error: { code: 503, message: 'down' } }, 503), { zdr: list });
  await assert.rejects(eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock)), /all ids failed \(v\/a\)/);
  assert.deepEqual([...new Set(mock.chats().map((c) => c.body.model))], ['v/a']);
});

test('max_prompt_tokens too small for any chunk: "context too small" names max_prompt_tokens', async () => {
  const list = [{ ...ep('v/a', 'P1', 32000, 2048, 0.1, 0.1), max_prompt_tokens: 500 }];
  const s = setup({ models: { fast: { ids: ['v/a'] } } });
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const mock = mockFetch(() => assert.fail(), { zdr: list });
  await refused(eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock)), /v\/a: context too small .*max_prompt_tokens 500/);
});

test('failed attempts that may have reached the provider cost the prompt estimate; flagged cost_estimated', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const mock = mockFetch((body, n) => (n <= 2 ? json({ error: { code: 502, message: 'bad gateway' } }, 502) : chatOk(body.model, 'ok', { cost: 0.0001 })));
  const r = await eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock));
  const promptTokens = r.plan.chunks[0].promptTokens;
  const est = (promptTokens * 0.2) / 1e6; // v/a: highest ZDR input price 0.2 per 1M, request price 0
  const rec = JSON.parse(fs.readFileSync(path.join(s.stateDir, 'usage.jsonl'), 'utf8').trim());
  assert.equal(rec.cost_estimated, true);
  assert.equal(rec.failed_attempts, 2);
  assert.ok(Math.abs(rec.cost - (0.0001 + 2 * est)) < 1e-12, `${rec.cost}`);
  assert.ok(Math.abs(s.ledger.spent - rec.cost) < 1e-12, 'the ledger counts the estimate too');
  assert.ok(r.header.includes('(estimated: 2 failed attempt(s) at prompt cost)'), r.header);
  const stats = await eyesStats({}, s.ctx, deps(s, mock));
  assert.ok(/today .*: jobs 1, cost \$\d+\.\d+ \(1 job\(s\) with estimated cost\)/.test(stats), stats);
});

test('network errors and timeouts cost the prompt estimate; 4xx costs nothing', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  let n = 0;
  const net = mockFetch((body) => {
    n++;
    if (n === 1) throw new TypeError('fetch failed');
    return chatOk(body.model, 'ok', { cost: 0 });
  });
  await eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, net));
  const [a] = fs.readFileSync(path.join(s.stateDir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(a.failed_attempts, 1);
  assert.ok(a.cost > 0);

  const t = setup();
  const g = write(path.join(t.root, 'a.md'), 'alpha\n');
  const bad = mockFetch(() => json({ error: { code: 400, message: 'bad' } }, 400));
  await assert.rejects(eyesRun({ task: 't', mode: 'extract', files: [g] }, t.ctx, deps(t, bad)));
  const [b] = fs.readFileSync(path.join(t.stateDir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(b.cost, 0);
  assert.equal(b.cost_estimated, false);
  assert.equal(t.ledger.spent, 0);
});

test('missing usage.cost is estimated from tokens and flagged', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const mock = mockFetch((body) => chatOk(body.model, 'ok', { cost: null, pin: 1000, pout: 100 }));
  const r = await eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock));
  const rec = JSON.parse(fs.readFileSync(path.join(s.stateDir, 'usage.jsonl'), 'utf8').trim());
  assert.equal(rec.usage_cost_missing, true);
  assert.equal(rec.cost_estimated, true);
  assert.ok(Math.abs(rec.cost - (1000 * 0.2 + 100 * 0.4) / 1e6) < 1e-12);
  assert.ok(r.header.includes('estimated: usage.cost missing'), r.header);
});

test('cancel before sending costs nothing and never calls the API', async () => {
  const s = setup();
  const f = write(path.join(s.root, 'a.md'), 'alpha\n');
  const ac = new AbortController();
  ac.abort();
  const mock = mockFetch(() => assert.fail('no chat call'));
  await assert.rejects(eyesRun({ task: 't', mode: 'extract', files: [f] }, s.ctx, deps(s, mock, { signal: ac.signal })), /cancelled/);
  assert.equal(mock.chats().length, 0);
  assert.equal(s.ledger.spent, 0);
});

test('frame markers are neutralised after trimming spaces and tabs', () => {
  for (const l of [FRAME_CLOSE, `\t${FRAME_CLOSE}`, `  ${FRAME_CLOSE}  `, `${FRAME_OPEN}\t`, ` \t${FRAME_OPEN}`]) {
    const n = neutralize(l);
    assert.notEqual(n.trim(), FRAME_CLOSE, JSON.stringify(l));
    assert.notEqual(n.trim(), FRAME_OPEN, JSON.stringify(l));
    assert.ok(n.includes(l), 'the original text is kept, quoted');
  }
  assert.equal(neutralize('--- end --- and more'), '--- end --- and more');
});
