// eyes_run: the input pipeline (spec steps 1–5), model resolution, calls, result.
import path from 'node:path';
import { pageRanges } from 'doclines';
import { BudgetError, ledgerFor } from './budget.js';
import { InputError } from './errors.js';
import { expandFiles } from './input/files.js';
import { compileCheck, grepMatches, withContext } from './input/grep.js';
import { readSource, readUrlSource } from './input/extract.js';
import { writeSources } from './sources.js';
import { assignNames, chunkBlocks, estimateTokens, fileHeader, fileItems, splitChunk } from './input/render.js';
import { resolveTimeOptions, timeWindow } from './input/timefilter.js';
import { Masker } from './mask.js';
import { capMaxTokens, loadAccount, noUsableModel, promptCost, screenIds, summarizeZdr, worstCaseCost } from './models.js';
import { ApiError, OpenRouter } from './openrouter.js';
import { placeOf } from './place.js';
import { systemPrompt, userMessage } from './prompts.js';
import { badItems, checkJob, chunkView, describeItem, summaryLine } from './checks.js';
import { checkSchemaJob, parseSchema, SCHEMA_PROBLEMS, schemaSummaryLine, schemaTask } from './schema.js';
import { planExport, writeExport } from './export.js';
import { FRAME_CLOSE, FRAME_OPEN, neutralize, SOURCE_CLOSE, SOURCE_OPEN } from './frame.js';
import { allocateResult, running, writeCheck, writeResult, writeResultText } from './results.js';
import { appendUsage } from './usage.js';

// Output cap per chunk when the caller gives none (still capped per model id).
export const DEFAULT_MAX_TOKENS = { extract: 16000, schema: 8000, draft: 4096, edits: 4096 };
// A chunk cut by finish_reason "length" is split in two and retried in these modes.
const RESPLIT_MODES = new Set(['extract', 'edits', 'schema']);
export const CONTEXT_SHARE = 0.4;
const HEADER_MAX = 4096;
const MIN_BUDGET = 256;
const RETRIES = 2;
const PREVIEW_LINES = 20;
const PREVIEW_WIDTH = 200;
export { FRAME_CLOSE, FRAME_OPEN, neutralize };

// alias (or raw id when allowed) → { alias, label, ids, params }
export function resolveModelChoice(model, mode, config) {
  // schema falls back to the extract default.
  const name = model ?? config.defaults[mode] ?? (mode === 'schema' ? config.defaults.extract : undefined);
  if (name === undefined) throw new InputError(`no model: pass "model" or set defaults.${mode} in the config`);
  if (Object.hasOwn(config.models, name)) {
    const m = config.models[name];
    return { alias: name, label: `alias ${name}`, ids: m.ids, params: m.params };
  }
  if (config.allow_raw_model_ids && name.includes('/')) return { alias: null, label: name, ids: [name], params: {} };
  throw new InputError(`unknown model alias: ${name}${config.allow_raw_model_ids ? '' : ' (raw OpenRouter ids are off: allow_raw_model_ids)'}`);
}

// The exact request body. Server-owned fields are set last so config params can never replace them.
export function buildRequestBody({ modelId, params, system, user, maxTokens }) {
  return {
    ...params,
    model: modelId,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    provider: { zdr: true, data_collection: 'deny' },
    plugins: [{ id: 'context-compression', enabled: false }],
    max_completion_tokens: maxTokens,
  };
}

function countsText(counts) {
  const e = Object.entries(counts);
  return e.length ? e.map(([k, v]) => `${k} ${v}`).join(', ') : 'none';
}

function clip(text, max = HEADER_MAX) {
  const b = Buffer.from(text, 'utf8');
  if (b.length <= max) return text;
  return b.subarray(0, max - 40).toString('utf8').replace(/�$/, '') + '\n… (header clipped)';
}

// ---- steps 1–4: independent of the model ----

// A source copy is kept with the result for extracted formats and URLs always, for
// plain local text only in schema mode (see sources.js).
function keepsSource(f, read, mode) {
  return Boolean(f.url) || read.format !== 'text' || mode === 'schema';
}

