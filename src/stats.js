// eyes_stats and `cheap-eyes models`: spend from the usage log, key status, model table.
import path from 'node:path';
import { ledgerFor } from './budget.js';
import { accountLine, candidates, defaultsLine, loadAccount, modelTable, renderModelTable, summarizeZdr } from './models.js';
import { ApiError, OpenRouter } from './openrouter.js';
import { aggregate, readUsage, utcDay } from './usage.js';

function money(v) {
  return `$${(v ?? 0).toFixed(4)}`;
}

function scopeLines(label, s) {
  const est = s.estimated ? ` (${s.estimated} job(s) with estimated cost)` : '';
  const out = [`${label}: jobs ${s.jobs}, cost ${money(s.cost)}${est}, tokens in ${s.tokens_in} / out ${s.tokens_out}`];
  for (const [k, a] of Object.entries(s.by_alias)) out.push(`  alias ${k}: jobs ${a.jobs}${a.failed ? ` (${a.failed} failed)` : ''}, cost ${money(a.cost)}`);
  for (const [k, a] of Object.entries(s.by_model)) out.push(`  model ${k}: jobs ${a.jobs}, cost ${money(a.cost)}`);
  return out;
}

// Per alias: jobs, total cost and the average check pass rate — extract: verbatim ok
// share; draft: share of lines without flags; edits: valid share. The mechanical
// checks double as a per-model benchmark on real work.
export function usageByAlias(records) {
  const out = {};
  const rates = {};
  for (const r of records) {
    if (r.dry_run || r.tool !== 'eyes_run' || !r.alias) continue;
    const a = (out[r.alias] ??= { jobs: 0, cost: 0, pass_rate: null });
    a.jobs++;
    a.cost += r.cost ?? 0;
    const p = r.check?.pass_rate;
    if (typeof p === 'number' && Number.isFinite(p)) {
      const m = (rates[r.alias] ??= {});
      (m[r.check.mode] ??= []).push(p);
    }
  }
  for (const [alias, byMode] of Object.entries(rates)) {
    out[alias].pass_rate = Object.entries(byMode)
      .map(([mode, v]) => `${mode} ${Math.round((100 * v.reduce((s, x) => s + x, 0)) / v.length)}% (${v.length})`)
      .join(', ');
  }
  return out;
}

export async function modelsReport(config, or, { withCandidates = false, filters = {}, records = [] } = {}) {
  const [zdrList, account] = await Promise.all([or.zdrEndpoints(), loadAccount(or)]);
  const zdr = summarizeZdr(zdrList);
  const rows = modelTable(config, zdr, usageByAlias(records), account.ids);
  let cands = null;
  let candidatesNote = '';
  if (withCandidates) {
    // The account's own list is text-output only, like /models, and already filtered
    // by its guardrails; the public list is the fallback when availability is unknown.
    if (account.list) cands = candidates(config, zdr, account.list, filters);
    else {
      cands = candidates(config, zdr, await or.textModels(), filters);
      candidatesNote = '; account availability unknown';
    }
  }
  return renderModelTable(rows, cands, { head: [defaultsLine(config), accountLine(account)], candidatesNote });
}

export async function eyesStats(args, ctx, deps = {}) {
  const { config } = ctx;
  const stateDir = ctx.stateDir?.path ?? ctx.stateDir ?? path.dirname(ctx.resultsDir);
  const nowFn = deps.now ?? (() => Date.now());
  const key = deps.key !== undefined ? deps.key : (process.env.CHEAP_EYES_OPENROUTER_KEY || null);
  const or = new OpenRouter({ key, fetch: deps.fetch ?? globalThis.fetch, now: nowFn });
  const today = utcDay(nowFn());
  const records = await readUsage(stateDir);
  const agg = aggregate(records, today);

  const lines = ['eyes_stats'];
  lines.push(...scopeLines(`today (UTC ${today})`, agg.today));
  lines.push(...scopeLines('all time', agg.all));

  const ledger = deps.ledger ?? ledgerFor(stateDir);
  await ledger.ensure();
  const budget = config.daily_budget_usd;
  lines.push(`budget: ${budget === null ? 'off (null)' : `daily_budget_usd $${budget}`}; spent today ${money(ledger.spent)}, reserved ${money(ledger.reserved)}`);

  if (!key) lines.push('key: not set (env CHEAP_EYES_OPENROUTER_KEY)');
  else {
    try {
      const k = await or.keyInfo();
      lines.push(`key: limit ${k.limit === null ? 'none' : `$${k.limit}`}, remaining ${k.limit_remaining === null ? '-' : `$${k.limit_remaining}`}, reset ${k.limit_reset ?? '-'}, usage today (UTC) $${k.usage_daily ?? '-'}`);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      lines.push(`key: status unavailable (${e.message})`);
    }
  }

  if (args.models || args.candidates) {
    lines.push('');
    try {
      lines.push(await modelsReport(config, or, { withCandidates: Boolean(args.candidates), filters: args.candidates ?? {}, records }));
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      lines.push(`models: unavailable (${e.message})`);
    }
  }
  return lines.join('\n');
}
