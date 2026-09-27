// Live smoke test against OpenRouter. Runs only with CHEAP_EYES_LIVE=1 and
// CHEAP_EYES_OPENROUTER_KEY set; spends a fraction of a cent.
// Model: CHEAP_EYES_LIVE_MODEL, or else the cheapest ZDR text model with ≥ 16k context.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Ledger } from '../src/budget.js';
import { parseConfig } from '../src/config.js';
import { candidates, summarizeZdr } from '../src/models.js';
import { OpenRouter } from '../src/openrouter.js';
import { eyesRun } from '../src/run.js';
import { eyesStats } from '../src/stats.js';
import { tmpDir } from './helpers.js';

const LIVE = process.env.CHEAP_EYES_LIVE === '1' && Boolean(process.env.CHEAP_EYES_OPENROUTER_KEY);

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

  let model = process.env.CHEAP_EYES_LIVE_MODEL;
  if (!model) {
    const or = new OpenRouter();
    const probe = parseConfig({ read_roots: [root] });
    const [c] = candidates(probe, summarizeZdr(await or.zdrEndpoints()), await or.textModels(), { min_context: 16000, max_price_in: 0.5 });
    assert.ok(c, 'no cheap ZDR text model found');
    model = c.id;
  }
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
