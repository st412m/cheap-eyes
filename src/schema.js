// Mode schema: JSON-by-schema extraction with a reference for every field.
// Schema format: a JSON object; a leaf is a description string, optionally starting
// with a type hint ("number — maximum price, RUB"); nested objects; a list is a
// one-element array holding the item template. The answer mirrors the schema; every
// leaf is { value, ref, quote } or { value: null, reason }. Chunks are merged (scalar:
// first non-null wins, different values → conflict; lists: concatenated, duplicates
// (same values and refs) dropped) and every value is checked against the lines its
// chunk carried.
import { foldSpace } from 'doclines';
import { hardTokens, parseQuoteLine, stripFence } from './checks.js';
import { InputError } from './errors.js';
import { hasControlChars } from './input/files.js';

export const MAX_LEAVES = 60;
export const MAX_DEPTH = 4;
const MAX_KEY = 200;
const MAX_LEAF_TEXT = 1000;
const ITEM_TEXT = 200;
export const TYPE_HINTS = ['string', 'number', 'integer', 'boolean', 'date', 'datetime', 'time'];
const HINT_RE = new RegExp(`^\\s*(${TYPE_HINTS.join('|')})\\s*(?:(?:[—–]|\\s-\\s)\\s*(.*))?$`, 'is');

// ---- the schema ----

/**
 * Parse a schema (object or JSON string) into a tree of
 * { kind: 'leaf', type, desc } | { kind: 'object', fields: [[key, node]] } | { kind: 'list', item }.
 * Depth counts path steps (a key or a list level); at most 60 leaves (a list template
 * counts once) and depth 4.
 */
export function parseSchema(input) {
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      throw new InputError(`schema: not valid JSON (${e.message.replace(/ in JSON at position.*$/, '')})`);
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('schema: must be a JSON object of fields');
  let leaves = 0;
  const walk = (v, path, depth) => {
    const at = path || '(root)';
    if (depth > MAX_DEPTH) throw new InputError(`schema: deeper than ${MAX_DEPTH} levels at ${at}`);
    if (typeof v === 'string') {
      if (v.trim() === '') throw new InputError(`schema: empty description at ${at}`);
      if (v.length > MAX_LEAF_TEXT) throw new InputError(`schema: description over ${MAX_LEAF_TEXT} chars at ${at}`);
      if (++leaves > MAX_LEAVES) throw new InputError(`schema: more than ${MAX_LEAVES} fields`);
      // "number" alone or "number — text"; any other text is a description without a type.
      const m = HINT_RE.exec(v);
      return m ? { kind: 'leaf', type: m[1].toLowerCase(), desc: (m[2] ?? '').trim() } : { kind: 'leaf', type: null, desc: v.trim() };
    }
    if (Array.isArray(v)) {
      if (v.length !== 1) throw new InputError(`schema: a list must hold exactly one item template at ${at} (got ${v.length})`);
      return { kind: 'list', item: walk(v[0], `${path}[]`, depth + 1) };
    }
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (keys.length === 0) throw new InputError(`schema: empty object at ${at}`);
      const fields = keys.map((k) => {
        if (k.trim() === '' || k.length > MAX_KEY || hasControlChars(k)) throw new InputError(`schema: bad field name at ${at}: ${JSON.stringify(k.slice(0, 50))}`);
        return [k, walk(v[k], path ? `${path}.${k}` : k, depth + 1)];
      });
      return { kind: 'object', fields };
    }
    throw new InputError(`schema: a field must be a description string, an object or a one-item list at ${at} (got ${v === null ? 'null' : typeof v})`);
  };
  const tree = walk(raw, '', 0);
  return { tree, leaves, json: raw };
}

// The task text sent with every chunk: the schema itself, then the caller's notes.
export function schemaTask(schema, task) {
  return `Fill this schema from the input:\n${JSON.stringify(schema.json)}${task ? `\nInstructions: ${task}` : ''}`;
}