export async function prepareInput(args, { config, platform = process.platform, now = Date.now(), urlDeps }) {
  const { mode } = args;
  if (args.grep) compileCheck(args.grep.pattern, args.grep.ignore_case);
  // Refused before any file is read.
  const schema = mode === 'schema' ? parseSchema(args.schema) : null;
  const timeOpts = args.time ? resolveTimeOptions(args.time, config.time.default_tz) : null;

  // 1. expand and guard
  const { files, skipped } = await expandFiles(args.files, { config, platform });

  // 2. read; range → time, then 3. mask every candidate line, then grep over the
  // masked text only (grep on raw text would let a caller probe secrets char by char).
  const masker = new Masker(config.mask.extra_patterns);
  const blocks = [];
  for (const f of files) {
    let read;
    try {
      read = f.url ? await readUrlSource(f.url, { name: f.given, config, deps: urlDeps, now }) : await readSource(f.real, { name: f.given, config });
    } catch (e) {
      if (e instanceof InputError && !f.literal) {
        skipped.push({ path: f.given, reason: e.reason ?? e.message.replace(/: .*$/, '') });
        continue;
      }
      throw e;
    }
    const total = read.lines.length;
    let nums = Array.from({ length: total }, (_, i) => i + 1);
    if (f.range) {
      if (f.range.start > total) throw new InputError(`range starts after the end of ${f.given} (${total} lines)`);
      nums = nums.slice(f.range.start - 1, Math.min(f.range.end, total));
    }
    if (timeOpts) nums = timeWindow(read.lines, nums, { ...timeOpts, now, name: f.given });
    // The source copy needs every line masked; the counts still cover only sent lines.
    const keep = keepsSource(f, read, mode);
    const entries = masker.maskEach(read.lines, keep ? undefined : nums.map((n) => n - 1));
    blocks.push({ file: f, lines: read.lines, nums, entries, total, encoding: read.encoding, bytes: read.bytes, read, keep });
  }
  if (blocks.length === 0) throw new InputError('no readable files: all matches were skipped');
  if (args.grep) {
    const texts = blocks.map((b) => b.nums.map((n) => b.entries.get(n - 1).text));
    const hits = await grepMatches(texts, { pattern: args.grep.pattern, ignoreCase: args.grep.ignore_case });
    const context = args.grep.context ?? 3;
    blocks.forEach((b, i) => {
      b.matches = hits[i].length;
      b.nums = withContext(b.nums, hits[i], context);
    });
  }
  const filtered = Boolean(timeOpts || args.grep || files.some((f) => f.range));
  for (const b of blocks) {
    masker.tally(b.nums.map((n) => b.entries.get(n - 1)));
    b.masked = new Map(b.nums.map((n) => [n - 1, b.entries.get(n - 1).text]));
  }
  const taskMasker = new Masker(config.mask.extra_patterns);
  const task = taskMasker.maskText(schema ? schemaTask(schema, args.task) : (args.task ?? ''));

  // 4. names and numbering
  const names = assignNames(blocks.map((b) => b.file), platform);
  const multi = blocks.length > 1;
  const kept = [];
  const empty = [];
  const sources = new Map(); // name → Map(0-based line → masked text), what the checks compare against
  const pages = new Map(); // name → first line of each page (PDF), for the `page` field
  const places = new Map(); // name → doclines sections, for refs shown as L12 (slide 3)
  const warnings = [];
  blocks.forEach((b, i) => {
    b.name = names[i];
    sources.set(b.name, b.masked);
    if (b.read.pageStarts) pages.set(b.name, b.read.pageStarts);
    if (b.read.sections.length) places.set(b.name, b.read.sections);
    if (b.read.pagesWithoutText.length) warnings.push(`${b.name}: pages without text layer: ${pageRanges(b.read.pagesWithoutText)}`);
    if (b.nums.length === 0) empty.push(b.name);
    else kept.push({ name: b.name, items: fileItems({ nums: b.nums, masked: b.masked, total: b.total, filtered, markers: b.read.markers }) });
  });
  if (kept.length === 0) throw new InputError('nothing left after filters (range/time/grep)');

  // 5a. size limit
  let jobBytes = 0;
  for (const k of kept) {
    if (multi) jobBytes += Buffer.byteLength(fileHeader(k.name) + '\n');
    for (const it of k.items) jobBytes += Buffer.byteLength(it.text + '\n');
  }
  if (jobBytes > config.max_job_bytes) {
    throw new InputError(`job too large after filtering: ${jobBytes} bytes > max_job_bytes ${config.max_job_bytes}`);
  }

  return {
    mode,
    task,
    system: mode === 'grep' ? '' : systemPrompt(mode, { markers: kept.some((k) => k.items.some((it) => it.kind === 'marker')) }),
    schema,
    multi,
    kept,
    sources,
    pages,
    places,
    warnings,
    jobBytes,
    masks: masker.counts,
    taskMasks: taskMasker.counts,
    skipped,
    empty,
    sourceCopies: blocks
      .filter((b) => b.keep)
      .map((b) => ({
        name: b.name,
        kind: b.file.url ? 'url' : 'file',
        path: b.file.real,
        meta: b.read.meta,
        format: b.read.format,
        bytes: b.bytes,
        sha256: b.read.sha256,
        lines: b.lines.map((_, i) => b.entries.get(i).text),
        markers: b.read.markers,
        pageStarts: b.read.pageStarts,
        sections: b.read.sections,
      })),
    files: blocks.map((b) => ({
      name: b.name,
      ...(b.file.url ? { url: b.read.meta.url, final_url: b.read.meta.final_url, host: new URL(b.file.url).host } : { path: b.file.real }),
      bytes: b.bytes,
      format: b.read.format,
      encoding: b.encoding,
      lines_total: b.total,
      lines_sent: b.nums.length,
      ...(b.matches !== undefined ? { matches: b.matches } : {}),
      ...(b.read.pageStarts ? { pages: b.read.pageStarts.length, page_starts: b.read.pageStarts } : {}),
    })),
    filters: {
      range: files.length === 1 && files[0].range ? files[0].range : null,
      time: timeOpts ? { since: args.time.since ?? null, until: args.time.until ?? null, tz: timeOpts.tz } : null,
      grep: args.grep ? { pattern: args.grep.pattern, context: args.grep.context ?? 3, ignore_case: Boolean(args.grep.ignore_case) } : null,
    },
  };
}

// 5b. chunks for a given context and, when the endpoints set one, max prompt size.
// Throws InputError when the context is too small.
export function chunkInput(input, contextTokens, maxPrompt = null) {
  const fixed = estimateTokens(input.system) + estimateTokens(userMessage('', input.task));
  const share = Math.floor(contextTokens * CONTEXT_SHARE);
  const limit = maxPrompt ? Math.min(share, maxPrompt) : share;
  const budget = limit - fixed;
  if (budget < MIN_BUDGET) {
    const what = maxPrompt && maxPrompt < share ? `max_prompt_tokens ${maxPrompt}` : `40% of ${contextTokens} tokens`;
    throw new InputError(`context too small: ${what} leaves ~${budget} for input after the prompt and task`);
  }
  const chunks = chunkBlocks(input.kept, { budget, multi: input.multi }).map((c) => ({
    ...c,
    user: userMessage(c.text, input.task),
  }));
  for (const c of chunks) c.promptTokens = estimateTokens(input.system) + estimateTokens(c.user);
  return { chunks, budget };
}

