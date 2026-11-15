// Models picked and pinned when the settings name none: candidates, probe, pin, re-pick,
// dry_run, locking, the "auto" alias and how the pin is shown. OpenRouter is stubbed.
// Fake keys only. scan-secrets:allow-file
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { Ledger } from '../src/budget.js';
import { checkConfig } from '../src/check-config.js';
import { parseConfig } from '../src/config.js';
import { Masker } from '../src/mask.js';
import { noUsableModel, summarizeZdr } from '../src/models.js';
import { clearCatalogCache } from '../src/openrouter.js';
import { BUILTIN_CAP, lockTakeover, pickCandidates, pinPath, probeTable, processAlive, readPin, underPickLock, usesAuto } from '../src/pick.js';
import { PROBE_EXPECTED, PROBE_LINES, PROBE_TASK, PROBE_TEXT, PROBE_TIMEOUT_MS, probeVerdict } from '../src/probe.js';
import { eyesRun, pickAgain } from '../src/run.js';
import { eyesStats } from '../src/stats.js';
import { readUsage } from '../src/usage.js';
import { CLI_ARGS, isolatedEnv, tmpDir, writeJson } from './helpers.js';

const KEY = 'sk-' + 'or-v1-FAKE0000000000000000000000000000000000000000000000000000';
const ZDR = 'https://openrouter.ai/api/v1/endpoints/zdr';
const USER = 'https://openrouter.ai/api/v1/models/user';
const MODELS = 'https://openrouter.ai/api/v1/models';
const CHAT = 'https://openrouter.ai/api/v1/chat/completions';
const TODAY = new Date().toISOString().slice(0, 10);

beforeEach(() => clearCatalogCache());

const ep = (model_id, pin, pout, { ctx = 64000, maxOut = 32000, provider = 'P' } = {}) => ({
  model_id,
  provider_name: provider,
  context_length: ctx,
  max_completion_tokens: maxOut,
  pricing: { prompt: String(pin / 1e6), completion: String(pout / 1e6), request: '0' },
});

// Prices in USD per 1M tokens; the built-in cap is in 1 / out 4.
const ZDR_LIST = [
  ep('p/bad', 0.05, 0.1), // cheapest, fails the probe
  ep('p/two', 0.1, 0.2),
  ep('p/three', 0.2, 0.4),
  ep('p/four', 0.3, 0.5),
  ep('p/nolimit', 0.4, 0.6, { maxOut: null }),
  ep('p/short', 0.01, 0.01, { ctx: 16000 }),
  ep('p/smallout', 0.01, 0.01, { maxOut: 4096 }),
  ep('p/pricey', 5, 10),
  ep('p/blocked', 0.01, 0.01),
  ep('p/fast:nitro', 0.01, 0.01),
];
const ACCOUNT = ['p/bad', 'p/two', 'p/three', 'p/four', 'p/nolimit', 'p/short', 'p/smallout', 'p/pricey', 'p/fast:nitro'];

const GOOD = PROBE_EXPECTED.map((n) => `L${n}| ${PROBE_LINES[n - 1]}`).join('\n');
const MISSING = PROBE_EXPECTED.slice(1).map((n) => `L${n}| ${PROBE_LINES[n - 1]}`).join('\n');

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function chatOk(model, content, cost = 0.0001) {
  return json({ id: 'g', model, provider: 'Prov', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 20, cost } });
}

const isProbe = (body) => body.messages[1].content.includes('scheduler[');

// `probe(model)` answers the probe; `job(body)` answers other chat calls.
function mockFetch({ zdr = ZDR_LIST, account = ACCOUNT, probe = (m) => (m === 'p/bad' ? MISSING : GOOD), job = (b) => chatOk(b.model, 'L1| alpha'), user } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: u, body });
    if (u === ZDR) return json({ data: zdr });
    if (u === MODELS) return json({ data: account.map((id) => ({ id })) });
    if (u === USER) return typeof user === 'number' ? json({ error: { code: user, message: 'down' } }, user) : json({ data: account.map((id) => ({ id })) });
    if (u === CHAT) {
      if (isProbe(body)) {
        const a = probe(body.model);
        return a instanceof Response ? a : chatOk(body.model, a);
      }
      return job(body);
    }
    throw new Error(`unexpected url ${u}`);
  };
  const chats = () => calls.filter((c) => c.url === CHAT);
  return { fetch, calls, probes: () => chats().filter((c) => isProbe(c.body)), jobs: () => chats().filter((c) => !isProbe(c.body)) };
}

function setup(extra = {}) {
  const d = tmpDir();
  const root = path.join(d, 'notes');
  fs.mkdirSync(root, { recursive: true });
  const f = path.join(root, 'a.md');
  fs.writeFileSync(f, 'alpha\nbeta\n');
  const config = parseConfig({ read_roots: [root], ...extra });
  const stateDir = path.join(d, 'state');
  const ctx = { config, stateDir: { path: stateDir }, resultsDir: path.join(stateDir, 'results') };
  return { d, root, f, config, ctx, stateDir, ledger: new Ledger(stateDir) };
}

function deps(s, mock, more = {}) {
  return { key: KEY, fetch: mock.fetch, ledger: s.ledger, sleep: async () => {}, ...more };
}

const job = (s, more = {}) => ({ task: 'find alpha', mode: 'extract', files: [s.f], ...more });

async function refused(promise, re) {
  await assert.rejects(promise, (e) => {
    assert.match(e.message, re);
    return true;
  });
}

// ---- the probe ----

