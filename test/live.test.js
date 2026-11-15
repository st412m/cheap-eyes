// Live smoke test against OpenRouter. Runs only with CHEAP_EYES_LIVE=1 and
// CHEAP_EYES_OPENROUTER_KEY set; spends a fraction of a cent.
// Model: CHEAP_EYES_LIVE_MODEL, or else the cheapest ZDR text model with ≥ 16k context.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Ledger } from '../src/budget.js';
import { parseConfig } from '../src/config.js';
import { candidates, fmtPrice, loadAccount, summarizeZdr } from '../src/models.js';
import { ApiError, OpenRouter, safeErrorText } from '../src/openrouter.js';
import { hasFreeSuffix } from '../src/model-ids.js';
import { capFor, capText, pickCandidates, pinPath } from '../src/pick.js';
import { eyesRun, pickAgain } from '../src/run.js';
import { eyesStats } from '../src/stats.js';
import { readUsage } from '../src/usage.js';
import { tmpDir } from './helpers.js';

const LIVE = process.env.CHEAP_EYES_LIVE === '1' && Boolean(process.env.CHEAP_EYES_OPENROUTER_KEY);

// CHEAP_EYES_LIVE_MODEL, or else the cheapest ZDR text model with ≥ 16k context and input ≤ $0.5 per 1M.
async function liveModel(root) {
  if (process.env.CHEAP_EYES_LIVE_MODEL) return process.env.CHEAP_EYES_LIVE_MODEL;
  const or = new OpenRouter();
  const probe = parseConfig({ read_roots: [root] });
  const [c] = candidates(probe, summarizeZdr(await or.zdrEndpoints()), await or.textModels(), { min_context: 16000, max_price_in: 0.5 });
  assert.ok(c, 'no cheap ZDR text model found');
  return c.id;
}