// Backwards-compatible single call: steps 1–5 for a fixed context.
export async function prepareJob(args, { config, platform, contextTokens, now }) {
  const input = await prepareInput(args, { config, platform, now });
  return { ...input, ...chunkInput(input, contextTokens) };
}

/**
 * Pick the first id of the choice that is not blocked by the account, has a ZDR
 * endpoint, is within the price cap and fits the chunks; the rest of the usable ids
 * are runtime fallbacks. Blocked ids are skipped without a model call. `account`: Set
 * of allowed ids, or null when unknown.
 */
export function planJob(input, choice, { zdr, config, requested, account = null }) {
  const screened = screenIds(choice.ids, zdr, config, account);
  const extra = [];
  const usable = [];
  for (const s of screened.filter((x) => x.ok)) {
    let chunked;
    try {
      chunked = chunkInput(input, s.context, s.facts.maxPrompt);
    } catch (e) {
      if (!(e instanceof InputError)) throw e;
      extra.push(`${s.id}: context too small (${s.context} tokens: ${e.message})`);
      continue;
    }
    const promptMax = Math.max(...chunked.chunks.map((c) => c.promptTokens));
    const maxTokens = capMaxTokens(requested, s.facts, s.context, promptMax);
    if (maxTokens < 1) {
      extra.push(`${s.id}: context too small (${s.context} tokens, prompt ~${promptMax})`);
      continue;
    }
    usable.push({ ...s, ...chunked, maxTokens });
  }
  if (usable.length === 0) throw noUsableModel(choice.label, screened, extra);
  const [primary, ...fallbacks] = usable;
  return { primary, fallbacks, chunks: primary.chunks, budget: primary.budget };
}

// ---- model calls ----

function isRetryable(e) {
  return e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500;
}

function tryNextId(e) {
  return isRetryable(e) || e.status === 404 || (e.status === 400 && e.errorType === 'context_length_exceeded');
}

function backoffMs(attempt, retryAfter) {
  if (retryAfter !== null && retryAfter !== undefined) return Math.min(retryAfter, 30) * 1000;
  return 1000 * 3 ** attempt; // 1 s, 3 s
}

function contentText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('');
  return '';
}

// Real cost from usage.cost; when it is missing, an estimate from the token counts.
function actualCost(res, facts) {
  const c = res?.usage?.cost;
  if (typeof c === 'number' && Number.isFinite(c) && c >= 0) return { cost: c, estimated: false };
  const pin = res?.usage?.prompt_tokens ?? 0;
  const pout = res?.usage?.completion_tokens ?? 0;
  return { cost: (pin * facts.priceIn + pout * facts.priceOut) / 1e6 + (facts.priceRequest ?? 0), estimated: true };
}

// A failed attempt may have reached the provider (network error, timeout, cancel in
// flight, 5xx) and may be billed for the prompt; a 4xx was refused before inference.
function mayHaveReachedProvider(e) {
  return e.status === 0 || e.status >= 500;
}

/**
 * One chunk: the primary id with retries, then each fallback id that fits.
 * The response `reasoning` field is ignored — never stored or checked.
 */
async function runChunk(chunk, plan, run) {
  const { or, ledger, config, choice, input, requested, sleep, signal } = run;
  const candidates = [plan.primary, ...plan.fallbacks];
  let lastErr = null;
  let failedCost = 0;
  const tried = [];
  for (const cand of candidates) {
    const maxTokens = cand === plan.primary ? plan.primary.maxTokens : capMaxTokens(requested, cand.facts, cand.context, chunk.promptTokens);
    if (maxTokens < 1 || chunk.promptTokens + maxTokens > cand.context) continue;
    if (cand.facts.maxPrompt && chunk.promptTokens > cand.facts.maxPrompt) continue;
    tried.push(cand.id);
    const body = buildRequestBody({ modelId: cand.id, params: choice.params, system: input.system, user: chunk.user, maxTokens });
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (signal?.aborted) throw new ApiError('cancelled', { status: 0, errorType: 'cancelled' });
      const handle = ledger.reserve(worstCaseCost(cand.facts, chunk.promptTokens, maxTokens), config.daily_budget_usd);
      const t0 = Date.now();
      let res;
      try {
        res = await or.chat(body, { signal, timeoutMs: config.timeout_s * 1000 });
      } catch (e) {
        const est = e instanceof ApiError && mayHaveReachedProvider(e) ? promptCost(cand.facts, chunk.promptTokens) : 0;
        ledger.settle(handle, est);
        if (est > 0) {
          failedCost += est;
          run.extra.cost += est;
          run.extra.attempts++;
        }
        if (!(e instanceof ApiError) || e.errorType === 'cancelled') throw e;
        lastErr = e;
        if (isRetryable(e) && attempt < RETRIES) {
          await sleep(backoffMs(attempt, e.retryAfter));
          continue;
        }
        if (tryNextId(e)) break;
        throw e;
      }
      const { cost, estimated } = actualCost(res, cand.facts);
      ledger.settle(handle, cost);
      if (estimated) run.extra.estimated = true;
      const choice0 = res.choices?.[0] ?? {};
      return {
        requested_id: cand.id,
        model: typeof res.model === 'string' ? res.model : cand.id,
        // The upstream provider OpenRouter routed to, when the response names it.
        provider: typeof res.provider === 'string' ? res.provider : null,
        text: contentText(choice0.message),
        finish_reason: choice0.finish_reason ?? null,
        truncated: choice0.finish_reason === 'length',
        tokens_in: res.usage?.prompt_tokens ?? 0,
        tokens_out: res.usage?.completion_tokens ?? 0,
        cost,
        cost_estimated: estimated,
        failed_cost: failedCost,
        ms: Date.now() - t0,
        attempts: attempt + 1,
      };
    }
  }
  if (lastErr) throw new ApiError(`all ids failed (${tried.join(', ')}): ${lastErr.message}`, { status: lastErr.status, errorType: lastErr.errorType });
  throw new InputError(`no id of ${choice.label} fits chunk ${chunk.index}`);
}

