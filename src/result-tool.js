// eyes_result: status and header, paged lines, grep, check report, stored source
// text, cancel. Result views are framed as untrusted model output, source views as
// source text.
import { OK_STATUSES } from './checks.js';
import { InputError } from './errors.js';
import { FRAME_CLOSE, FRAME_OPEN, SOURCE_CLOSE, SOURCE_OPEN, neutralize } from './frame.js';
import { grepMatches } from './input/grep.js';
import { readCheck, readResultText, running, statusOf } from './results.js';
import { readSourceLines, readSourcesIndex } from './sources.js';

export const MAX_LINES = 200;
export const MAX_BYTES = 16 * 1024;
export const LINE_CLIP = 400;
const ITEM_CLIP = 200;
const CANCEL_WAIT_MS = 60_000;

function splitLines(text) {
  if (!text) return [];
  const lines = text.replace(/\n$/, '').split('\n');
  return lines;
}

// Lines over 400 chars are clipped in paged views unless `full`.
export function clipLine(t, full) {
  return full || t.length <= LINE_CLIP ? t : `${t.slice(0, LINE_CLIP)} … (+${t.length - LINE_CLIP} chars)`;
}

// Up to `limit` (≤ 200) entries and 16 KB from `offset`. Numbering is 1-based: offset 1
// is the first entry, and for result lines it equals `result_line` in the check report.
// `entries`: [{ text }]; entries with `extra: true` (marker lines) do not count
// toward `limit`.
function page(entries, { offset = 1, limit = MAX_LINES, label = 'lines', full = false, frame = [FRAME_OPEN, FRAME_CLOSE], first = offset - 1 } = {}) {
  const lim = Math.min(limit, MAX_LINES);
  const out = [];
  let bytes = 0;
  let counted = 0;
  let i = first;
  for (; i < entries.length && counted < lim; i++) {
    let t = clipLine(entries[i].text, full);
    const b = Buffer.byteLength(t) + 1;
    if (bytes + b > MAX_BYTES) {
      if (out.length > 0) break;
      t = Buffer.from(t).subarray(0, MAX_BYTES - 64).toString('utf8').replace(/�$/, '') + ' … (line clipped)';
    }
    out.push(t);
    bytes += Buffer.byteLength(t) + 1;
    if (!entries[i].extra) counted++;
  }
  const more = i < entries.length;
  const range = counted ? `${offset}–${offset + counted - 1}` : 'none';
  const total = entries.filter((e) => !e.extra).length;
  const nextOffset = offset + counted;
  const head = `${label} ${range} of ${total}${more ? `; more: next offset ${nextOffset}` : '; end'}`;
  return `${head}\n${frame[0]}\n${out.map(neutralize).join('\n')}\n${frame[1]}`;
}

function statusBlock(id, check) {
  const status = statusOf(id, check);
  const lines = [`status: ${status}`];
  const job = running.get(id);
  if (job?.progress) lines.push(`progress: ${job.progress.done}/${job.progress.total} chunks`);
  if (status === 'interrupted') lines.push('the server restarted while this job was running; finished chunks, if any, were not saved');
  if (check.error) lines.push(`error: ${check.error}`);
  if (check.header) lines.push(check.header);
  return lines.join('\n');
}

function clipField(v) {
  if (typeof v === 'string') return v.length > ITEM_CLIP ? `${v.slice(0, ITEM_CLIP)}…` : v;
  if (Array.isArray(v)) return v.map(clipField);
  return v;
}

function checkView(check, args) {
  if (!check.checks) return `no check report for this result (kind: ${check.kind ?? 'unknown'})`;
  const c = check.checks;
  let items = [...(c.items ?? [])].sort((a, b) => rank(a) - rank(b));
  let label = 'items (bad first)';
  if (args.check !== 'all') {
    items = items.filter((it) => !OK_STATUSES.has(it.status)).map((it) => Object.fromEntries(Object.entries(it).map(([k, v]) => [k, clipField(v)])));
    label = 'items not ok (bad first; check: "all" for every item)';
  }
  const entries = items.map((it) => ({ text: JSON.stringify(it) }));
  return `check summary: ${JSON.stringify(c.summary)}\n${page(entries, { offset: args.offset ?? 1, limit: args.limit ?? MAX_LINES, label, full: true })}`;
}