// Account availability: GET /models/user ("models filtered by user provider preferences,
// privacy settings, and guardrails"). Confirms the inference key is accepted and names
// the field that carries the model id. Prints status, counts and field names — never the key.
test('live: /models/user accepts the inference key', { skip: !LIVE && 'set CHEAP_EYES_LIVE=1 and CHEAP_EYES_OPENROUTER_KEY', timeout: 60_000 }, async () => {
  const res = await fetch('https://openrouter.ai/api/v1/models/user', {
    headers: { accept: 'application/json', authorization: `Bearer ${process.env.CHEAP_EYES_OPENROUTER_KEY}` },
    redirect: 'error',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  const data = Array.isArray(json?.data) ? json.data : null;
  console.log(`GET /models/user: HTTP ${res.status}; data[]: ${data ? data.length : 'absent'}`);
  if (!res.ok || !data) console.log(`error: ${JSON.stringify(json?.error ?? null).slice(0, 300)}`);
  assert.equal(res.status, 200, 'the inference key is accepted');
  assert.ok(data && data.length > 0, 'data[] is a non-empty array');
  console.log(`fields of data[0]: ${Object.keys(data[0]).join(', ')}`);
  assert.equal(typeof data[0].id, 'string', 'data[].id carries the model id');
  const user = new Set(data.map((m) => m.id));
  const zdrIds = [...summarizeZdr(await new OpenRouter().zdrEndpoints()).keys()];
  const absent = zdrIds.filter((id) => !user.has(id));
  console.log(`ZDR model ids: ${zdrIds.length}; absent from /models/user (blocked by account): ${absent.length}`);
  for (const id of (process.env.CHEAP_EYES_LIVE_CHECK_IDS ?? '').split(',').filter(Boolean)) {
    console.log(`  ${id}: ${user.has(id) ? 'available' : 'blocked by account'}`);
  }
});

test('live: one extract call through a ZDR endpoint', { skip: !LIVE && 'set CHEAP_EYES_LIVE=1 and CHEAP_EYES_OPENROUTER_KEY', timeout: 300_000 }, async () => {
  const d = tmpDir();
  const root = path.join(d, 'notes');
  fs.mkdirSync(root);
  const f = path.join(root, 'net.md');
  fs.writeFileSync(f, 'Network notes\nThe gateway is 192.0.2.7 on port 8443.\npassword: not-a-real-one\nEnd.\n');

  const model = await liveModel(root);
  const config = parseConfig({
    read_roots: [root],
    // Reasoning off: otherwise a reasoning model can spend the whole output cap thinking
    // and return an empty answer with finish_reason "length".
    models: { live: { ids: [model], params: { temperature: 0, reasoning: { effort: 'none' } } } },
    defaults: { extract: 'live' },
    daily_budget_usd: 0.05,
  });
  const stateDir = path.join(d, 'state');
  const ctx = { config, stateDir: { path: stateDir }, resultsDir: path.join(stateDir, 'results') };
  const ledger = new Ledger(stateDir);

  const r = await eyesRun({ task: 'Quote the line that gives the gateway address.', mode: 'extract', files: [f], max_tokens: 1024 }, ctx, { ledger });
  console.log(r.header);
  assert.ok(r.outs[0].model, 'the response names the model used');
  assert.ok(r.text.trim().length > 0, `non-empty output (finish_reason ${r.outs[0].finish_reason})`);
  const s = r.checks.summary;
  assert.equal(s.bad, 0, `extract check: ${JSON.stringify(s)}`);
  assert.ok(s.ok + s['ok~'] + s.partial >= 1, `at least one verified line: ${JSON.stringify(s)}`);
  const rec = JSON.parse(fs.readFileSync(path.join(stateDir, 'usage.jsonl'), 'utf8').trim());
  assert.equal(rec.status, 'done');
  assert.equal(rec.check.mode, 'extract');
  assert.ok(rec.cost >= 0 && rec.cost < 0.05, `cost ${rec.cost}`);
  assert.ok(rec.tokens_in > 0);
  const body = fs.readFileSync(path.join(ctx.resultsDir, `${r.id}.md`), 'utf8');
  assert.ok(!body.includes('not-a-real-one'), 'the masked value never came back');

  const stats = await eyesStats({ models: true }, ctx, { ledger });
  console.log(stats);
  assert.match(stats, /key: limit/);
});

// The pick through the same functions eyes_run uses, then one job on the pin. No
// models in the settings, a daily budget of $0.05, a temporary state folder.
// CHEAP_EYES_LIVE_MODEL is not used: the pick chooses.
test('live: pick and pin', { skip: !LIVE && 'set CHEAP_EYES_LIVE=1 and CHEAP_EYES_OPENROUTER_KEY', timeout: 900_000 }, async () => {
  const d = tmpDir();
  const root = path.join(d, 'notes');
  fs.mkdirSync(root);
  const f = path.join(root, 'net.md');
  fs.writeFileSync(f, 'Network notes\nThe gateway answers on port 8443.\nBackups run nightly.\nEnd.\n');
  const config = parseConfig({ read_roots: [root], daily_budget_usd: 0.05 });
  const stateDir = path.join(d, 'state');
  const ctx = { config, stateDir: { path: stateDir }, resultsDir: path.join(stateDir, 'results') };
  const ledger = new Ledger(stateDir);

  const or = new OpenRouter({ key: process.env.CHEAP_EYES_OPENROUTER_KEY });
  const zdr = summarizeZdr(await or.zdrEndpoints());
  const account = await loadAccount(or);
  const allowed = account.list ?? (await or.textModels());
  const cap = capFor(config);
  const cands = pickCandidates(zdr, allowed, cap);
  console.log(`candidates: ${cands.length} (cap ${capText(cap)}; account ${account.ids ? `${account.ids.size} models allowed` : `availability unknown: ${account.error}`})`);
  for (const c of cands.slice(0, 10)) console.log(`  ${c.id}  in ${fmtPrice(c.fitIn)} / out ${fmtPrice(c.fitOut)} per 1M  ctx ${c.context}  max out ${c.maxOut ?? 'not given'}`);
  const allowedIds = new Set(allowed.map((m) => m.id));
  const freeLeftOut = [...zdr.values()].filter((z) => allowedIds.has(z.id) && hasFreeSuffix(z.id)).length;
  console.log(`free variants left out of the pick: ${freeLeftOut}`);
  assert.ok(cands.every((c) => !hasFreeSuffix(c.id) && (c.fitIn > 0 || c.fitOut > 0)), 'no free variant and no $0 endpoint among the candidates');

  const t0 = Date.now();
  const r = await pickAgain(ctx, {
    ledger,
    onProbe: (p) => console.log(`probe ${p.id}: ${p.ok ? 'pass' : p.reason}; cost $${p.cost.toFixed(6)}; ${p.ms} ms`),
  });
  const pickMs = Date.now() - t0;
  const pickCost = r.pin.probe.reduce((s, p) => s + (p.cost ?? 0), 0);
  console.log(`pin file:\n${fs.readFileSync(pinPath(stateDir), 'utf8')}`);
  console.log(`pick: $${pickCost.toFixed(6)} in ${pickMs} ms`);

  const probesBefore = (await readUsage(stateDir)).filter((u) => u.tool === 'probe').length;
  const t1 = Date.now();
  const job = await eyesRun({ task: 'Quote the line that gives the gateway port.', mode: 'extract', files: [f] }, ctx, { ledger });
  console.log(`${job.header}\njob: ${Date.now() - t1} ms`);
  const usage = await readUsage(stateDir);
  const total = usage.reduce((s, u) => s + (u.cost ?? 0), 0);
  console.log(`total: $${total.toFixed(6)} (pick $${pickCost.toFixed(6)}, job $${job.rec.cost.toFixed(6)})`);

  assert.ok(r.pin.probe.some((p) => p.ok), 'at least one id passed the probe');
  assert.ok(fs.existsSync(pinPath(stateDir)), 'the pin exists');
  assert.equal(usage.filter((u) => u.tool === 'probe').length, probesBefore, 'the job did not probe');
  assert.match(job.header, /\nmodel: auto -> \S+ \(pinned \d{4}-\d{2}-\d{2}\)\n/, 'the job used the pin');
  assert.ok(total < 0.05, `total cost $${total}`);
});

// The four provider.max_price requests: an impossible and a generous cap, each as JSON
// numbers and as strings (USD per 1M tokens).
export const MAX_PRICE_FORMS = [
  { form: 'numbers', cap: 'impossible', max_price: { prompt: 0.000001, completion: 0.000001 } },
  { form: 'strings', cap: 'impossible', max_price: { prompt: '0.000001', completion: '0.000001' } },
  { form: 'numbers', cap: 'generous', max_price: { prompt: 100, completion: 100 } },
  { form: 'strings', cap: 'generous', max_price: { prompt: '100', completion: '100' } },
];

export function maxPriceBody(model, maxPrice) {
  return {
    model,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    max_completion_tokens: 16,
    provider: { zdr: true, data_collection: 'deny', max_price: maxPrice },
  };
}

// A successful call does not show that max_price is read: an unknown field may be
// dropped silently. Only a refusal of the impossible cap shows it is honoured, and only
// in a form whose generous request succeeded (so the refusal is not a schema error).
test('live: provider.max_price — which form OpenRouter honours', { skip: !LIVE && 'set CHEAP_EYES_LIVE=1 and CHEAP_EYES_OPENROUTER_KEY', timeout: 300_000 }, async () => {
  const model = await liveModel(tmpDir());
  const or = new OpenRouter({ key: process.env.CHEAP_EYES_OPENROUTER_KEY });
  console.log(`model: ${model}`);
  const results = [];
  for (const r of MAX_PRICE_FORMS) {
    const label = `max_price ${r.cap} as ${r.form}`;
    try {
      const res = await or.chat(maxPriceBody(model, r.max_price), { timeoutMs: 60_000 });
      const provider = typeof res.provider === 'string' ? res.provider : 'not named';
      console.log(`${label}: HTTP 200; provider ${provider}; usage.cost ${res.usage?.cost ?? 'absent'}`);
      results.push({ ...r, ok: true });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      console.log(`${label}: ${e.status ? `HTTP ${e.status}` : (e.errorType ?? 'error')}: ${safeErrorText(e.message).slice(0, 200)}`);
      results.push({ ...r, ok: false });
    }
  }
  const outcome = (form, cap) => results.find((x) => x.form === form && x.cap === cap).ok;
  const honoured = ['numbers', 'strings'].filter((f) => outcome(f, 'generous') && !outcome(f, 'impossible'));
  console.log(`max_price honoured as: ${honoured.length === 2 ? 'both' : (honoured[0] ?? 'neither')}`);
  assert.ok(outcome('numbers', 'generous'), 'the generous cap as numbers succeeds');
  assert.ok(outcome('strings', 'generous'), 'the generous cap as strings succeeds');
  assert.ok(!outcome('numbers', 'impossible') || !outcome('strings', 'impossible'), 'at least one impossible cap is refused');
});
