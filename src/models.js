// Live model facts from the ZDR endpoint list, id resolution and the model table.
// Nothing here knows a model id: ids come only from config (or a raw id when allowed).
import { InputError } from './errors.js';
import { refusedSuffix } from './model-ids.js';
import { ApiError } from './openrouter.js';
import { MODEL_MODES } from './tools.js';

const PER_M = 1e6;

function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * ZDR endpoints → Map model_id → { endpoints, providers, context, maxOut, maxPrompt, priceIn, priceOut, priceRequest }.
 * Routing may land on any endpoint, so per id: the smallest context, max output and
 * max prompt (null/0 = no limit given), the highest prices (USD per 1M tokens;
 * per-request price in USD).
 */
export function summarizeZdr(endpoints) {
  const out = new Map();
  for (const e of endpoints ?? []) {
    if (!e || typeof e.model_id !== 'string') continue;
    let s = out.get(e.model_id);
    if (!s) {
      s = { id: e.model_id, endpoints: 0, providers: [], context: null, maxOut: null, maxPrompt: null, priceIn: null, priceOut: null, priceRequest: 0 };
      out.set(e.model_id, s);
    }
    s.endpoints++;
    if (e.provider_name && !s.providers.includes(e.provider_name)) s.providers.push(e.provider_name);
    const ctx = num(e.context_length);
    if (ctx !== null) s.context = s.context === null ? ctx : Math.min(s.context, ctx);
    const mo = num(e.max_completion_tokens);
    if (mo !== null) s.maxOut = s.maxOut === null ? mo : Math.min(s.maxOut, mo);
    const mp = num(e.max_prompt_tokens);
    if (mp !== null && mp > 0) s.maxPrompt = s.maxPrompt === null ? mp : Math.min(s.maxPrompt, mp);
    const pin = num(e.pricing?.prompt);
    const pout = num(e.pricing?.completion);
    const preq = num(e.pricing?.request);
    // A missing price is not free: treat it as unknown (Infinity) so a cap refuses it.
    s.priceIn = Math.max(s.priceIn ?? 0, pin === null ? Infinity : pin * PER_M);
    s.priceOut = Math.max(s.priceOut ?? 0, pout === null ? Infinity : pout * PER_M);
    s.priceRequest = Math.max(s.priceRequest, preq ?? 0);
  }
  return out;
}

export const BLOCKED_BY_ACCOUNT = "blocked by the account's guardrails or privacy settings — allow it at openrouter.ai → Guardrails";

/**
 * The account's model list (GET /models/user, same 6 h cache as the ZDR list) →
 * { ids: Set, list, error: null }. An id absent from it is blocked by the account.
 * If the call fails, availability is unknown — { ids: null, list: null, error } — and
 * nothing is treated as blocked.
 */
export async function loadAccount(or) {
  try {
    const list = await or.userModels();
    return { ids: new Set(list.map((m) => m?.id).filter((id) => typeof id === 'string')), list, error: null };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return { ids: null, list: null, error: e.message };
  }
}

export function fmtPrice(p) {
  if (p === null || p === undefined) return '-';
  if (!Number.isFinite(p)) return '?';
  return `$${p < 0.01 && p > 0 ? p.toPrecision(2) : Number(p.toFixed(3))}`;
}

/**
 * Screen the ids of a model choice against live facts. Returns
 * [{ id, ok, reason, blocked, facts, context }] in priority order; `context` is the
 * usable context (live, capped by config.max_context). `account`: the Set of ids the
 * account may use, or null when unknown (then nothing is blocked).
 */
export function screenIds(ids, zdr, config, account = null) {
  const cap = config.max_price_usd_per_mtok;
  return ids.map((id) => {
    const facts = zdr.get(id) ?? null;
    if (refusedSuffix(id)) return { id, ok: false, reason: 'refused variant suffix', facts };
    // No ZDR endpoint first: an unknown or retired id is missing from the account list
    // too, and pointing at Guardrails would not help.
    if (!facts) return { id, ok: false, reason: 'no ZDR endpoint', facts };
    if (account && !account.has(id)) return { id, ok: false, reason: 'blocked by account', blocked: true, facts };
    if (facts.context === null) return { id, ok: false, reason: 'no context length in the ZDR list', facts };
    // Without a price the budget cannot be reserved: refused whether or not a cap is set.
    if (!Number.isFinite(facts.priceIn) || !Number.isFinite(facts.priceOut)) return { id, ok: false, reason: 'price unknown', facts };
    if (cap && (facts.priceIn > cap.in || facts.priceOut > cap.out)) {
      return {
        id,
        ok: false,
        reason: `over price cap (in ${fmtPrice(facts.priceIn)} / out ${fmtPrice(facts.priceOut)} per 1M > ${fmtPrice(cap.in)} / ${fmtPrice(cap.out)})`,
        facts,
      };
    }
    const context = config.max_context ? Math.min(facts.context, config.max_context) : facts.context;
    return { id, ok: true, reason: null, facts, context };
  });
}

export function noUsableModel(label, screened, extra = []) {
  const blocked = screened.filter((s) => s.blocked).map((s) => s.id);
  const parts = [
    ...(blocked.length ? [`${blocked.join(', ')}: ${BLOCKED_BY_ACCOUNT}`] : []),
    ...screened.filter((s) => !s.ok && !s.blocked).map((s) => `${s.id}: ${s.reason}`),
    ...extra,
  ];
  return new InputError(`no usable model for ${label}: ${parts.join('; ')}`);
}