// ---- normalisation ----

const NUMERIC_RE = /^[-−+]?(?:\d[\d\s\u00a0\u202f'’.,]*\d|\d)$/;

// Thousands groups: the first 1–3 digits and not starting with 0, every next one exactly 3.
function thousands(groups) {
  return /^[1-9]\d{0,2}$/.test(groups[0]) && groups.slice(1).every((g) => /^\d{3}$/.test(g));
}

/**
 * Every reading of a number written with separators, most likely first; [] when it is
 * not a number. "3 605 044,00" → [3605044], "0,500" → [0.5], "1.000.000" → [1000000].
 * Several equal separators that are not thousands groups (versions, IPs, dates) → [].
 * One separator with exactly 3 digits after a 1–3 digit group is ambiguous:
 * "1,500" → [1500, 1.5], "12.500" → [12.5, 12500].
 */
export function numberReadings(s) {
  if (typeof s === 'number') return Number.isFinite(s) ? [s] : [];
  if (typeof s !== 'string') return [];
  let t = s.trim().replace(/^−/, '-');
  if (!NUMERIC_RE.test(t)) return [];
  const sign = t.startsWith('-') || t.startsWith('+') ? t[0] : '';
  t = t.slice(sign.length);
  const num = (int, frac = '') => {
    const n = Number(`${sign === '-' ? '-' : ''}${int}${frac ? `.${frac}` : ''}`);
    return Number.isFinite(n) ? n : null;
  };
  // Spaces and apostrophes can only be thousands separators; a dot or comma after them is decimal.
  const spaced = /[\s\u00a0\u202f'’]/.test(t);
  const [intRaw, ...rest] = t.split(/[.,]/);
  const seps = t.match(/[.,]/g) ?? [];
  if (spaced) {
    if (!thousands(intRaw.split(/[\s\u00a0\u202f'’]+/)) || seps.length > 1 || /[\s\u00a0\u202f'’]/.test(rest.join(''))) return [];
    const n = num(intRaw.replace(/[\s\u00a0\u202f'’]+/g, ''), rest[0]);
    return n === null ? [] : [n];
  }
  if (seps.length === 0) return [num(t)].filter((n) => n !== null);
  const dot = seps.filter((c) => c === '.').length;
  const comma = seps.length - dot;
  if (dot && comma) {
    // Both: the last one is decimal and occurs once; the other groups thousands.
    const dec = t.lastIndexOf('.') > t.lastIndexOf(',') ? '.' : ',';
    const [int, frac, ...more] = t.split(dec);
    if (more.length || !thousands(int.split(dec === '.' ? ',' : '.'))) return [];
    const n = num(int.replace(/[.,]/g, ''), frac);
    return n === null ? [] : [n];
  }
  const sep = dot ? '.' : ',';
  const parts = t.split(sep);
  if (parts.length > 2) return thousands(parts) ? [num(parts.join(''))].filter((n) => n !== null) : [];
  const [int, frac] = parts;
  const asDecimal = num(int, frac);
  if (frac.length === 3 && thousands([int, frac])) {
    // Ambiguous: a comma reads as thousands first, a dot as a decimal point first.
    const asThousands = num(int + frac);
    return sep === ',' ? [asThousands, asDecimal] : [asDecimal, asThousands];
  }
  return asDecimal === null ? [] : [asDecimal];
}

// The most likely reading, or null (then the value compares as text).
export function parseNumberish(s) {
  return numberReadings(s)[0] ?? null;
}

// Text for comparing values: NFC, whitespace collapsed, trailing . , ; : and enclosing
// quotes "…" «…» “…” dropped (repeatedly: «Анадырь». → Анадырь).
function normText(s) {
  let t = s.normalize('NFC').replace(/\s+/g, ' ').trim();
  for (let prev = null; prev !== t; ) {
    prev = t;
    t = t.replace(/[.,;:]+$/, '').trim();
    const q = /^(["«“])([\s\S]*)(["»”])$/.exec(t);
    if (q && ({ '"': '"', '«': '»', '“': '”' })[q[1]] === q[3]) t = q[2].trim();
  }
  return t;
}

export function normValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return parseNumberish(v);
  if (typeof v === 'string') {
    const t = normText(v);
    const n = parseNumberish(t);
    return n !== null ? n : t;
  }
  if (Array.isArray(v)) return v.map(normValue);
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, normValue(v[k])]));
  return v;
}

const normKey = (v) => JSON.stringify(normValue(v));

// ---- the answer ----

/** Parse a chunk answer: one ``` wrapper stripped; on failure one repair attempt. */
export function parseAnswer(text) {
  const body = stripFence(text).join('\n').trim();
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  const first = tryParse(body);
  if (first) return { value: first, repaired: false };
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  if (a >= 0 && b > a) {
    const fixed = tryParse(body.slice(a, b + 1).replace(/,(\s*[}\]])/g, '$1'));
    if (fixed) return { value: fixed, repaired: true };
  }
  return null;
}

const REF_TAIL = /^L(\d+)(?:\s*[-–]\s*L?(\d+))?$/;
// A place after the ref, " (p.3)" or " (attachment: a (1).pdf, p.2)": read and ignored.
const PLACE_TAIL = /\s+\((?:[^()\n]|\([^()\n]*\))*\)$/;

// "L12", "L10-L14", "name:L5", any of them with a place "L12 (slide 2)" (several refs
// as an array) → [{ name, from, to }] or an error.
export function parseRef(ref, view) {
  const list = Array.isArray(ref) ? ref : [ref];
  if (list.length === 0 || list.some((r) => typeof r !== 'string' || r.trim() === '')) return { error: 'no ref' };
  const out = [];
  for (const r0 of list) {
    const r = r0.trim().replace(PLACE_TAIL, '').replace(/^\(|\)$/g, '').replace(PLACE_TAIL, '');
    let name = null;
    let rest = r;
    const known = view.names.find((n) => r.startsWith(`${n}:L`));
    if (known) {
      name = known;
      rest = r.slice(known.length + 1);
    } else {
      const m = /^(.+?):(L\d.*)$/.exec(r);
      if (m) {
        name = m[1];
        rest = m[2];
      }
    }
    const m = REF_TAIL.exec(rest);
    if (!m) return { error: `unreadable ref: ${r.slice(0, 60)}` };
    const from = Number(m[1]);
    const to = m[2] !== undefined ? Number(m[2]) : from;
    // A file name, or the name of an attachment holding these lines (see chunkView).
    const found = view.lookupAt(name, from, to);
    const file = found.name ?? null;
    if (!file) return { error: name ? view.nameProblem(name, `unknown file in ref: ${name}`, found) : 'file name missing in ref (several files)' };
    if (to < from) return { error: `bad ref range: ${r}` };
    for (let n = from; n <= to; n++) if (!view.has(file, n)) return { error: `ref outside this chunk's input: ${r}` };
    out.push({ name: file, from, to });
  }
  return { refs: out };
}

// Numbers in a quote, separators normalised ("3 605 044,00" → 3605044).
function numbersIn(s) {
  const out = new Set();
  for (const m of s.replace(/−/g, '-').matchAll(/-?\d[\d\s\u00a0\u202f'’.,]*\d|-?\d/g)) {
    // Every reading of an ambiguous "12,500": the value may be either.
    for (const piece of [m[0], ...m[0].split(/\s+/)]) for (const n of numberReadings(piece)) out.add(n);
  }
  return out;
}

// Hard tokens of the value that the quote does not carry (soft check).
export function missingTokens(value, quote) {
  const vals = Array.isArray(value) ? value : [value];
  const missing = [];
  const nums = numbersIn(quote);
  const lower = quote.toLowerCase();
  for (const v of vals) {
    if (v === null || typeof v === 'boolean' || typeof v === 'object') continue;
    const n = parseNumberish(v);
    if (n !== null) {
      if (Math.abs(n) >= 10 && !nums.has(n)) missing.push(String(v));
      continue;
    }
    const { tokens, numbers } = hardTokens(String(v));
    for (const t of tokens) if (!lower.includes(t.value.toLowerCase())) missing.push(t.value);
    for (const d of numbers) if (!nums.has(Number(d)) && !quote.includes(d)) missing.push(d);
  }
  return missing;
}

// The quote without line prefixes ("L12| ", "L12 (slide 2)| ", "name:L12| ") the model
// copied from the input, each line of the quote on its own; a prefix is stripped only
// when it names one of the cited lines. Null when nothing was stripped.
function withoutLinePrefixes(quote, refs, view) {
  let stripped = false;
  const lines = quote.split('\n').map((line) => {
    const q = parseQuoteLine(line, view.names);
    if (!q) return line;
    const name = q.name === null ? null : (view.lookupAt(q.name, q.n).name ?? null);
    if (q.name !== null && !name) return line;
    if (!refs.some((x) => (name === null || x.name === name) && x.from <= q.n && q.n <= x.to)) return line;
    stripped = true;
    return q.text;
  });
  return stripped ? lines.join('\n') : null;
}

/** Status of one value against its chunk: ok | ok~ | quote_mismatch | bad_ref | value_not_in_quote. */
export function checkValue({ value, ref, quote: quote0 }, view) {
  const r = parseRef(ref, view);
  if (r.error) return { status: 'bad_ref', note: r.error };
  const first = r.refs[0];
  const page = view.page(first.name, first.from);
  const place = view.place(first.name, first.from);
  const prefix = view.names.length > 1 || !view.singleName;
  const refText = r.refs.map((x) => `${prefix ? `${x.name}:` : ''}L${x.from}${x.to !== x.from ? `-L${x.to}` : ''}`).join(', ');
  const base = { ref: place !== null ? `${refText} (${place})` : refText, ...(page !== null ? { page } : {}), ...(place !== null ? { place } : {}) };
  if (typeof quote0 !== 'string' || quote0.trim() === '') return { ...base, status: 'quote_mismatch', note: 'no quote' };
  const cited = r.refs.flatMap((x) => Array.from({ length: x.to - x.from + 1 }, (_, k) => view.text(x.name, x.from + k)));
  const found = (q) => (cited.join('\n').includes(q) || cited.join(' ').includes(q) ? 'ok' : foldSpace(cited.join(' ')).includes(foldSpace(q)) ? 'ok~' : null);
  let quote = quote0;
  let status = found(quote);
  const bare = status ? null : withoutLinePrefixes(quote0, r.refs, view);
  if (bare !== null) {
    quote = bare;
    if (bare.trim() !== '' && found(quote)) status = 'ok~';
  }
  if (!status) {
    const where = view.find(foldSpace(quote));
    return { ...base, status: 'quote_mismatch', note: where ? `quote found at ${where}` : 'quote not in the cited lines' };
  }
  const missing = missingTokens(value, quote);
  if (missing.length) return { ...base, status: 'value_not_in_quote', note: `not in quote: ${missing.slice(0, 5).join(', ')}` };
  return { ...base, status };
}

// ---- merge ----

// Accumulators mirror the schema: leaf { values: [entry], reason }, object Map, list [item acc].
function emptyAcc(node) {
  // values: every answered value with its ref (one entry per value and ref).
  if (node.kind === 'leaf') return { kind: 'leaf', values: [], reason: null };
  if (node.kind === 'object') return { kind: 'object', fields: new Map(node.fields.map(([k, n]) => [k, emptyAcc(n)])) };
  return { kind: 'list', items: [], keys: new Set() };
}

function leafEntries(a, chunk, view) {
  const one = (value, ref, quote) => ({ value, ref, quote, chunk, ...checkValue({ value, ref, quote }, view) });
  if (a === undefined) return { nulls: 'missing in answer' };
  if (a === null || typeof a !== 'object' || Array.isArray(a)) {
    if (a === null) return { nulls: 'NOT IN INPUT' };
    return { entries: [{ value: a, ref: null, quote: null, chunk, status: 'bad_ref', note: 'no ref (bare value)' }] };
  }
  if (a.conflict === true && Array.isArray(a.value)) {
    const refs = Array.isArray(a.refs) ? a.refs : [];
    const quotes = Array.isArray(a.quotes) ? a.quotes : [];
    return { entries: a.value.map((v, i) => one(v, refs[i] ?? null, quotes[i] ?? null)) };
  }
  if (a.value === null || a.value === undefined) return { nulls: typeof a.reason === 'string' ? a.reason.slice(0, ITEM_TEXT) : 'NOT IN INPUT' };
  return { entries: [one(a.value, a.ref ?? null, a.quote ?? null)] };
}

// Fold one chunk's answer for `node` into `acc`.
function mergeInto(acc, node, a, chunk, view) {
  if (node.kind === 'leaf') {
    const got = leafEntries(a, chunk, view);
    if (got.nulls) {
      if (acc.values.length === 0) acc.reason ??= got.nulls;
      return;
    }
    // The same value from the same lines (chunk overlap) is one entry; every other
    // entry is kept, so equal values keep all their refs.
    for (const e of got.entries) {
      if (acc.values.some((x) => normKey(x.value) === normKey(e.value) && x.ref === e.ref)) continue;
      acc.values.push(e);
    }
    if (acc.values.length) acc.reason = null;
    return;
  }
  if (node.kind === 'object') {
    const obj = a && typeof a === 'object' && !Array.isArray(a) ? a : {};
    for (const [k, n] of node.fields) mergeInto(acc.fields.get(k), n, obj[k], chunk, view);
    return;
  }
  const list = Array.isArray(a) ? a : a === null || a === undefined ? [] : [a];
  for (const el of list) {
    const item = emptyAcc(node.item);
    mergeInto(item, node.item, el, chunk, view);
    // A duplicate has the same values AND the same refs (the same lines read twice);
    // equal rows on different lines are different items.
    const key = JSON.stringify([plain(item, true), refsOf(item)]);
    if (acc.keys.has(key)) continue;
    acc.keys.add(key);
    acc.items.push(item);
  }
}

// Entries grouped by normalised value, in first-seen order.
function groups(acc) {
  const by = new Map();
  for (const x of acc.values) {
    const k = normKey(x.value);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(x);
  }
  return [...by.values()];
}

// Every ref inside an item, in order (refs of null leaves are absent).
function refsOf(acc) {
  if (acc.kind === 'leaf') return acc.values.map((x) => x.ref);
  if (acc.kind === 'object') return [...acc.fields.values()].flatMap(refsOf);
  return acc.items.flatMap(refsOf);
}

// The merged answer (or, with `norm`, a comparable key of it). One distinct value is a
// plain value (the first as written; several refs are all kept); two or more are a
// conflict with the first value, ref and quote of each.
function plain(acc, norm = false) {
  if (acc.kind === 'leaf') {
    if (acc.values.length === 0) return norm ? null : { value: null, reason: acc.reason ?? 'NOT IN INPUT' };
    const g = groups(acc);
    if (norm) return g.map((xs) => normValue(xs[0].value));
    if (g.length === 1) {
      const [x] = g[0];
      const out = { value: x.value, ref: x.ref, quote: x.quote };
      if (g[0].length > 1) Object.assign(out, { refs: g[0].map((y) => y.ref), quotes: g[0].map((y) => y.quote) });
      return out;
    }
    return { value: g.map((xs) => xs[0].value), conflict: true, refs: g.map((xs) => xs[0].ref), quotes: g.map((xs) => xs[0].quote) };
  }
  if (acc.kind === 'object') return Object.fromEntries([...acc.fields].map(([k, a]) => [k, plain(a, norm)]));
  return acc.items.map((i) => plain(i, norm));
}

function clip(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > ITEM_TEXT ? `${s.slice(0, ITEM_TEXT)}…` : s;
}

// Check items for the merged answer, one per value; null and conflict fields too.
function items(acc, path, out) {
  if (acc.kind === 'leaf') {
    if (acc.values.length === 0) {
      out.push({ path, status: 'null', reason: acc.reason ?? 'NOT IN INPUT' });
      return;
    }
    // A conflict only when values differ after normalisation; every entry is checked.
    const distinct = groups(acc).length;
    const conflict = distinct > 1;
    if (conflict) out.push({ path, status: 'conflict', values: distinct });
    for (const x of acc.values) {
      const it = { path, status: x.status, chunk: x.chunk, ref: x.ref ?? null, value: clip(x.value) };
      if (x.page !== undefined) it.page = x.page;
      if (x.place !== undefined) it.place = x.place;
      if (x.note) it.note = x.note;
      if (conflict) it.conflict = true;
      if (x.status !== 'ok' && x.status !== 'ok~' && x.quote) it.quote = clip(x.quote);
      out.push(it);
    }
    return;
  }
  if (acc.kind === 'object') {
    for (const [k, a] of acc.fields) items(a, path ? `${path}.${k}` : k, out);
    return;
  }
  acc.items.forEach((a, i) => items(a, `${path}[${i}]`, out));
}

export const SCHEMA_PROBLEMS = new Set(['quote_mismatch', 'bad_ref', 'value_not_in_quote', 'conflict', 'failed']);

/**
 * Check and merge every chunk's answer. `views[i]` as in checks.js; `outs[i]` may be
 * null (chunk not finished). Returns { mode, summary, items, failed, text, merged }.
 */
export function checkSchemaJob({ schema, outs, views }) {
  const acc = emptyAcc(schema.tree);
  const failed = [];
  let repaired = 0;
  outs.forEach((o, i) => {
    if (!o) return;
    const parsed = parseAnswer(o.text);
    if (!parsed) {
      failed.push({ chunk: i + 1, status: 'failed', reason: 'answer is not a JSON object (after one repair attempt)', text: clip(o.text) });
      return;
    }
    if (parsed.repaired) repaired++;
    mergeInto(acc, schema.tree, parsed.value, i + 1, views[i]);
  });
  const list = [];
  items(acc, '', list);
  const c = { ok: 0, 'ok~': 0, quote_mismatch: 0, bad_ref: 0, value_not_in_quote: 0, null: 0, conflict: 0 };
  for (const it of list) if (it.status in c) c[it.status]++;
  const checked = c.ok + c['ok~'] + c.quote_mismatch + c.bad_ref + c.value_not_in_quote;
  const merged = plain(acc);
  return {
    mode: 'schema',
    summary: {
      fields: schema.leaves,
      values: checked,
      ...c,
      failed_chunks: failed.length,
      repaired_chunks: repaired,
      refs_ok: c.ok + c['ok~'] + c.value_not_in_quote,
      refs_bad: c.bad_ref + c.quote_mismatch,
      pass_rate: checked ? (c.ok + c['ok~']) / checked : null,
    },
    items: [...failed, ...list],
    text: `\`\`\`json\n${JSON.stringify(merged, null, 2)}\n\`\`\`\n`,
  };
}

export function schemaSummaryLine(s) {
  return (
    `check (schema): fields ok ${s.ok + s['ok~']} / mismatch ${s.quote_mismatch} / null ${s.null} / conflict ${s.conflict}` +
    `; bad ref ${s.bad_ref}, value not in quote ${s.value_not_in_quote}${s.failed_chunks ? `; FAILED chunks ${s.failed_chunks}` : ''}${s.repaired_chunks ? `; repaired JSON ${s.repaired_chunks}` : ''}`
  );
}