// Run chunks with at most `limit` in flight. After the first failure or a cancel no new
// chunk starts; calls already in flight finish (they may be billed) and are accounted.
async function pool(items, limit, fn, { signal, onDone } = {}) {
  const results = new Array(items.length).fill(null);
  let next = 0;
  let failure = null;
  async function lane() {
    while (failure === null && !signal?.aborted && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
        onDone?.();
      } catch (e) {
        failure ??= e;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return { results, failure };
}

export function spanText(span) {
  const { from, to } = span;
  return from.name === to.name ? `${from.name}:L${from.n}–L${to.n}` : `${from.name}:L${from.n}–${to.name}:L${to.n}`;
}

export function previewLines(text) {
  const lines = text.replace(/\n$/, '').split('\n');
  const shown = lines.slice(0, PREVIEW_LINES).map((l) => neutralize(l.length > PREVIEW_WIDTH ? `${l.slice(0, PREVIEW_WIDTH)}…` : l));
  return { total: text === '' ? 0 : lines.length, shown };
}

function commonLines(input) {
  const lines = [];
  if (input.empty.length) lines.push(`no lines after filters: ${input.empty.slice(0, 10).join(', ')}${input.empty.length > 10 ? ` (+${input.empty.length - 10})` : ''}`);
  if (input.skipped.length) {
    lines.push(`skipped: ${input.skipped.length}`);
    for (const s of input.skipped.slice(0, 10)) lines.push(`  ${s.path} (${s.reason})`);
    if (input.skipped.length > 10) lines.push(`  … +${input.skipped.length - 10} more (see check.json)`);
  }
  for (const w of input.warnings.slice(0, 10)) lines.push(w);
  if (input.warnings.length > 10) lines.push(`… +${input.warnings.length - 10} more warnings (see check.json)`);
  lines.push(`masks: ${countsText(input.masks)}; in task: ${countsText(input.taskMasks)}`);
  const f = input.filters;
  if (f.range) lines.push(`range: L${f.range.start}-L${f.range.end}`);
  if (f.time) lines.push(`time: ${f.time.since ?? '…'} → ${f.time.until ?? '…'} (${f.time.tz})`);
  if (f.grep) lines.push(`grep: /${f.grep.pattern}/${f.grep.ignore_case ? 'i' : ''} ±${f.grep.context}`);
  return lines;
}

function dryRunHeader(id, input, plan, choice, modelId, contextNote, maxTokens) {
  const lines = [];
  lines.push('eyes_run DRY RUN: nothing was sent to a model');
  lines.push(`result: ${id} (exact request bodies; read with eyes_result)`);
  lines.push(`model: ${choice.label} -> ${modelId}`);
  lines.push(`mode: ${input.mode}`);
  lines.push(`files: ${input.files.length}, lines sent: ${input.files.reduce((s, f) => s + f.lines_sent, 0)}, input bytes: ${input.jobBytes}`);
  const est = plan.chunks.reduce((s, c) => s + c.promptTokens, 0);
  lines.push(`chunks: ${plan.chunks.length}, input budget ~${plan.budget} tokens each (${contextNote}), est. prompt ~${est} tokens`);
  lines.push(`max_completion_tokens: ${maxTokens} per chunk`);
  lines.push(...commonLines(input));
  return clip(lines.join('\n'));
}

export function emptyOutputHint(chunkIndex) {
  return `chunk ${chunkIndex}: empty output, max_completion_tokens spent on reasoning — set params.reasoning.effort "none" for this alias or raise max_tokens`;
}

export function costNote(rec) {
  if (!rec.cost_estimated) return '';
  const parts = [];
  if (rec.failed_attempts) parts.push(`${rec.failed_attempts} failed attempt(s) at prompt cost`);
  if (rec.usage_cost_missing) parts.push('usage.cost missing');
  return ` (estimated: ${parts.join(', ') || 'partly'})`;
}

function runHeader(id, { input, choice, rec, outs, checks, text, status, error, hints, resplit = 0, exported, exportError, accountNote }) {
  const done = outs.filter(Boolean);
  const lines = [];
  lines.push(`eyes_run result: ${id}${status === 'done' ? '' : ` — ${status.toUpperCase()}`}`);
  if (error) lines.push(`error: ${error}`);
  if (exported?.length) lines.push(`export: ${exported.join(', ')}`);
  if (exportError) lines.push(`export failed: ${exportError}`);
  const used = [...new Set(done.map((o) => o.model))];
  lines.push(`model: ${choice.label} -> ${rec.primary}${used.length ? ` (used: ${used.join(', ')})` : ''}`);
  if (accountNote) lines.push(accountNote);
  lines.push(`mode: ${input.mode}; files: ${input.files.length}; chunks: ${done.length}/${outs.length}`);
  lines.push(`tokens in ${rec.tokens_in} / out ${rec.tokens_out}; cost $${rec.cost.toFixed(6)}${costNote(rec)}; ${rec.ms} ms`);
  const truncated = outs.map((o, i) => (o?.truncated ? i + 1 : null)).filter(Boolean);
  if (resplit) lines.push(`re-split after truncation: ${resplit} chunk(s)`);
  if (truncated.length) lines.push(`TRUNCATED chunks (finish_reason length): ${truncated.join(', ')}`);
  const other = outs.map((o, i) => (o?.finish_reason && !['stop', 'length'].includes(o.finish_reason) ? `${i + 1}:${o.finish_reason}` : null)).filter(Boolean);
  if (other.length) lines.push(`finish_reason: ${other.join(', ')}`);
  for (const h of hints) if (h) lines.push(h);
  if (checks) {
    const schema = checks.mode === 'schema';
    lines.push(schema ? schemaSummaryLine(checks.summary) : summaryLine(checks));
    const bad = schema ? checks.items.filter((it) => SCHEMA_PROBLEMS.has(it.status)) : badItems(checks);
    for (const it of bad.slice(0, 10)) lines.push(`  ${describeItem(it)}`);
    if (bad.length > 10) lines.push(`  … +${bad.length - 10} more (eyes_result check: true)`);
  }
  lines.push(...commonLines(input));
  const { total, shown } = previewLines(text);
  lines.push(`result lines: ${total}${total > shown.length ? ` (first ${shown.length} below; more via eyes_result)` : ''}`);
  const head = clip(lines.join('\n'), HEADER_MAX - 600);
  let preview = `${FRAME_OPEN}\n${shown.join('\n')}\n${FRAME_CLOSE}`;
  const room = HEADER_MAX - Buffer.byteLength(head) - 1;
  if (Buffer.byteLength(preview) > room) {
    const inner = Buffer.from(shown.join('\n'))
      .subarray(0, Math.max(0, room - FRAME_OPEN.length - FRAME_CLOSE.length - 20))
      .toString('utf8')
      .replace(/�$/, '');
    preview = `${FRAME_OPEN}\n${inner}\n…\n${FRAME_CLOSE}`;
  }
  return `${head}\n${preview}`;
}

function stateDirOf(ctx) {
  return ctx.stateDir?.path ?? ctx.stateDir ?? path.dirname(ctx.resultsDir);
}

function failureText(e) {
  if (e instanceof BudgetError || e instanceof ApiError || e instanceof InputError) return e.message;
  return `internal error: ${e?.message ?? e}`;
}

// Per-mode requirements the input schema cannot express.
function checkModeArgs(args) {
  if (args.mode === 'grep') {
    if (!args.grep) throw new InputError('mode grep needs "grep": {"pattern": "…"}');
    if (args.dry_run) throw new InputError('dry_run is not used with mode grep (it calls no model)');
    if (args.schema !== undefined) throw new InputError('"schema" is used only with mode schema');
    return;
  }
  if (args.mode === 'schema') {
    if (args.schema === undefined) throw new InputError('mode schema needs "schema": {"field": "description", …}');
    return;
  }
  if (args.schema !== undefined) throw new InputError('"schema" is used only with mode schema');
  if (args.task === undefined) throw new InputError(`mode ${args.mode} needs "task"`);
}

// Probe id for lexical export checks before the real id exists.
const PROBE_ID = '2000-01-01_000000-extract-000000';

// ---- eyes_run ----

export async function eyesRun(args, ctx, deps = {}) {
  const { config, resultsDir } = ctx;
  const platform = deps.platform ?? process.platform;
  const nowFn = deps.now ?? (() => Date.now());
  const key = deps.key !== undefined ? deps.key : (process.env.CHEAP_EYES_OPENROUTER_KEY || null);
  checkModeArgs(args);
  // grep: no model, no OpenRouter call, no key, no budget.
  if (args.mode === 'grep') return grepRun(args, ctx, { ...deps, platform, nowFn });
  if (args.dry_run && args.export_to !== undefined) throw new InputError('export_to is not used with dry_run (the request bodies stay in the results store)');
  if (args.dry_run && args.async) throw new InputError('async is not used with dry_run');
  if (args.export_to !== undefined) await planExport({ config, exportTo: args.export_to, id: PROBE_ID, platform });
  if (!args.dry_run && !key) throw new InputError('OpenRouter key is not set (env CHEAP_EYES_OPENROUTER_KEY)');

  const choice = resolveModelChoice(args.model, args.mode, config);
  const requested = args.max_tokens ?? DEFAULT_MAX_TOKENS[args.mode];
  const or = new OpenRouter({ key, fetch: deps.fetch ?? globalThis.fetch, now: nowFn });
  const input = await prepareInput(args, { config, platform, now: nowFn(), urlDeps: deps.url });

  // Live facts: the public ZDR list and, for a real run, the models the account allows
  // (guardrails, privacy settings). In dry_run the ZDR list is the only network call.
  let zdr = null;
  let zdrError = null;
  const [, account] = await Promise.all([
    or.zdrEndpoints().then(
      (list) => {
        zdr = summarizeZdr(list);
      },
      (e) => {
        if (!(e instanceof ApiError)) throw e;
        zdrError = e.message;
      },
    ),
    args.dry_run ? null : loadAccount(or),
  ]);

  if (args.dry_run) return dryRun(args, ctx, { input, choice, requested, zdr, zdrError });
  if (!zdr) throw new InputError(`cannot resolve a model: the ZDR endpoint list is unavailable (${zdrError})`);

  const plan = planJob(input, choice, { zdr, config, requested, account: account.ids });
  plan.accountNote = account.error ? `account availability: unknown (${account.error})` : null;
  const ledger = deps.ledger ?? ledgerFor(stateDirOf(ctx));
  await ledger.ensure();
  const chunks = plan.chunks.map((c, i) => ({ ...c, index: i + 1 }));

  const created = new Date(nowFn()).toISOString();
  const id = await allocateResult(
    resultsDir,
    args.mode,
    (rid) => ({
      id: rid,
      status: 'running',
      kind: 'run',
      mode: args.mode,
      created,
      alias: choice.alias,
      primary: plan.primary.id,
      async: Boolean(args.async),
      header: `eyes_run running: ${rid}\nmodel: ${choice.label} -> ${plan.primary.id}\nmode: ${args.mode}; files: ${input.files.length}; chunks: ${chunks.length}`,
    }),
    new Date(nowFn()),
  );
  await writeSources(resultsDir, id, input.sourceCopies);

  const controller = new AbortController();
  if (deps.signal) {
    if (deps.signal.aborted) controller.abort();
    else deps.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const job = { controller, progress: { done: 0, total: chunks.length } };
  const run = {
    extra: { cost: 0, attempts: 0, estimated: false },
    or,
    ledger,
    config,
    choice,
    input,
    requested,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    signal: controller.signal,
  };
  job.promise = execute({ id, args, ctx, input, choice, plan, run, chunks, job, created, nowFn, platform }).finally(() => running.delete(id));
  running.set(id, job);

  if (args.async) {
    job.promise.catch((e) => console.error(`cheap-eyes: async job ${id}: ${e?.stack ?? e}`));
    return {
      id,
      async: true,
      header: [
        `eyes_run started (async): ${id}`,
        `model: ${choice.label} -> ${plan.primary.id}; mode: ${args.mode}; files: ${input.files.length}; chunks: ${chunks.length}`,
        `poll: eyes_result {"id": "${id}"}; cancel: eyes_result {"id": "${id}", "cancel": true}`,
      ].join('\n'),
    };
  }
  const res = await job.promise;
  if (res.status !== 'done') {
    const spent = res.rec.cost > 0 ? `; spent $${res.rec.cost.toFixed(6)}${costNote(res.rec)}` : '';
    throw new InputError(`${res.error} — result ${id} saved as ${res.status} with ${res.outs.length}/${res.rec.chunks} chunk(s)${spent}; read it with eyes_result`);
  }
  return res;
}

// Chunks whose answer stopped on finish_reason "length" are split in two by lines and
// both halves run once; a half cut again stays truncated. The cut answers are dropped
// (their cost and tokens still count). Returns { chunks, outs, failure, dropped, resplit }.
async function resplitTruncated({ chunks, outs, failure, input, plan, run, config, job }) {
  if (failure || run.signal.aborted || !RESPLIT_MODES.has(input.mode)) return { chunks, outs, failure, dropped: [], resplit: 0 };
  const splits = [];
  outs.forEach((o, i) => {
    if (!o?.truncated || chunks[i].resplit_of) return;
    const halves = splitChunk(chunks[i], { multi: input.multi });
    if (halves) splits.push({ i, halves });
  });
  if (splits.length === 0) return { chunks, outs, failure, dropped: [], resplit: 0 };
  const halves = splits.flatMap(({ i, halves: hs }) =>
    hs.map((h, k) => {
      const user = userMessage(h.text, input.task);
      return { ...h, user, promptTokens: estimateTokens(input.system) + estimateTokens(user), index: `${i + 1}${'ab'[k]}`, resplit_of: i + 1 };
    }),
  );
  job.progress.total += halves.length;
  let r;
  try {
    r = await pool(halves, config.concurrency, (c) => runChunk(c, plan, run), { signal: run.signal, onDone: () => job.progress.done++ });
  } catch (e) {
    r = { results: halves.map(() => null), failure: e };
  }
  const nextChunks = [];
  const nextOuts = [];
  const dropped = [];
  chunks.forEach((c, i) => {
    const k = splits.findIndex((x) => x.i === i);
    if (k < 0) {
      nextChunks.push(c);
      nextOuts.push(outs[i]);
      return;
    }
    dropped.push(outs[i]);
    nextChunks.push(halves[2 * k], halves[2 * k + 1]);
    nextOuts.push(r.results[2 * k], r.results[2 * k + 1]);
  });
  return { chunks: nextChunks.map((c, n) => ({ ...c, index: n + 1 })), outs: nextOuts, failure: r.failure, dropped, resplit: splits.length };
}

async function execute({ id, args, ctx, input, choice, plan, run, chunks: firstChunks, job, created, nowFn, platform }) {
  const { config, resultsDir } = ctx;
  const t0 = nowFn();
  let results;
  let failure;
  try {
    ({ results, failure } = await pool(firstChunks, config.concurrency, (c) => runChunk(c, plan, run), {
      signal: run.signal,
      onDone: () => job.progress.done++,
    }));
  } catch (e) {
    results = firstChunks.map(() => null);
    failure = e;
  }
  const re = await resplitTruncated({ chunks: firstChunks, outs: results, failure, input, plan, run, config, job });
  const { chunks, outs, dropped, resplit } = re;
  failure = re.failure;
  const done = outs.filter(Boolean);
  const billed = [...done, ...dropped];
  const cancelled = run.signal.aborted;
  const status = cancelled ? 'cancelled' : failure ? 'failed' : 'done';
  const error = status === 'done' ? null : cancelled ? 'cancelled' : failureText(failure);

  const singleName = input.multi ? null : input.kept[0].name;
  const checks =
    args.mode === 'schema'
      ? checkSchemaJob({ schema: input.schema, outs, views: chunks.map((c) => chunkView(c, input.sources, singleName, input.pages, input.places)) })
      : checkJob({ mode: args.mode, chunks, outs, sources: input.sources, pages: input.pages, places: input.places, singleName, spanText });
  const text = checks.text;
  const hints = outs.map((o, i) => (o && o.text.trim() === '' && o.finish_reason === 'length' ? emptyOutputHint(i + 1) : null));

  const rec = {
    ts: created,
    tool: 'eyes_run',
    mode: args.mode,
    alias: choice.alias,
    primary: plan.primary.id,
    models_used: [...new Set(billed.map((o) => o.model))],
    // A URL is logged by host and size only, never its path or query.
    files: input.files.map((f) => (f.host ? { name: f.host, bytes: f.bytes, url: true } : { name: f.name, bytes: f.bytes })),
    chunks: chunks.length,
    chunks_done: done.length,
    tokens_in: billed.reduce((s, o) => s + o.tokens_in, 0),
    tokens_out: billed.reduce((s, o) => s + o.tokens_out, 0),
    cost: billed.reduce((s, o) => s + o.cost, 0) + run.extra.cost,
    ...(resplit ? { resplit } : {}),
    cost_estimated: run.extra.attempts > 0 || run.extra.estimated,
    failed_attempts: run.extra.attempts,
    usage_cost_missing: run.extra.estimated,
    ms: nowFn() - t0,
    truncated: done.filter((o) => o.truncated).length,
    status,
    check: { mode: args.mode, ...checks.summary },
    result_id: id,
  };
  if (status !== 'done') rec.error = failure instanceof BudgetError ? 'budget' : cancelled ? 'cancelled' : (failure?.errorType ?? `http_${failure?.status ?? 0}`);

  const meta = (header, exported) => ({
    id,
    status,
    error,
    kind: 'run',
    mode: args.mode,
    created,
    finished: new Date(nowFn()).toISOString(),
    alias: choice.alias,
    primary: plan.primary.id,
    models_used: rec.models_used,
    tokens_in: rec.tokens_in,
    tokens_out: rec.tokens_out,
    cost: rec.cost,
    cost_estimated: rec.cost_estimated,
    ms: rec.ms,
    files: input.files,
    skipped: input.skipped,
    warnings: input.warnings,
    empty: input.empty,
    filters: input.filters,
    masks: input.masks,
    task_masks: input.taskMasks,
    chunks: chunks.map((c, i) => ({
      index: c.index,
      ...(c.resplit_of ? { resplit_of: c.resplit_of } : {}),
      span: c.span,
      lines: c.lines,
      est_prompt_tokens: c.promptTokens,
      status: outs[i] ? 'done' : 'not finished',
      ...(outs[i]
        ? {
            model: outs[i].model,
            provider: outs[i].provider,
            finish_reason: outs[i].finish_reason,
            truncated: outs[i].truncated,
            tokens_in: outs[i].tokens_in,
            tokens_out: outs[i].tokens_out,
            cost: outs[i].cost,
            cost_estimated: outs[i].cost_estimated,
            failed_cost: outs[i].failed_cost,
            ms: outs[i].ms,
            attempts: outs[i].attempts,
          }
        : {}),
      ...(hints[i] ? { hint: hints[i] } : {}),
    })),
    checks,
    export: exported ?? null,
    header,
  });

  // Optional export, only for a finished job.
  let exported = null;
  let exportError = null;
  if (status === 'done' && (args.export_to !== undefined || config.export_dir)) {
    try {
      const t = await planExport({ config, exportTo: args.export_to, id, platform });
      if (t) {
        const plainHeader = runHeader(id, { input, choice, rec, outs, checks, text, status, error, hints, resplit, accountNote: plan.accountNote });
        exported = await writeExport({
          config,
          stateDir: stateDirOf(ctx),
          files: [
            { path: t.md, text },
            { path: t.check, text: JSON.stringify(meta(plainHeader, null), null, 2) + '\n' },
          ],
          overwrite: Boolean(args.overwrite),
          resultId: id,
          platform,
          now: nowFn(),
        });
      }
    } catch (e) {
      exportError = e instanceof InputError ? e.message : `internal error: ${e?.message ?? e}`;
    }
  }

  const header = runHeader(id, { input, choice, rec, outs, checks, text, status, error, hints, resplit, exported, exportError, accountNote: plan.accountNote });
  await writeResultText(resultsDir, id, text);
  await writeCheck(resultsDir, id, meta(header, exported));
  await appendUsage(stateDirOf(ctx), rec);
  return { id, header, text, outs: done, plan, input, status, error, checks, exported, exportError, rec };
}

async function dryRun(args, ctx, { input, choice, requested, zdr, zdrError }) {
  const { config, resultsDir } = ctx;
  let plan;
  let modelId;
  let maxTokens;
  let contextNote;
  if (zdr) {
    plan = planJob(input, choice, { zdr, config, requested });
    modelId = plan.primary.id;
    maxTokens = plan.primary.maxTokens;
    contextNote = `context ${plan.primary.context} from the ZDR list${config.max_context ? `, max_context ${config.max_context}` : ''}; account availability not checked in dry_run`;
  } else {
    if (config.max_context === undefined) {
      throw new InputError(`dry_run needs a context size: the ZDR list is unavailable (${zdrError}) and max_context is not set in the config`);
    }
    plan = chunkInput(input, config.max_context);
    modelId = choice.ids[0];
    maxTokens = requested;
    contextNote = `max_context ${config.max_context}; ZDR list unavailable, id not checked`;
  }
  const bodies = plan.chunks.map((c) =>
    buildRequestBody({ modelId, params: choice.params, system: input.system, user: c.user, maxTokens }),
  );
  let header;
  const id = await writeResult(resultsDir, args.mode, {
    md: JSON.stringify(bodies, null, 2) + '\n',
    check: (rid) => {
      header = dryRunHeader(rid, input, plan, choice, modelId, contextNote, maxTokens);
      return {
        id: rid,
        status: 'done',
        kind: 'dry_run',
        mode: args.mode,
        created: new Date().toISOString(),
        alias: choice.alias,
        model_id: modelId,
        max_completion_tokens: maxTokens,
        context: contextNote,
        zdr_error: zdrError,
        files: input.files,
        skipped: input.skipped,
        warnings: input.warnings,
        empty: input.empty,
        filters: input.filters,
        masks: input.masks,
        task_masks: input.taskMasks,
        chunks: plan.chunks.map((c, i) => ({ index: i + 1, est_prompt_tokens: c.promptTokens, span: c.span, lines: c.lines })),
        header,
      };
    },
  });
  await writeSources(resultsDir, id, input.sourceCopies);
  return { id, header, bodies, job: { ...input, chunks: plan.chunks, budget: plan.budget } };
}

// ---- mode grep: no model ----

// The matched windows as a model would see them, with every file header and the place
// on lines inside a section ("L123 (p.12)| text", "L40 (slide 3)| text").
export function grepText(input) {
  const out = [];
  for (const k of input.kept) {
    const sections = input.places.get(k.name);
    out.push(fileHeader(k.name));
    for (const it of k.items) {
      const at = it.kind === 'line' ? placeOf(sections, it.n) : null;
      out.push(at === null ? it.text : it.text.replace(/^L(\d+)\|/, `L$1 (${at})|`));
    }
  }
  return out.length ? out.join('\n') + '\n' : '';
}

function framed(head, text, open, close) {
  const { total, shown } = previewLines(text);
  const top = clip(`${head}\nresult lines: ${total}${total > shown.length ? ` (first ${shown.length} below; more via eyes_result)` : ''}`, HEADER_MAX - 600);
  let body = shown.join('\n');
  const room = HEADER_MAX - Buffer.byteLength(top) - open.length - close.length - 20;
  if (Buffer.byteLength(body) > room) body = `${Buffer.from(body).subarray(0, Math.max(0, room)).toString('utf8').replace(/�$/, '')}\n…`;
  return `${top}\n${open}\n${body}\n${close}`;
}

function grepHeader(id, { input, counts, task, exported, exportError }) {
  const lines = [`eyes_run result: ${id}`];
  if (exported?.length) lines.push(`export: ${exported.join(', ')}`);
  if (exportError) lines.push(`export failed: ${exportError}`);
  lines.push(`mode: grep (no model call, cost $0); files: ${counts.files}; matches: ${counts.matches}; lines: ${counts.lines}`);
  if (task) lines.push(`task: ${task.length > 200 ? `${task.slice(0, 200)}…` : task}`);
  const per = input.files.map((f) => `${f.name} ${f.matches ?? 0}`);
  lines.push(`matches per file: ${per.slice(0, 10).join(', ')}${per.length > 10 ? ` (+${per.length - 10} files)` : ''}`);
  lines.push(...commonLines(input));
  return lines.join('\n');
}

async function grepRun(args, ctx, deps) {
  const { config, resultsDir } = ctx;
  const { platform, nowFn } = deps;
  if (args.export_to !== undefined) await planExport({ config, exportTo: args.export_to, id: PROBE_ID, platform });
  const t0 = nowFn();
  const input = await prepareInput(args, { config, platform, now: nowFn(), urlDeps: deps.url });
  const text = grepText(input);
  const counts = {
    files: input.files.length,
    matches: input.files.reduce((s, f) => s + (f.matches ?? 0), 0),
    lines: input.files.reduce((s, f) => s + f.lines_sent, 0),
  };
  const created = new Date(nowFn()).toISOString();
  const id = await allocateResult(resultsDir, 'grep', (rid) => ({ id: rid, status: 'running', kind: 'grep', mode: 'grep', created }), new Date(nowFn()));
  await writeSources(resultsDir, id, input.sourceCopies);
  const meta = (header, exported) => ({
    id,
    status: 'done',
    error: null,
    kind: 'grep',
    mode: 'grep',
    created,
    finished: new Date(nowFn()).toISOString(),
    cost: 0,
    files: input.files,
    skipped: input.skipped,
    warnings: input.warnings,
    empty: input.empty,
    filters: input.filters,
    masks: input.masks,
    task_masks: input.taskMasks,
    counts,
    export: exported ?? null,
    header,
  });
  const make = (extra) => framed(grepHeader(id, { input, counts, task: input.task, ...extra }), text, SOURCE_OPEN, SOURCE_CLOSE);
  let exported = null;
  let exportError = null;
  if (args.export_to !== undefined || config.export_dir) {
    try {
      const t = await planExport({ config, exportTo: args.export_to, id, platform });
      if (t) {
        exported = await writeExport({
          config,
          stateDir: stateDirOf(ctx),
          files: [
            { path: t.md, text },
            { path: t.check, text: JSON.stringify(meta(make({}), null), null, 2) + '\n' },
          ],
          overwrite: Boolean(args.overwrite),
          resultId: id,
          platform,
          now: nowFn(),
        });
      }
    } catch (e) {
      exportError = e instanceof InputError ? e.message : `internal error: ${e?.message ?? e}`;
    }
  }
  const header = make({ exported, exportError });
  await writeResultText(resultsDir, id, text);
  await writeCheck(resultsDir, id, meta(header, exported));
  const rec = {
    ts: created,
    tool: 'eyes_run',
    mode: 'grep',
    alias: null,
    primary: null,
    model: null,
    models_used: [],
    files: input.files.map((f) => (f.host ? { name: f.host, bytes: f.bytes, url: true } : { name: f.name, bytes: f.bytes })),
    chunks: 0,
    chunks_done: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost: 0,
    cost_estimated: false,
    ms: nowFn() - t0,
    status: 'done',
    matches: counts.matches,
    result_id: id,
  };
  await appendUsage(stateDirOf(ctx), rec);
  return { id, header, text, status: 'done', error: null, input, counts, exported, exportError, rec, outs: [] };
}
