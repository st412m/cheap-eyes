// eyes_result: status and header, paged lines, grep, check report, cancel.
// Every view of stored text is framed as untrusted model output.
import { InputError } from './errors.js';
import { grepMatches } from './input/grep.js';
import { readCheck, readResultText, running, statusOf } from './results.js';
import { FRAME_CLOSE, FRAME_OPEN, neutralize } from './run.js';

export const MAX_LINES = 200;
export const MAX_BYTES = 16 * 1024;
const CANCEL_WAIT_MS = 60_000;

function splitLines(text) {
  if (!text) return [];
  const lines = text.replace(/\n$/, '').split('\n');
  return lines;
}

// Up to `limit` (≤ 200) entries and 16 KB from `offset`. Numbering is 1-based: offset 1
// is the first entry, and for result lines it equals `result_line` in the check report.
// `entries`: [{ text }].
function page(entries, offset = 1, limit = MAX_LINES, label = 'lines') {
  const lim = Math.min(limit, MAX_LINES);
  const out = [];
  let bytes = 0;
  let i = offset - 1;
  for (; i < entries.length && out.length < lim; i++) {
    let t = entries[i].text;
    const b = Buffer.byteLength(t) + 1;
    if (bytes + b > MAX_BYTES) {
      if (out.length > 0) break;
      t = Buffer.from(t).subarray(0, MAX_BYTES - 64).toString('utf8').replace(/�$/, '') + ' … (line clipped)';
    }
    out.push(t);
    bytes += Buffer.byteLength(t) + 1;
  }
  const more = i < entries.length;
  const range = out.length ? `${offset}–${offset + out.length - 1}` : 'none';
  const head = `${label} ${range} of ${entries.length}${more ? `; more: next offset ${i + 1}` : '; end'}`;
  return `${head}\n${FRAME_OPEN}\n${out.map(neutralize).join('\n')}\n${FRAME_CLOSE}`;
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

  const status = statusOf(id, check);
  const wantsView = args.check || args.grep !== undefined || args.offset !== undefined || args.limit !== undefined;
  if (!wantsView) return statusBlock(id, check);
  if (status === 'running' || status === 'interrupted') return statusBlock(id, check);

  if (args.check) {
    if (!check.checks) return `no check report for this result (kind: ${check.kind ?? 'unknown'})`;
    const c = check.checks;
    const items = [...(c.items ?? [])].sort((a, b) => rank(a) - rank(b));
    const entries = items.map((it) => ({ text: JSON.stringify(it) }));
    return `check summary: ${JSON.stringify(c.summary)}\n${page(entries, args.offset ?? 1, args.limit ?? MAX_LINES, 'items (bad first)')}`;
  }

  const text = await readResultText(resultsDir, id);
  if (text === null) return `no stored text for this result (status: ${status})`;
  const lines = splitLines(text);

  if (args.grep !== undefined) {
    const [hits] = await grepMatches([lines], { pattern: args.grep });
    const entries = hits.map((i) => ({ text: `#${i + 1}: ${lines[i]}` }));
    return page(entries, args.offset ?? 1, args.limit ?? MAX_LINES, 'matches');
  }
  return page(lines.map((t) => ({ text: t })), args.offset ?? 1, args.limit ?? MAX_LINES);
}

function rank(it) {
  return it.status === 'bad' ? 0 : it.status === 'flag' ? 1 : it.status === 'partial' ? 2 : 3;
}
