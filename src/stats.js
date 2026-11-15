// eyes_stats and `cheap-eyes models`: spend from the usage log, key status, model table.
import path from 'node:path';
import { noKeyText, rootsAction, runtimeLine } from './actions.js';
import { openRouterKey } from './config.js';
import { AUTO, autoConfig, capFor, capText, pinDate, pinPath, probeTime, readPin } from './pick.js';
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
  if (s.probes?.count) out.push(`  probes (model pick): ${s.probes.count}, cost ${money(s.probes.cost)}; with the jobs ${money(s.cost + s.probes.cost)}`);
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

// Head lines for the picked models: the pin, its date and the probe of each tried id.
// Returns { config, head } where config lists the pinned ids as the alias "auto".
function autoSection(config, stateDir) {
  const head = [`defaults: every mode -> auto (the settings name no models; picked models, cap ${capText(capFor(config))})`];
  const read = stateDir ? readPin(stateDir) : { pin: null };
  if (read.error) {
    head.push(`auto: the pin file cannot be used (${read.error}); the next model job sets it aside and picks again`);
    return { config, head };
  }
  if (!read.pin) {
    head.push('auto: not picked yet; the first model job picks and pins, or run `cheap-eyes models --pick`');
    return { config, head };
  }
  const pin = read.pin;
  head.push(`auto: pinned ${pinDate(pin)} (${pinPath(stateDir)}; picked at ${pin.picked_at}${pin.cap ? `, cap ${capText(pin.cap)}` : ''})`);
  for (const p of pin.probe ?? []) head.push(`  probe ${p.ok ? 'ok    ' : 'failed'} ${p.id}  $${(p.cost ?? 0).toFixed(6)}${probeTime(p)}${p.ok ? '' : `  (${p.reason})`}`);
  return { config: { ...autoConfig(config), models: { [AUTO]: { ids: pin.ids, params: {} } } }, head };
}

export async function modelsReport(config, or, { withCandidates = false, filters = {}, records = [], stateDir = null } = {}) {
  const [zdrList, account] = await Promise.all([or.zdrEndpoints(), loadAccount(or)]);
  const zdr = summarizeZdr(zdrList);
  const picked = Object.keys(config.models).length === 0;
  const section = picked ? autoSection(config, stateDir) : { config, head: [defaultsLine(config)] };
  const rows = modelTable(section.config, zdr, usageByAlias(records), account.ids);
  let cands = null;
  let candidatesNote = '';
  if (withCandidates) {
    // The account's own list is text-output only, like /models, and already filtered
    // by its guardrails; the public list is the fallback when availability is unknown.
    if (account.list) cands = candidates(section.config, zdr, account.list, filters);
    else {
      cands = candidates(section.config, zdr, await or.textModels(), filters);
      candidatesNote = '; account availability unknown';
    }
  }
  return renderModelTable(rows, cands, { head: [...section.head, accountLine(account)], candidatesNote, emptyText: picked ? null : undefined });
}

export async function eyesStats(args, ctx, deps = {}) {
  const { config } = ctx;
  const stateDir = ctx.stateDir?.path ?? ctx.stateDir ?? path.dirname(ctx.resultsDir);
  const nowFn = deps.now ?? (() => Date.now());
  const key = deps.key !== undefined ? deps.key : openRouterKey();
  const or = new OpenRouter({ key, fetch: deps.fetch ?? globalThis.fetch, now: nowFn });
  const today = utcDay(nowFn());
  const records = await readUsage(stateDir);
  const agg = aggregate(records, today);

  const lines = ['eyes_stats'];
  // What is missing comes first, each with the action.
  if (config.read_roots.length === 0) lines.push(`missing: read roots — file paths are refused, URLs work; to add one: ${rootsAction(ctx)}`);
  if (!key) lines.push(`missing: ${noKeyText()}`);
  lines.push(...scopeLines(`today (UTC ${today})`, agg.today));
  lines.push(...scopeLines('all time', agg.all));

  const ledger = deps.ledger ?? ledgerFor(stateDir);
  await ledger.ensure();
  const budget = config.daily_budget_usd;
  lines.push(`budget: ${budget === null ? 'off (null)' : `daily_budget_usd $${budget}`}; spent today ${money(ledger.spent)}, reserved ${money(ledger.reserved)}`);
  lines.push(`runtime: ${runtimeLine(deps.env ?? process.env, deps.versions ?? process.versions)}`);

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
      lines.push(await modelsReport(config, or, { withCandidates: Boolean(args.candidates), filters: args.candidates ?? {}, records, stateDir }));
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      lines.push(`models: unavailable (${e.message})`);
    }
  }
  return lines.join('\n');
}