const LINE_RE = /^L(\d+)\| ?(.*)$/;

async function sourceView(resultsDir, id, args) {
  const index = await readSourcesIndex(resultsDir, id);
  if (!index) return 'no stored source text for this result (kept for every format but plain text, for URLs and for schema jobs)';
  const entry = index.find((e) => e.name === args.source);
  if (!entry) {
    const names = index.map((e) => e.name);
    throw new InputError(`unknown source: ${args.source}; this result has: ${names.slice(0, 20).join(', ')}${names.length > 20 ? ` (+${names.length - 20})` : ''}`);
  }
  const rendered = await readSourceLines(resultsDir, id, entry.n);
  // [{ n, text }] for numbered lines, { extra: true } for marker lines.
  // The 400-char clip counts the line itself, not its "L12| " prefix.
  const entries = rendered.map((t) => {
    const m = LINE_RE.exec(t);
    return m ? { n: Number(m[1]), body: m[2], text: `L${m[1]}| ${clipLine(m[2], args.full)}` } : { extra: true, text: t };
  });
  const what = `source ${entry.name} (${entry.format}${entry.pages ? `, ${entry.pages} pages` : ''})`;
  const frame = [SOURCE_OPEN, SOURCE_CLOSE];
  if (args.grep !== undefined) {
    const numbered = entries.filter((e) => !e.extra);
    const [hits] = await grepMatches([numbered.map((e) => e.body)], { pattern: args.grep });
    const shown = hits.map((i) => ({ text: numbered[i].text }));
    return `${what}\n${page(shown, { offset: args.offset ?? 1, limit: args.limit ?? MAX_LINES, label: 'matches', full: true, frame })}`;
  }
  // offset is a source line number; marker lines just before it are shown with it.
  const offset = args.offset ?? 1;
  let first = entries.findIndex((e) => !e.extra && e.n >= offset);
  if (first < 0) first = entries.length;
  while (first > 0 && entries[first - 1].extra) first--;
  return `${what}\n${page(entries, { offset, limit: args.limit ?? MAX_LINES, label: 'lines', full: true, frame, first })}`;
}

export async function eyesResult(args, ctx) {
  const { resultsDir } = ctx;
  const { id } = args;
  const check = await readCheck(resultsDir, id);
  if (!check) throw new InputError(`unknown result id: ${id}`);

  if (args.cancel) {
    const job = running.get(id);
    if (!job) return `not running (status: ${statusOf(id, check)})`;
    job.controller.abort();
    await Promise.race([job.promise.catch(() => {}), new Promise((r) => setTimeout(r, CANCEL_WAIT_MS).unref())]);
    const after = await readCheck(resultsDir, id);
    return statusBlock(id, after ?? check);
  }

  if (args.source !== undefined) {
    if (args.check) throw new InputError('source and check are separate views: pass one of them');
    return sourceView(resultsDir, id, args);
  }

  const status = statusOf(id, check);
  const wantsView = args.check || args.grep !== undefined || args.offset !== undefined || args.limit !== undefined;
  if (!wantsView) return statusBlock(id, check);
  if (status === 'running' || status === 'interrupted') return statusBlock(id, check);

  if (args.check) return checkView(check, args);

  const text = await readResultText(resultsDir, id);
  if (text === null) return `no stored text for this result (status: ${status})`;
  const lines = splitLines(text);
  // A grep result is source text, not model output.
  const frame = check.kind === 'grep' ? [SOURCE_OPEN, SOURCE_CLOSE] : [FRAME_OPEN, FRAME_CLOSE];

  if (args.grep !== undefined) {
    const [hits] = await grepMatches([lines], { pattern: args.grep });
    const entries = hits.map((i) => ({ text: `#${i + 1}: ${clipLine(lines[i], args.full)}` }));
    return page(entries, { offset: args.offset ?? 1, limit: args.limit ?? MAX_LINES, label: 'matches', full: true, frame });
  }
  return page(
    lines.map((t) => ({ text: t })),
    { offset: args.offset ?? 1, limit: args.limit ?? MAX_LINES, full: args.full, frame },
  );
}

function rank(it) {
  return it.status === 'bad' ? 0 : it.status === 'flag' ? 1 : it.status === 'partial' ? 2 : 3;
}