test('probe text: 60 lines, the expected lines are exactly the FAILED ones, masking leaves it unchanged', () => {
  assert.equal(PROBE_LINES.length, 60);
  assert.deepEqual(
    PROBE_LINES.map((l, i) => (l.includes('status=FAILED') ? i + 1 : null)).filter(Boolean),
    PROBE_EXPECTED,
  );
  assert.match(PROBE_TASK, /FAILED/);
  assert.equal(new Masker().maskText(PROBE_TEXT), PROBE_TEXT);
  assert.doesNotMatch(PROBE_TEXT, /\d+\.\d+\.\d+\.\d+|https?:|@|\.(com|org|net|io)\b/);
});

test('probeVerdict: pass only with every expected line, all ok, nothing extra, not truncated', () => {
  const item = (line, status = 'ok') => ({ line, status });
  const done = (items, rec = {}) => ({ status: 'done', rec: { truncated: 0, ...rec }, checks: { items } });
  assert.deepEqual(probeVerdict(done(PROBE_EXPECTED.map((n) => item(n)))), { ok: true, reason: null });
  assert.match(probeVerdict(done(PROBE_EXPECTED.slice(1).map((n) => item(n)))).reason, /missing L9/);
  assert.match(probeVerdict(done([...PROBE_EXPECTED, 10].map((n) => item(n)))).reason, /extra L10/);
  assert.match(probeVerdict(done(PROBE_EXPECTED.map((n, i) => item(n, i ? 'ok' : 'ok~')))).reason, /not quoted verbatim \(ok~\)/);
  assert.match(probeVerdict(done(PROBE_EXPECTED.map((n) => item(n)), { truncated: 1 })).reason, /cut off/);
  assert.equal(probeVerdict({ status: 'failed', error: 'HTTP 400: reasoning not supported', rec: {} }).reason, 'HTTP 400: reasoning not supported');
});

// ---- candidates ----

test('candidates: ZDR ∩ account, no refused suffix, context ≥ 32000, max output ≥ 16000 or none, an endpoint within the cap; cheapest first', () => {
  const zdr = summarizeZdr(ZDR_LIST);
  const allowed = ACCOUNT.map((id) => ({ id }));
  assert.deepEqual(pickCandidates(zdr, allowed, BUILTIN_CAP).map((c) => c.id), ['p/bad', 'p/two', 'p/three', 'p/four', 'p/nolimit']);
  // A cap of 0.25 / 1 leaves the cheaper ones; order by the fitting endpoint's prices.
  assert.deepEqual(pickCandidates(zdr, allowed, { in: 0.25, out: 1 }).map((c) => c.id), ['p/bad', 'p/two', 'p/three']);
  // An id whose expensive endpoint is over the cap still counts by its cheap one.
  const mixed = summarizeZdr([ep('m/x', 0.9, 3), ep('m/x', 7, 20, { provider: 'Q' }), ep('m/y', 0.5, 2)]);
  const c = pickCandidates(mixed, [{ id: 'm/x' }, { id: 'm/y' }], BUILTIN_CAP);
  assert.deepEqual(c.map((x) => [x.id, x.fitIn]), [['m/y', 0.5], ['m/x', 0.9]].map(([id, p]) => [id, c.find((z) => z.id === id).fitIn]));
  assert.deepEqual(c.map((x) => x.id), ['m/y', 'm/x']);
  // Same prices: by id.
  const tie = summarizeZdr([ep('t/b', 0.1, 0.1), ep('t/a', 0.1, 0.1)]);
  assert.deepEqual(pickCandidates(tie, [{ id: 't/a' }, { id: 't/b' }], BUILTIN_CAP).map((x) => x.id), ['t/a', 't/b']);
});

test('candidates: no :free variant, and a $0 endpoint does not count; named aliases may still use them', async () => {
  const zdr = summarizeZdr([
    ep('f/zero:free', 0, 0),
    ep('f/zero', 0, 0), // only a free endpoint
    ep('f/mixed', 0, 0),
    ep('f/mixed', 0.3, 0.6, { provider: 'Paid' }), // a free and a paid endpoint
    ep('f/paid', 0.2, 0.4),
  ]);
  const allowed = ['f/zero:free', 'f/zero', 'f/mixed', 'f/paid'].map((id) => ({ id }));
  const c = pickCandidates(zdr, allowed, BUILTIN_CAP);
  clearCatalogCache();
  assert.deepEqual(c.map((x) => [x.id, x.fitIn, x.fitOut]).map(([id, i, o]) => [id, Number(i.toFixed(6)), Number(o.toFixed(6))]), [['f/paid', 0.2, 0.4], ['f/mixed', 0.3, 0.6]]);
  // An alias in the settings still runs on a free variant.
  const s = setup({ models: { gratis: { ids: ['f/zero:free'] } }, defaults: { extract: 'gratis' } });
  const free = ep('f/zero:free', 0, 0);
  const mock = mockFetch({ zdr: [free], account: ['f/zero:free'] });
  await eyesRun(job(s), s.ctx, deps(s, mock));
  assert.deepEqual(mock.jobs().map((x) => x.body.model), ['f/zero:free']);
});

