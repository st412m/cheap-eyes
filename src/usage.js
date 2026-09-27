// Usage log <state_dir>/usage.jsonl: one record per job. Never task text, file
// content or model output — names, sizes, counts, tokens, cost, time.
import fs from 'node:fs/promises';
import path from 'node:path';

export function usagePath(stateDir) {
  return path.join(stateDir, 'usage.jsonl');
}

export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function appendUsage(stateDir, record) {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.appendFile(usagePath(stateDir), JSON.stringify(record) + '\n');
}

export async function readUsage(stateDir) {
  let text;
  try {
    text = await fs.readFile(usagePath(stateDir), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn last line after a crash: skip it
    }
  }
  return out;
}

export function spentOnDay(records, day) {
  let s = 0;
  for (const r of records) if (!r.dry_run && typeof r.cost === 'number' && String(r.ts).startsWith(day)) s += r.cost;
  return s;
}

function bump(map, key, r) {
  const a = (map[key] ??= { jobs: 0, cost: 0, tokens_in: 0, tokens_out: 0, failed: 0 });
  a.jobs++;
  a.cost += r.cost ?? 0;
  a.tokens_in += r.tokens_in ?? 0;
  a.tokens_out += r.tokens_out ?? 0;
  if (r.status && r.status !== 'done') a.failed++;
}

// Totals for today (UTC) and all time, by alias and by model id actually used.
export function aggregate(records, today) {
  const empty = () => ({ jobs: 0, cost: 0, estimated: 0, tokens_in: 0, tokens_out: 0, by_alias: {}, by_model: {} });
  const res = { today: empty(), all: empty() };
  for (const r of records) {
    if (r.dry_run || r.tool !== 'eyes_run') continue;
    const scopes = [res.all];
    if (String(r.ts).startsWith(today)) scopes.push(res.today);
    for (const s of scopes) {
      s.jobs++;
      s.cost += r.cost ?? 0;
      if (r.cost_estimated) s.estimated++;
      s.tokens_in += r.tokens_in ?? 0;
      s.tokens_out += r.tokens_out ?? 0;
      bump(s.by_alias, r.alias ?? '(raw id)', r);
      for (const id of r.models_used ?? []) bump(s.by_model, id, r);
    }
  }
  return res;
}