// Output cap for one id: requested, capped by the id's smallest ZDR max output and
// by the context left after the largest prompt.
export function capMaxTokens(requested, facts, context, promptTokens) {
  let cap = requested;
  if (facts.maxOut !== null) cap = Math.min(cap, facts.maxOut);
  cap = Math.min(cap, context - promptTokens);
  return cap;
}

// Worst-case cost of one call in USD.
export function worstCaseCost(facts, promptTokens, maxTokens) {
  return (promptTokens * facts.priceIn + maxTokens * facts.priceOut) / PER_M + (facts.priceRequest ?? 0);
}

// Estimated cost of a failed attempt that may have reached the provider: the prompt only.
export function promptCost(facts, promptTokens) {
  return (promptTokens * facts.priceIn) / PER_M + (facts.priceRequest ?? 0);
}

// ---- the model table (eyes_stats models / `cheap-eyes models`) ----

// First line of the table: the alias each mode uses when a call names none.
export function defaultsLine(config) {
  const d = config.defaults ?? {};
  const of = (m) => d[m] ?? (m === 'schema' && d.extract ? `${d.extract} (extract default)` : '(not set)');
  return `defaults: ${MODEL_MODES.map((m) => `${m} -> ${of(m)}`).join(', ')}`;
}

export function accountLine(account) {
  if (account.ids) return `account: ${account.ids.size} models allowed (GET /models/user); ids missing there are marked "blocked by account"`;
  return `account: availability unknown (${account.error}); no id is treated as blocked`;
}

export function modelTable(config, zdr, usageByAlias = {}, account = null) {
  const rows = [];
  for (const [alias, m] of Object.entries(config.models)) {
    const screened = screenIds(m.ids, zdr, config, account);
    const resolved = screened.find((s) => s.ok) ?? null;
    const u = usageByAlias[alias] ?? null;
    rows.push({
      alias,
      resolved: resolved?.id ?? null,
      ids: screened.map((s) => ({
        id: s.id,
        ok: s.ok,
        reason: s.reason,
        blocked: Boolean(s.blocked),
        endpoints: s.facts?.endpoints ?? 0,
        context: s.facts?.context ?? null,
        max_out: s.facts?.maxOut ?? null,
        max_prompt: s.facts?.maxPrompt ?? null,
        price_in: s.facts?.priceIn ?? null,
        price_out: s.facts?.priceOut ?? null,
      })),
      jobs: u?.jobs ?? 0,
      avg_cost: u && u.jobs ? u.cost / u.jobs : null,
      pass_rate: u?.pass_rate ?? null,
    });
  }
  return rows;
}

export function candidates(config, zdr, textModels, { min_context, max_price_in } = {}, limit = 10) {
  const text = new Set();
  for (const m of textModels ?? []) {
    if (m?.id) text.add(m.id);
    if (m?.canonical_slug) text.add(m.canonical_slug);
  }
  const inConfig = new Set(Object.values(config.models).flatMap((m) => m.ids));
  return [...zdr.values()]
    .filter((s) => text.has(s.id) && !inConfig.has(s.id) && !refusedSuffix(s.id))
    .filter((s) => s.context !== null && (!min_context || s.context >= min_context))
    .filter((s) => Number.isFinite(s.priceIn) && Number.isFinite(s.priceOut))
    .filter((s) => max_price_in === undefined || s.priceIn <= max_price_in)
    .sort((a, b) => a.priceIn - b.priceIn || a.priceOut - b.priceOut || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// `head`: lines printed first (defaults per mode, account availability).
export function renderModelTable(rows, cands = null, { head = [], candidatesNote = '' } = {}) {
  const out = [...head];
  if (rows.length === 0) out.push('no model aliases in config');
  for (const r of rows) {
    const stats = `jobs ${r.jobs}, avg cost ${r.avg_cost === null ? '-' : `$${r.avg_cost.toFixed(4)}`}, check pass ${r.pass_rate ?? '-'}`;
    out.push(`${r.alias} -> ${r.resolved ?? 'NO USABLE ID'}  (${stats})`);
    for (const i of r.ids) {
      const mark = i.id === r.resolved ? '*' : ' ';
      const facts = `zdr ${i.endpoints}, ctx ${i.context ?? '-'}${i.max_prompt ? `, max prompt ${i.max_prompt}` : ''}, max out ${i.max_out ?? '-'}, in ${fmtPrice(i.price_in)} / out ${fmtPrice(i.price_out)} per 1M`;
      out.push(`  ${mark} ${pad(i.id, 40)} ${facts}${i.ok ? '' : `  [${i.reason}]`}`);
    }
  }
  if (cands) {
    out.push('');
    out.push(cands.length ? `candidates (ZDR text models not in config, cheapest first; suggestions only${candidatesNote}):` : `candidates: none match${candidatesNote}`);
    for (const c of cands) {
      out.push(`  ${pad(c.id, 40)} zdr ${c.endpoints}, ctx ${c.context}, max out ${c.maxOut ?? '-'}, in ${fmtPrice(c.priceIn)} / out ${fmtPrice(c.priceOut)} per 1M`);
    }
  }
  return out.join('\n');
}