test('the pick never probes a free variant first; a pick from free-only models is refused and says why', async () => {
  const s = setup();
  const mock = mockFetch({ zdr: [ep('p/cheap:free', 0, 0), ...ZDR_LIST], account: ['p/cheap:free', ...ACCOUNT] });
  await eyesRun(job(s), s.ctx, deps(s, mock));
  assert.ok(!mock.probes().some((x) => x.body.model.endsWith(':free')));
  assert.deepEqual(readPin(s.stateDir).pin.ids, ['p/two', 'p/three']);
  clearCatalogCache();
  const f = setup();
  const only = mockFetch({ zdr: [ep('q/one:free', 0, 0), ep('q/two', 0, 0)], account: ['q/one:free', 'q/two'] });
  await refused(eyesRun(job(f), f.ctx, deps(f, only)), /no model to pick: .*a paid endpoint within in \$1 \/ out \$4 per 1M; free variants \(:free, or \$0 endpoints\) match but are not picked: they are rate-limited and come and go; to choose a model yourself/);
  assert.equal(only.probes().length, 0);
  clearCatalogCache();
  const none = setup();
  await assert.rejects(eyesRun(job(none), none.ctx, deps(none, mockFetch({ zdr: [ep('p/pricey', 5, 10)], account: ['p/pricey'] }))), (e) => {
    assert.doesNotMatch(e.message, /free variants/, 'only when free models are why the list is empty');
    return true;
  });
});

test('probe times: in models.json, in the pick table and in the model table; an older pin without them reads fine', async () => {
  const s = setup();
  await eyesRun(job(s), s.ctx, deps(s, mockFetch()));
  const pin = readPin(s.stateDir).pin;
  assert.ok(pin.probe.every((p) => Number.isInteger(p.ms) && p.ms >= 0), JSON.stringify(pin.probe));
  assert.deepEqual(Object.keys(pin.probe[0]), ['id', 'ok', 'reason', 'cost', 'ms']);
  assert.match(probeTable([{ id: 'v/a', ok: true, reason: null, cost: 0.0001, ms: 13900 }])[0], /probe \$0\.000100, 13\.9 s$/);
  const old = setup();
  writePin(old, { ids: ['p/two'], probe: [{ id: 'p/two', ok: true, reason: null, cost: 0.0001 }] });
  assert.equal(probeTable(readPin(old.stateDir).pin.probe)[0], '  ok     p/two  probe $0.000100');
  const stats = await eyesStats({ models: true }, old.ctx, { key: KEY, fetch: mockFetch().fetch, ledger: old.ledger });
  assert.match(stats, /\n  probe ok     p\/two  \$0\.000100\n/);
  const r = await eyesRun(job(old), old.ctx, deps(old, mockFetch()));
  assert.match(r.header, /model: auto -> p\/two \(pinned 2026-11-01\)/);
});

test('usesAuto: only when the settings name no models; an alias named auto wins', () => {
  const none = parseConfig({});
  assert.equal(usesAuto(undefined, 'extract', none), true);
  assert.equal(usesAuto('auto', 'draft', none), true);
  const named = parseConfig({ models: { fast: { ids: ['v/a'] } }, defaults: { extract: 'fast' } });
  assert.equal(usesAuto(undefined, 'extract', named), false);
  assert.equal(usesAuto('auto', 'extract', named), false);
  const own = parseConfig({ models: { auto: { ids: ['v/a'] } } });
  assert.equal(usesAuto('auto', 'extract', own), false);
  const raw = parseConfig({ allow_raw_model_ids: true });
  assert.equal(usesAuto('v/raw', 'extract', raw), false);
});

// ---- pick, probe, pin ----

test('first job picks: probes in order until two pass, pins both, runs on the first; header, pin file, usage', async () => {
  const s = setup();
  const mock = mockFetch();
  const r = await eyesRun(job(s), s.ctx, deps(s, mock));
  assert.deepEqual(mock.probes().map((c) => c.body.model), ['p/bad', 'p/two', 'p/three'], 'two passed after three tries; p/four is never probed');
  const lines = r.header.split('\n');
  assert.equal(lines[1], 'model: auto picked p/two (probe ok, $0.000100)');
  assert.match(r.header, /\nprobes: p\/bad failed \(missing L9\); p\/two ok; p\/three ok; total \$0\.000300\n/);
  // Probes and the job use the normal request: ZDR, reasoning off, the built-in cap.
  for (const c of [...mock.probes(), ...mock.jobs()]) {
    assert.deepEqual(c.body.provider, { zdr: true, data_collection: 'deny', max_price: { prompt: 1, completion: 4 } });
    assert.deepEqual(c.body.reasoning, { effort: 'none' });
  }
  assert.equal(mock.probes()[0].body.messages[1].content.includes(PROBE_TASK), true);
  assert.deepEqual(mock.jobs().map((c) => c.body.model), ['p/two']);

  const pin = JSON.parse(fs.readFileSync(pinPath(s.stateDir), 'utf8'));
  assert.deepEqual(Object.keys(pin), ['picked_at', 'ids', 'cap', 'probe']);
  assert.deepEqual(pin.ids, ['p/two', 'p/three']);
  assert.deepEqual(pin.cap, { in: 1, out: 4 });
  assert.deepEqual(pin.probe.map((p) => [p.id, p.ok, p.reason, p.cost]), [
    ['p/bad', false, 'missing L9', 0.0001],
    ['p/two', true, null, 0.0001],
    ['p/three', true, null, 0.0001],
  ]);
  assert.match(pin.picked_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(fs.readdirSync(s.stateDir).filter((n) => n.startsWith('models.json') || n.startsWith('.models')), ['models.json'], 'no temp or lock file left');

  const usage = await readUsage(s.stateDir);
  assert.deepEqual(usage.map((u) => u.tool), ['probe', 'probe', 'probe', 'eyes_run']);
  assert.ok(usage.slice(0, 3).every((u) => u.alias === null && u.check.mode === 'extract'));
  assert.equal(usage[3].alias, 'auto');
  assert.ok(Math.abs(s.ledger.spent - 0.0004) < 1e-12, 'probe cost counts in the daily budget');
  const stats = await eyesStats({}, s.ctx, { key: null, fetch: mock.fetch, ledger: s.ledger });
  assert.match(stats, /today \(UTC [\d-]+\): jobs 1, cost \$0\.0001/, 'probes are not jobs in eyes_stats');
  assert.match(stats, /alias auto: jobs 1/);
  assert.match(stats, /spent today \$0\.0004/);
});

test('second job uses the pin: header names it with its date; no probe', async () => {
  const s = setup();
  const mock = mockFetch();
  await eyesRun(job(s), s.ctx, deps(s, mock));
  const before = mock.probes().length;
  const r = await eyesRun(job(s), s.ctx, deps(s, mock));
  assert.equal(mock.probes().length, before);
  assert.equal(r.header.split('\n')[1], `model: auto -> p/two (pinned ${TODAY})`);
  const r2 = await eyesRun(job(s, { model: 'auto', mode: 'draft', task: 'summarize' }), s.ctx, deps(s, mock));
  assert.equal(r2.header.split('\n')[1], `model: auto -> p/two (pinned ${TODAY})`, 'auto for every mode, also when named');
});

function writePin(s, pin) {
  fs.mkdirSync(s.stateDir, { recursive: true });
  fs.writeFileSync(pinPath(s.stateDir), JSON.stringify({ picked_at: '2026-11-01T10:00:00.000Z', cap: { in: 1, out: 4 }, probe: [], ...pin }));
}

test('a pinned id that became unusable is skipped for the next pinned id; the pin does not move', async () => {
  const s = setup();
  writePin(s, { ids: ['p/gone', 'p/three'] });
  const mock = mockFetch();
  const r = await eyesRun(job(s), s.ctx, deps(s, mock));
  const lines = r.header.split('\n');
  assert.equal(lines[1], 'model: auto -> p/three (pinned 2026-11-01)');
  assert.equal(lines[2], 'pinned p/gone skipped: no ZDR endpoint');
  assert.equal(mock.probes().length, 0);
  assert.deepEqual(readPin(s.stateDir).pin.ids, ['p/gone', 'p/three']);
});

test('no pinned id usable: the server picks again and the header names old, new and the reason', async () => {
  const s = setup();
  writePin(s, { ids: ['p/pricey', 'p/gone'] });
  const mock = mockFetch();
  const r = await eyesRun(job(s), s.ctx, deps(s, mock));
  assert.equal(r.header.split('\n')[1], 'model: auto re-picked: p/pricey -> p/two (over price cap (no ZDR endpoint within in $1 / out $4 per 1M; lowest in $5 / out $10))');
  assert.deepEqual(readPin(s.stateDir).pin.ids, ['p/two', 'p/three']);
});

test('a pin file that cannot be parsed is kept under a new name and the server picks again, saying so', async () => {
  const s = setup();
  fs.mkdirSync(s.stateDir, { recursive: true });
  fs.writeFileSync(pinPath(s.stateDir), '{ not json');
  const mock = mockFetch();
  const r = await eyesRun(job(s), s.ctx, deps(s, mock));
  assert.equal(r.header.split('\n')[1], 'model: auto picked p/two (probe ok, $0.000100)');
  assert.match(r.header, /\nthe pin file could not be used \(not valid JSON\); kept as .*models\.json\.unreadable-\d{8}T\d{6}Z; picked again\n/);
  const aside = fs.readdirSync(s.stateDir).filter((n) => n.startsWith('models.json.unreadable-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(s.stateDir, aside[0]), 'utf8'), '{ not json', 'kept as it was');
  assert.deepEqual(readPin(s.stateDir).pin.ids, ['p/two', 'p/three']);
  // A second broken pin gets its own name; the first one stays.
  fs.writeFileSync(pinPath(s.stateDir), '[]');
  await eyesRun(job(s), s.ctx, deps(s, mockFetch()));
  assert.equal(fs.readdirSync(s.stateDir).filter((n) => n.startsWith('models.json.unreadable-')).length, 2);
});

test('dry_run never probes and never writes a pin; without a pin: not picked yet, max_context or 32000, model null', async () => {
  const s = setup();
  const mock = mockFetch();
  const r = await eyesRun(job(s, { dry_run: true }), s.ctx, deps(s, mock));
  assert.equal(mock.calls.filter((c) => c.url === CHAT).length, 0);
  assert.equal(fs.existsSync(pinPath(s.stateDir)), false);
  assert.match(r.header, /\nmodel: auto \(not picked yet\)\n/);
  assert.match(r.header, /input budget ~\d+ tokens each \(32000 tokens; no model picked yet\)/);
  assert.equal(r.bodies[0].model, null);
  assert.deepEqual(r.bodies[0].provider, { zdr: true, data_collection: 'deny', max_price: { prompt: 1, completion: 4 } });
  const m = setup({ max_context: 9000 });
  const rm = await eyesRun(job(m, { dry_run: true }), m.ctx, deps(m, mockFetch()));
  assert.match(rm.header, /\(max_context 9000; no model picked yet\)/);
  // With a pin: the pinned id, still no probe.
  writePin(s, { ids: ['p/three'] });
  const p = await eyesRun(job(s, { dry_run: true }), s.ctx, deps(s, mock));
  assert.match(p.header, /\nmodel: auto -> p\/three \(pinned 2026-11-01\)\n/);
  assert.equal(p.bodies[0].model, 'p/three');
  assert.equal(mock.calls.filter((c) => c.url === CHAT).length, 0);
});

test('nothing passes: up to five probes, the refusal names each tried id with its reason and the action; no pin', async () => {
  const many = Array.from({ length: 7 }, (_, i) => ep(`q/m${i}`, 0.1 + i / 100, 0.2));
  const s = setup();
  const mock = mockFetch({ zdr: many, account: many.map((e) => e.model_id), probe: (m) => (m === 'q/m2' ? json({ error: { code: 400, message: 'reasoning is not supported' } }, 400) : MISSING) });
  await refused(
    eyesRun(job(s), s.ctx, deps(s, mock)),
    /no model passed the probe: q\/m0: missing L9; q\/m1: missing L9; q\/m2: .*reasoning is not supported.*; q\/m3: missing L9; q\/m4: missing L9; to choose a model yourself: `cheap-eyes models --candidates`, then `cheap-eyes set models\.<alias> <id>`/,
  );
  assert.equal(mock.probes().length, 5);
  assert.equal(mock.jobs().length, 0);
  assert.equal(fs.existsSync(pinPath(s.stateDir)), false);
  assert.equal(fs.existsSync(`${pinPath(s.stateDir)}.lock`), false, 'the lock is released');
});

test('no candidate at all: the refusal says why and names the action', async () => {
  const s = setup();
  const mock = mockFetch({ zdr: [ep('p/pricey', 5, 10)], account: ['p/pricey'] });
  await refused(eyesRun(job(s), s.ctx, deps(s, mock)), /no model to pick: .*within in \$1 \/ out \$4 per 1M; to choose a model yourself/);
  assert.equal(mock.probes().length, 0);
});

test('account list unavailable: public text models stand in, and the refusal says availability is unknown', async () => {
  const s = setup();
  const ok = mockFetch({ user: 503 });
  const r = await eyesRun(job(s), s.ctx, deps(s, ok));
  assert.equal(r.header.split('\n')[1], 'model: auto picked p/two (probe ok, $0.000100)');
  assert.ok(ok.calls.some((c) => c.url === MODELS), 'GET /models was read');
  const t = setup();
  await refused(eyesRun(job(t), t.ctx, deps(t, mockFetch({ user: 503, probe: () => MISSING }))), /account availability unknown/);
});

test('max_price_usd_per_mtok, when set, is the cap of picked models instead of the built-in one', async () => {
  const s = setup({ max_price_usd_per_mtok: { in: 0.15, out: 0.3 } });
  const mock = mockFetch();
  await eyesRun(job(s), s.ctx, deps(s, mock));
  // p/three and later are over 0.15 / 0.3: only p/bad and p/two were candidates, one passed.
  assert.deepEqual(mock.probes().map((c) => c.body.model), ['p/bad', 'p/two']);
  assert.deepEqual(mock.probes()[0].body.provider.max_price, { prompt: 0.15, completion: 0.3 });
  assert.deepEqual(mock.jobs()[0].body.provider.max_price, { prompt: 0.15, completion: 0.3 });
  const pin = readPin(s.stateDir).pin;
  assert.deepEqual(pin.ids, ['p/two'], 'one id passed: one id pinned');
  assert.deepEqual(pin.cap, { in: 0.15, out: 0.3 });
});

test('probe cost is reserved in the daily budget; a budget refusal stops the pick', async () => {
  const s = setup({ daily_budget_usd: 0.001 });
  fs.mkdirSync(s.stateDir, { recursive: true });
  fs.writeFileSync(path.join(s.stateDir, 'usage.jsonl'), JSON.stringify({ ts: new Date().toISOString(), tool: 'eyes_run', cost: 0.001 }) + '\n');
  const mock = mockFetch();
  await refused(eyesRun(job(s), s.ctx, deps(s, mock)), /picking stopped: daily budget exceeded/);
  assert.equal(mock.probes().length, 0);
  const usage = await readUsage(s.stateDir);
  assert.equal(usage.at(-1).tool, 'probe');
  assert.equal(usage.at(-1).error, 'budget');
});

test('two jobs at the same time: one pick; the other finds the pin and uses it', async () => {
  const s = setup();
  const mock = mockFetch();
  const [a, b] = await Promise.all([eyesRun(job(s), s.ctx, deps(s, mock)), eyesRun(job(s), s.ctx, deps(s, mock))]);
  assert.deepEqual(mock.probes().map((c) => c.body.model), ['p/bad', 'p/two', 'p/three'], 'probed once');
  const lines = [a.header.split('\n')[1], b.header.split('\n')[1]].sort();
  assert.deepEqual(lines, ['model: auto -> p/two (pinned ' + TODAY + ')', 'model: auto picked p/two (probe ok, $0.000100)'].sort());
});

test('across processes: a waiter takes the pin another process writes; a stale lock is taken over', async () => {
  const s = setup();
  fs.mkdirSync(s.stateDir, { recursive: true });
  const lock = `${pinPath(s.stateDir)}.lock`;
  fs.writeFileSync(lock, '{"pid":1}\n');
  const theirs = { picked_at: '2026-11-15T09:00:00.000Z', ids: ['p/three'], cap: { in: 1, out: 4 }, probe: [] };
  setTimeout(() => {
    fs.writeFileSync(pinPath(s.stateDir), JSON.stringify(theirs));
    fs.unlinkSync(lock);
  }, 150);
  let ran = false;
  const got = await underPickLock(s.stateDir, null, async () => {
    ran = true;
    return {};
  }, { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) });
  assert.equal(ran, false);
  assert.deepEqual(got, { pin: theirs, picked: false });

  fs.writeFileSync(lock, '{"pid":1}\n');
  const old = new Date(Date.now() - 60 * 60e3);
  fs.utimesSync(lock, old, old);
  const mine = { picked_at: '2026-11-15T10:00:00.000Z', ids: ['p/two'], cap: { in: 1, out: 4 }, probe: [] };
  const took = await underPickLock(s.stateDir, theirs.picked_at, async () => mine);
  assert.deepEqual(took, { pin: mine, picked: true });
  assert.equal(fs.existsSync(lock), false);
});

// ---- the lock: crashed holders, stale locks, waiting ----

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

function lockFile(s, content, ageMs = 0) {
  fs.mkdirSync(s.stateDir, { recursive: true });
  const lock = `${pinPath(s.stateDir)}.lock`;
  fs.writeFileSync(lock, typeof content === 'string' ? content : JSON.stringify(content) + '\n');
  if (ageMs) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(lock, t, t);
  }
  return lock;
}

const NEW_PIN = { picked_at: '2026-11-15T10:00:00.000Z', ids: ['p/two'], cap: { in: 1, out: 4 }, probe: [] };

test('lock content: pid, host and time of the holder; removed afterwards', async () => {
  const s = setup();
  let seen = null;
  await underPickLock(s.stateDir, null, async () => {
    seen = JSON.parse(fs.readFileSync(`${pinPath(s.stateDir)}.lock`, 'utf8'));
    return NEW_PIN;
  });
  assert.deepEqual(Object.keys(seen), ['pid', 'host', 'at']);
  assert.equal(seen.pid, process.pid);
  assert.equal(seen.host, os.hostname());
  assert.match(seen.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(fs.existsSync(`${pinPath(s.stateDir)}.lock`), false);
});

test('lock of a process that is gone (same machine) is taken over at once', async () => {
  const s = setup();
  const lock = lockFile(s, { pid: deadPid(), host: os.hostname(), at: new Date().toISOString() });
  const t0 = Date.now();
  const got = await underPickLock(s.stateDir, null, async () => NEW_PIN, { waitMs: 10_000 });
  assert.deepEqual(got, { pin: NEW_PIN, picked: true });
  assert.ok(Date.now() - t0 < 2000, `no waiting: ${Date.now() - t0} ms`);
  assert.equal(fs.existsSync(lock), false);
});

test('lock of a live process, or one recorded on another machine, is waited for; the waiter is refused with the reason', async () => {
  for (const holder of [{ pid: process.pid, host: os.hostname() }, { pid: deadPid(), host: 'another-machine' }]) {
    const s = setup();
    const lock = lockFile(s, { ...holder, at: '2026-11-15T09:00:00.000Z' });
    let ran = false;
    await refused(
      underPickLock(s.stateDir, null, async () => ((ran = true), NEW_PIN), { waitMs: 100, sleep: (ms) => new Promise((r) => setTimeout(r, 20)) }),
      new RegExp(`models are being picked by process ${holder.pid}.* since 2026-11-15T09:00:00\\.000Z \\(lock .*models\\.json\\.lock\\); waited 0 s\\. Try again in a few minutes; if no other cheap-eyes is running, delete the lock file`),
    );
    assert.equal(ran, false);
    assert.equal(fs.existsSync(lock), true, 'a live holder keeps its lock');
  }
});

test('a lock older than 10 minutes is taken over even when its process runs or its content is unreadable', async () => {
  for (const content of [{ pid: process.pid, host: os.hostname(), at: 'x' }, 'not json']) {
    const s = setup();
    lockFile(s, content, 11 * 60e3);
    const got = await underPickLock(s.stateDir, null, async () => NEW_PIN, { waitMs: 10_000 });
    assert.equal(got.picked, true);
  }
  const s = setup();
  lockFile(s, 'not json', 9 * 60e3);
  await refused(underPickLock(s.stateDir, null, async () => NEW_PIN, { waitMs: 50, sleep: () => new Promise((r) => setTimeout(r, 10)) }), /models are being picked \(lock /);
});

test('lockTakeover: gone process on this host, age, unreadable content, other host', () => {
  const host = 'me';
  const alive = (pid) => pid === 1;
  assert.equal(lockTakeover('{"pid":2,"host":"me"}', 0, { host, alive }), 'process 2 is gone');
  assert.equal(lockTakeover('{"pid":1,"host":"me"}', 0, { host, alive }), null);
  assert.equal(lockTakeover('{"pid":2,"host":"them"}', 0, { host, alive }), null);
  assert.equal(lockTakeover('{"pid":1,"host":"me"}', 10 * 60e3 + 1, { host, alive }), 'older than 10 minutes');
  assert.equal(lockTakeover('garbage', 1000, { host, alive }), null);
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(deadPid()), false);
});

// ---- probe limits ----

test('a probe call has its own limits: no retry after 429, 60 s by default, no re-split; the next candidate is tried', async () => {
  assert.equal(PROBE_TIMEOUT_MS, 60_000);
  const s = setup();
  const mock = mockFetch({ probe: (m) => (m === 'p/bad' ? json({ error: { code: 429, message: 'rate limited' } }, 429) : GOOD) });
  const r = await eyesRun(job(s), s.ctx, deps(s, mock));
  assert.deepEqual(mock.probes().map((c) => c.body.model), ['p/bad', 'p/two', 'p/three'], 'p/bad called once');
  assert.match(readPin(s.stateDir).pin.probe[0].reason, /HTTP 429: rate limited/);
  assert.equal(r.header.split('\n')[1], 'model: auto picked p/two (probe ok, $0.000100)');

  const cut = setup();
  const truncated = mockFetch({ probe: (m) => (m === 'p/bad' ? json({ id: 'g', model: m, choices: [{ finish_reason: 'length', message: { content: GOOD } }], usage: { cost: 0.0001 } }) : GOOD) });
  await eyesRun(job(cut), cut.ctx, deps(cut, truncated));
  assert.equal(truncated.probes().filter((c) => c.body.model === 'p/bad').length, 1, 'a cut probe answer is not re-split');
  assert.match(readPin(cut.stateDir).pin.probe[0].reason, /cut off/);
});

test('a probe call that takes too long is cut at its limit and recorded as failed', async () => {
  const s = setup();
  const base = mockFetch();
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (body && isProbe(body) && body.model === 'p/bad') {
      base.calls.push({ url: String(url), body });
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }
    return base.fetch(url, init);
  };
  const seen = [];
  // The timeout timer of AbortSignal.timeout does not keep the process alive, and this
  // stub holds no socket that would.
  const keep = setInterval(() => {}, 1000);
  try {
    await eyesRun(job(s), s.ctx, deps(s, { fetch }, { probeTimeoutMs: 50, onProbe: (p) => seen.push(p) }));
  } finally {
    clearInterval(keep);
  }
  assert.match(readPin(s.stateDir).pin.probe[0].reason, /timed out/);
  assert.deepEqual(seen.map((p) => p.id), ['p/bad', 'p/two', 'p/three']);
  assert.ok(seen.every((p) => typeof p.ms === 'number'), 'each probe reports how long it took');
  assert.equal(typeof readPin(s.stateDir).pin.probe[0].ms, 'number', 'the pin records how long each probe took');
});

test('normal jobs keep their retries', async () => {
  const s = setup();
  writePin(s, { ids: ['p/two'] });
  let n = 0;
  const mock = mockFetch({ job: (b) => (++n === 1 ? json({ error: { code: 429, message: 'busy' } }, 429) : chatOk(b.model, 'L1| alpha')) });
  await eyesRun(job(s), s.ctx, deps(s, mock));
  assert.deepEqual(mock.jobs().map((c) => c.body.model), ['p/two', 'p/two'], 'retried on the same id');
});

// ---- eyes_stats counts probes apart ----

test('eyes_stats: probes on their own line in today and all time; jobs plus probes equal the budget spend', async () => {
  const s = setup();
  await eyesRun(job(s), s.ctx, deps(s, mockFetch()));
  const out = await eyesStats({}, s.ctx, { key: null, fetch: mockFetch().fetch, ledger: s.ledger });
  const lines = out.split('\n');
  const today = lines.findIndex((l) => l.startsWith('today (UTC'));
  const all = lines.findIndex((l) => l.startsWith('all time:'));
  assert.match(lines[today], /: jobs 1, cost \$0\.0001,/);
  assert.equal(lines[today + 1], '  probes (model pick): 3, cost $0.0003; with the jobs $0.0004');
  assert.match(lines[all], /: jobs 1, cost \$0\.0001,/);
  assert.equal(lines[all + 1], '  probes (model pick): 3, cost $0.0003; with the jobs $0.0004');
  assert.match(out, /  alias auto: jobs 1, cost \$0\.0001/);
  assert.doesNotMatch(out, /alias \(raw id\)/, 'probes are not an alias');
  assert.match(out, /spent today \$0\.0004/);
});

// ---- "auto" and named aliases ----

test('an alias named auto in the settings wins: nothing is picked', async () => {
  const s = setup({ models: { auto: { ids: ['p/four'] } }, defaults: { extract: 'auto' } });
  const mock = mockFetch();
  const r = await eyesRun(job(s), s.ctx, deps(s, mock));
  assert.equal(mock.probes().length, 0);
  assert.match(r.header, /\nmodel: alias auto -> p\/four/);
  assert.equal(fs.existsSync(pinPath(s.stateDir)), false);
  assert.equal(mock.jobs()[0].body.provider.max_price, undefined, 'no built-in cap for named models');
});

test('with named aliases, model "auto" is an unknown alias', async () => {
  const s = setup({ models: { fast: { ids: ['p/two'] } }, defaults: { extract: 'fast' } });
  await refused(eyesRun(job(s, { model: 'auto' }), s.ctx, deps(s, mockFetch())), /unknown model alias: auto/);
});

// ---- refusals that name each id and how to pick again ----

const MAX_PRICE_404 = () => json({ error: { code: 404, message: 'No endpoints found that satisfy the max price for this request' } }, 404);

test('a 404 for the max price on every id: the refusal names each id with what OpenRouter answered', async () => {
  const s = setup({ models: { fast: { ids: ['p/two', 'p/three'] } }, defaults: { extract: 'fast' }, max_price_usd_per_mtok: { in: 1, out: 4 } });
  const mock = mockFetch({ job: MAX_PRICE_404 });
  await refused(
    eyesRun(job(s), s.ctx, deps(s, mock)),
    /all ids failed \(p\/two, p\/three\): p\/two: no ZDR endpoint within the price cap in \$1 \/ out \$4 per 1M at call time \(OpenRouter: .*satisfy the max price.*\); p\/three: no ZDR endpoint within the price cap/,
  );
  assert.deepEqual(mock.jobs().map((c) => c.body.model), ['p/two', 'p/three'], 'moved on to the next id');
});

test('with the pin in use, refusals add how to pick again', async () => {
  const s = setup();
  writePin(s, { ids: ['p/two', 'p/three'] });
  await refused(eyesRun(job(s), s.ctx, deps(s, mockFetch({ job: MAX_PRICE_404 }))), /p\/three: no ZDR endpoint within the price cap .* — to pick again: run `cheap-eyes models --pick`/);
  const e = noUsableModel('auto', [{ id: 'p/two', ok: false, reason: 'context too small' }], [], 'to pick again: run `cheap-eyes models --pick`');
  assert.equal(e.message, 'no usable model for auto: p/two: context too small — to pick again: run `cheap-eyes models --pick`');
});

// ---- showing the pin ----

test('eyes_stats {models: true} and the model table show the pin, its date and the probe result', async () => {
  const s = setup();
  const before = await eyesStats({ models: true }, s.ctx, { key: KEY, fetch: mockFetch().fetch, ledger: s.ledger });
  assert.match(before, /auto: not picked yet; the first model job picks and pins, or run `cheap-eyes models --pick`/);
  assert.doesNotMatch(before, /no model aliases in config/);
  await eyesRun(job(s), s.ctx, deps(s, mockFetch()));
  const out = await eyesStats({ models: true }, s.ctx, { key: KEY, fetch: mockFetch().fetch, ledger: s.ledger });
  assert.match(out, /defaults: every mode -> auto \(the settings name no models; picked models, cap in \$1 \/ out \$4 per 1M\)/);
  assert.match(out, new RegExp(`auto: pinned ${TODAY} \\(.*models\\.json; picked at ${TODAY}T`));
  assert.match(out, /  probe failed p\/bad  \$0\.000100, \d+\.\d s  \(missing L9\)/);
  assert.match(out, /  probe ok     p\/two  \$0\.000100, \d+\.\d s/);
  assert.match(out, /auto -> p\/two  \(jobs 1, /);
  assert.match(out, /\* p\/two +zdr 1/);
});

test('check-config shows auto (pinned <id>, <date>) or auto (not picked yet), offline', async () => {
  const s = setup();
  const env = { CHEAP_EYES_STATE_DIR: s.stateDir };
  const opts = { env, cwd: s.root, homedir: s.d };
  assert.match((await checkConfig(opts)).text, /\nmodels: +auto \(not picked yet\)\n/);
  writePin(s, { ids: ['p/two', 'p/three'] });
  assert.match((await checkConfig(opts)).text, /\nmodels: +auto \(pinned p\/two, 2026-11-01; next: p\/three\)\n/);
  fs.writeFileSync(pinPath(s.stateDir), 'garbage');
  assert.match((await checkConfig(opts)).text, /\nmodels: +auto \(the pin file cannot be used: not valid JSON; the next model job sets it aside and picks again\)\n/);
});

// ---- models --pick ----

test('pickAgain picks anew even with a usable pin, and the table lists each tried id', async () => {
  const s = setup();
  writePin(s, { ids: ['p/four'] });
  const mock = mockFetch();
  const r = await pickAgain(s.ctx, deps(s, mock));
  assert.equal(r.picked, true);
  assert.deepEqual(r.pin.ids, ['p/two', 'p/three']);
  assert.deepEqual(readPin(s.stateDir).pin.ids, ['p/two', 'p/three']);
  const table = probeTable(r.pin.probe, r.cands);
  assert.match(table[0], /^  failed p\/bad  in \$0\.05 \/ out \$0\.1 per 1M  probe \$0\.000100, \d+\.\d s  \(missing L9\)$/);
  assert.match(table[1], /^  ok     p\/two  in \$0\.1 \/ out \$0\.2 per 1M  probe \$0\.000100, \d+\.\d s$/);
  const named = setup({ models: { fast: { ids: ['p/two'] } } });
  await refused(pickAgain(named.ctx, deps(named, mock)), /the settings name models \(fast\): picked models are used only when the settings name none/);
});

test('models --pick: no key, and no network, end with a clear message and exit 1', () => {
  const d = tmpDir();
  const env = isolatedEnv(path.join(d, 'home'), { HOME: path.join(d, 'home'), USERPROFILE: path.join(d, 'home'), CHEAP_EYES_STATE_DIR: path.join(d, 'state') });
  const run = (e) => spawnSync(process.execPath, [...CLI_ARGS, 'models', '--pick'], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...e }, cwd: d, encoding: 'utf8' });
  const nokey = run(env);
  assert.equal(nokey.status, 1);
  assert.match(nokey.stderr, /OpenRouter key is not set/);
  const offline = run({ ...env, CHEAP_EYES_OPENROUTER_KEY: KEY });
  assert.equal(offline.status, 1);
  assert.match(offline.stderr, /network is disabled in tests/);
  assert.ok(!(offline.stdout + offline.stderr).includes(KEY));
  const cfg = writeJson(path.join(d, 'cfg.json'), { models: { fast: { ids: ['p/two'] } } });
  const named = run({ ...env, CHEAP_EYES_CONFIG: cfg, CHEAP_EYES_OPENROUTER_KEY: KEY });
  assert.equal(named.status, 1);
  assert.match(named.stderr, /the settings name models \(fast\)/);
});
