// Mechanical checks of a model answer against the exact lines each chunk carried.
// They catch invented lines, refs outside the input and values missing from the cited
// lines; they do not measure completeness or relevance.
import { foldSpace, pageOf } from 'doclines';
import { nameText, PLACE_IN_PREFIX, placeOf } from './place.js';

const MASK_TOKEN = /\[[a-z_]+\]|<[A-Z][A-Z_]*>/;
const NOT_IN_INPUT = /^\W*NOT IN INPUT\W*$/i;
const WIDE_REF = 30;
const ITEM_TEXT = 200;

function clipText(s, n = ITEM_TEXT) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Whitespace-level comparison: NBSP is whitespace, U+00AD does not count.
const collapse = foldSpace;

// Remove one ``` wrapper around the whole answer.
export function stripFence(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines.at(-1).trim() === '') lines.pop();
  if (lines.length >= 2 && /^```[\w-]*\s*$/.test(lines[0]) && /^```\s*$/.test(lines.at(-1))) return lines.slice(1, -1);
  return lines;
}

/**
 * What one chunk carried: `has(name, n)`, `text(name, n)`, `page(name, n)` (a PDF
 * page; null without a page table), `place(name, n)` (from the sections; null outside
 * them), and the name to use when a single-file answer omits it.
 */
export function chunkView(chunk, sources, singleName, pages = new Map(), places = new Map()) {
  const sets = new Map();
  for (const [name, ranges] of Object.entries(chunk.lines)) {
    const set = new Set();
    for (const [a, b] of ranges) for (let n = a; n <= b; n++) set.add(n);
    sets.set(name, set);
  }
  // Longest first, so "a b.md" wins over "b.md" and names with spaces, brackets or "#" match whole.
  const names = [...new Set([...sets.keys(), ...(singleName ? [singleName] : [])])].sort((a, b) => b.length - a.length);
  // A name in a ref: the header name it equals; otherwise the only carried name that
  // ends with "/" + it (models shorten "raw/x/2. Проект ГК.doc" to "2. Проект ГК.doc").
  // Returns { name } or { ambiguous: true } or { unknown: true }.
  const lookup = (name) => {
    if (name === undefined || name === null || name === '') return singleName ? { name: singleName } : { unknown: true };
    if (sets.has(name)) return { name };
    const tail = [...sets.keys()].filter((n) => n.endsWith(`/${name}`));
    if (tail.length === 1) return { name: tail[0] };
    return tail.length > 1 ? { ambiguous: true } : { unknown: true };
  };
  // A name in a ref to lines from..to: a carried file first (lookup); else the name of
  // an attachment (as its marker shows it) inside the carried files, since models take
  // "--- attachment: x.docx ---" for a file header. One file with such an attachment
  // holding the lines → { name: that file, attachment: true }; the lines outside it →
  // { outside: reason }; such attachments in several files → { ambiguous: true }.
  const lookupAt = (name, from, to = from) => {
    const r = lookup(name);
    if (!r.unknown || !name) return r;
    const written = name.trim();
    const hits = [];
    for (const file of sets.keys()) {
      const att = (places.get(file) ?? []).filter((s) => s.kind === 'attachment' && nameText(s.label) === written);
      if (att.length) hits.push({ file, att });
    }
    if (hits.length === 0) return r;
    if (hits.length > 1) return { ambiguous: true };
    const { file, att } = hits[0];
    if (att.some((s) => s.start <= from && to <= s.end)) return { name: file, attachment: true };
    const n = att.some((s) => s.start <= from && from <= s.end) ? to : from;
    return { outside: `L${n} is not inside attachment ${written}` };
  };
  return {
    singleName,
    names,
    lookup,
    lookupAt,
    resolve(name) {
      return lookup(name).name ?? null;
    },
    // Why a written name did not resolve (`r`: what lookupAt gave), for reports.
    nameProblem(name, unknownText, r = lookup(name)) {
      if (r.ambiguous) return `ambiguous file name in ref: ${name}`;
      return r.outside ?? unknownText;
    },
    has(name, n) {
      return sets.get(name)?.has(n) ?? false;
    },
    text(name, n) {
      return sources.get(name)?.get(n - 1);
    },
    page(name, n) {
      return pageOf(pages.get(name), n);
    },
    // The sections give the place; without them a page table still gives "p.N".
    place(name, n) {
      const place = placeOf(places.get(name), n);
      if (place !== null) return place;
      const page = pageOf(pages.get(name), n);
      return page === null ? null : `p.${page}`;
    },
    // First carried line whose whitespace-folded text contains `folded` ("name:L12"), or null.
    find(folded) {
      if (!folded) return null;
      for (const [name, set] of sets) {
        for (const n of set) if (foldSpace(sources.get(name)?.get(n - 1) ?? '').includes(folded)) return `${name}:L${n}`;
      }
      return null;
    },
  };
}

// ---- extract ----

// "L12|", or "L12 (p.3)|" / "L12 (slide 2)|" as the server writes lines with a place
// into an extract result; any place in parentheses is read and ignored.
const QUOTE_TAIL = new RegExp(`^L(\\d+)${PLACE_IN_PREFIX}\\|\\s?(.*)$`);
const UNKNOWN_NAME_LINE = new RegExp(`^(.+?):L(\\d+)${PLACE_IN_PREFIX}\\|\\s?(.*)$`);
const LINE_PREFIX = new RegExp(`^L(\\d+)${PLACE_IN_PREFIX}\\|`);

// The model's line with the derived place in its prefix, "name:L12 (p.3)| text", or
// none ("L12| text"); a place the model wrote is replaced. `shown` (a string, or null
// for no name) replaces the name the model wrote; undefined keeps it. The text after
// "|" is not touched.
function withPlace(raw, q, place, shown) {
  const lead = /^\s*/.exec(raw)[0];
  const s = raw.slice(lead.length);
  const at = q.name ? q.name.length + 1 : 0;
  const head = shown === undefined ? s.slice(0, at) : shown === null ? '' : `${shown}:`;
  return lead + head + s.slice(at).replace(LINE_PREFIX, place === null ? `L${q.n}|` : `L${q.n} (${place})|`);
}

// "name:L12| text" / "L12| text". The name is matched against the files this chunk
// carried, longest first; an unmatched "something:L12|" keeps its name for the report.
export function parseQuoteLine(raw, names) {
  const s = raw.replace(/^\s+/, '');
  for (const n of names) {
    if (s.startsWith(`${n}:L`)) {
      const m = QUOTE_TAIL.exec(s.slice(n.length + 1));
      if (m) return { name: n, n: Number(m[1]), text: m[2] };
    }
  }
  let m = QUOTE_TAIL.exec(s);
  if (m) return { name: null, n: Number(m[1]), text: m[2] };
  m = UNKNOWN_NAME_LINE.exec(s);
  if (m) return { name: m[1], n: Number(m[2]), text: m[3] };
  return null;
}

export function checkExtractChunk(output, view, chunkIndex) {
  const items = [];
  for (const raw of stripFence(output)) {
    if (raw.trim() === '') continue;
    if (NOT_IN_INPUT.test(raw)) {
      items.push({ chunk: chunkIndex, status: 'not_in_input', text: clipText(raw) });
      continue;
    }
    const q = parseQuoteLine(raw, view.names);
    if (!q) {
      items.push({ chunk: chunkIndex, status: 'bad', reason: 'not a quoted input line', text: clipText(raw), raw });
      continue;
    }
    const n = q.n;
    const found = view.lookupAt(q.name, n);
    const name = found.name ?? null;
    // The ref keeps the full header name the written name resolved to; a ref through an
    // attachment name is written as a ref to the file (no name in a single-file job).
    const shown = found.attachment ? (view.singleName ? null : name) : undefined;
    const ref = shown !== undefined ? (shown ? `${shown}:L${n}` : `L${n}`) : q.name ? `${name ?? q.name}:L${n}` : `L${n}`;
    const base = { chunk: chunkIndex, ref, file: name ?? q.name ?? null, line: n, text: clipText(q.text), raw };
    if (!name) {
      items.push({ ...base, status: 'bad', reason: q.name ? view.nameProblem(q.name, 'unknown file name', found) : 'file name missing (several files)' });
      continue;
    }
    if (!view.has(name, n)) {
      items.push({ ...base, status: 'bad', reason: 'line not in this chunk\'s input' });
      continue;
    }
    const page = view.page(name, n);
    const place = view.place(name, n);
    base.raw = withPlace(raw, q, place, shown);
    if (place !== null) Object.assign(base, { ref: `${ref} (${place})`, ...(page !== null ? { page } : {}), place });
    const src = view.text(name, n);
    const said = q.text;
    if (said === src) items.push({ ...base, status: 'ok' });
    else if (collapse(said) === collapse(src)) items.push({ ...base, status: 'ok~' });
    else {
      const e = /(?:…|\.\.\.)\s*$/.exec(said);
      const prefix = e ? collapse(said.slice(0, e.index)) : '';
      if (e && prefix !== '' && collapse(src).startsWith(prefix)) items.push({ ...base, status: 'partial' });
      else items.push({ ...base, status: 'bad', reason: 'text differs from the source line' });
    }
  }
  return items;
}

// ---- refs (draft) ----

const REF_PIECE = /^(?:(.+?):)?L(\d+)(?:\s*[-–]\s*(?:(.+?):)?L?(\d+))?$/;
const SIMPLE_PAREN = /\(([^()\n]{1,400})\)/y;
const NUM = /\d+/y;

// One ref group starting right after "(" at `i`, names matched against `names`
// (longest first). Returns { refs, end } with `end` just past ")", or null.
function parseGroup(line, i, names) {
  const refs = [];
  const skip = () => {
    while (line[i] === ' ' || line[i] === '\t') i++;
  };
  const name = () => {
    for (const n of names) {
      if (line.startsWith(`${n}:L`, i)) {
        i += n.length + 1;
        return n;
      }
    }
    return null;
  };
  const number = () => {
    NUM.lastIndex = i;
    const m = NUM.exec(line);
    if (!m) return null;
    i = NUM.lastIndex;
    return Number(m[0]);
  };
  for (;;) {
    skip();
    const start = i;
    const n1 = name();
    if (line[i] !== 'L') return null;
    i++;
    const from = number();
    if (from === null) return null;
    let to = from;
    let endName = null;
    const save = i;
    skip();
    if (line[i] === '-' || line[i] === '–') {
      i++;
      skip();
      endName = name();
      if (line[i] === 'L') i++;
      const t = number();
      if (t === null) return null;
      to = t;
    } else i = save;
    refs.push({ name: n1, from, to, endName, raw: line.slice(start, i).trim() });
    skip();
    if (line[i] === ')') return { refs, end: i + 1 };
    if (line[i] === ',' || line[i] === ';') {
      i++;
      continue;
    }
    return null;
  }
}

// Ref groups like "(L12)", "(L10-L14)", "(a.md:L5, my notes (old).md:L7–L9)".
// File names are matched against the files the chunk carried, longest first, so
// names with spaces, brackets or "#" parse. Returns { refs: [{ name, from, to,
// endName, raw }], rest } where `rest` is the line without the groups. A group that
// names a file this chunk did not carry is still taken as refs (so it is reported)
// when it has no brackets inside.
export function parseRefs(line, names = []) {
  const refs = [];
  let rest = '';
  let last = 0;
  for (let p = line.indexOf('('); p !== -1; p = line.indexOf('(', p + 1)) {
    if (p < last) continue;
    let g = parseGroup(line, p + 1, names);
    if (!g) {
      SIMPLE_PAREN.lastIndex = p;
      const m = SIMPLE_PAREN.exec(line);
      if (m) {
        const pieces = m[1].split(/[,;]/).map((x) => x.trim()).filter(Boolean);
        const parsed = pieces.map((x) => REF_PIECE.exec(x));
        if (pieces.length && parsed.every(Boolean)) {
          g = {
            refs: parsed.map((x, k) => ({
              name: x[1] ?? null,
              from: Number(x[2]),
              to: x[4] !== undefined ? Number(x[4]) : Number(x[2]),
              endName: x[3] ?? null,
              raw: pieces[k],
            })),
            end: p + m[0].length,
          };
        }
      }
    }
    if (!g) continue;
    refs.push(...g.refs);
    rest += line.slice(last, p);
    last = g.end;
    p = g.end - 1;
  }
  rest += line.slice(last);
  return { refs, rest };
}

// Hard tokens: values a claim must copy from its cited lines.
const TOKEN_RULES = [
  ['backtick', /`([^`\n]{1,200})`/g, 1],
  ['date', /\b\d{4}-\d{2}-\d{2}\b/g, 0],
  ['time', /\b\d{1,2}:\d{2}(?::\d{2})?\b/g, 0],
  ['ipv4', /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g, 0],
  ['ipv6', /(?<![\w:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g, 0],
  ['path', /(?<![\w./-])(?:\/[\w.~+@-]+){2,}\/?|\b[A-Za-z]:\\[^\s"'<>|()]+/g, 0],
  ['host_port', /\b[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?:\d{2,5}\b/g, 0],
  ['version', /\bv?\d+\.\d+(?:\.\d+)*\b/g, 0],
  ['entity', /\b[a-z][a-z0-9_]{1,63}\.[a-z0-9_]{2,127}\b/g, 0],
  ['hostname', /\b(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,63}\b/g, 0],
];

export function hardTokens(text) {
  const taken = [];
  const out = [];
  const overlaps = (a, b) => taken.some(([x, y]) => a < y && b > x);
  for (const [kind, re, group] of TOKEN_RULES) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text)); ) {
      const value = m[group];
      const start = m.index;
      const end = start + m[0].length;
      if (!value || overlaps(start, end)) continue;
      if (kind === 'ipv6' && !(value.includes('::') || (value.match(/:/g) ?? []).length >= 4)) continue;
      if (kind === 'ipv6' && /^\d{1,2}:\d{2}(:\d{2})?$/.test(value)) continue;
      if (MASK_TOKEN.test(value)) continue;
      taken.push([start, end]);
      out.push({ kind, value });
    }
  }
  const numbers = [];
  const re = /\b\d{2,}\b/g;
  for (let m; (m = re.exec(text)); ) {
    if (!overlaps(m.index, m.index + m[0].length)) numbers.push(m[0]);
  }
  return { tokens: out, numbers };
}

function isExemptDraftLine(line) {
  const t = line.trim();
  return t === '' || /^#{1,6}\s/.test(t) || /^```/.test(t) || /^[\s|:-]+$/.test(t) || /^(?:\*\s*){3,}$/.test(t) || NOT_IN_INPUT.test(t);
}

export function checkDraftChunk(output, view, chunkIndex) {
  const items = [];
  const lines = output.replace(/\r/g, '').split('\n');
  lines.forEach((line, i) => {
    if (isExemptDraftLine(line)) {
      if (NOT_IN_INPUT.test(line.trim())) items.push({ chunk: chunkIndex, out_line: i + 1, status: 'not_in_input', text: clipText(line) });
      return;
    }
    const { refs, rest } = parseRefs(line, view.names);
    const issues = [];
    const soft = [];
    let refsOk = 0;
    let refsBad = 0;
    const cited = [];
    const pages = new Set();
    const places = new Set();
    if (refs.length === 0) issues.push('no ref');
    for (const r of refs) {
      const start = view.lookupAt(r.name, r.from, r.endName ? r.from : r.to);
      const end = r.endName ? view.lookupAt(r.endName, r.to) : start;
      const name = start.name ?? null;
      const endName = end.name ?? null;
      const label = r.raw;
      if (!name || endName !== name) {
        refsBad++;
        issues.push(!name ? view.nameProblem(r.name, `ref to an unknown file: ${label}`, start) : view.nameProblem(r.endName, `ref to an unknown file: ${label}`, end));
        continue;
      }
      if (r.to < r.from) {
        refsBad++;
        issues.push(`bad ref range: ${label}`);
        continue;
      }
      if (!view.has(name, r.from) || !view.has(name, r.to)) {
        refsBad++;
        issues.push(`ref outside this chunk's input: ${label}`);
        continue;
      }
      refsOk++;
      if (r.to - r.from + 1 > WIDE_REF) soft.push(`wide ref: ${label}`);
      for (let n = r.from; n <= r.to; n++) if (view.has(name, n)) cited.push(view.text(name, n));
      for (const n of [r.from, r.to]) {
        const p = view.page(name, n);
        if (p !== null) pages.add(p);
        const at = view.place(name, n);
        if (at !== null) places.add(at);
      }
    }
    if (cited.length) {
      const hay = cited.join('\n');
      const hayLower = hay.toLowerCase();
      const { tokens, numbers } = hardTokens(rest);
      for (const t of tokens) if (!hayLower.includes(t.value.toLowerCase())) issues.push(`token not in cited lines: ${t.value}`);
      for (const n of numbers) if (!new RegExp(`(?<!\\d)${n}(?!\\d)`).test(hay)) soft.push(`number not in cited lines: ${n}`);
    }
    const status = issues.length ? 'bad' : soft.length ? 'flag' : 'ok';
    items.push({
      chunk: chunkIndex,
      out_line: i + 1,
      status,
      issues: [...issues, ...soft],
      refs_ok: refsOk,
      refs_bad: refsBad,
      ...(pages.size ? { pages: [...pages].sort((a, b) => a - b) } : {}),
      ...(places.size ? { places: [...places] } : {}),
      text: clipText(line),
    });
  });
  return items;
}

// ---- edits ----

function parseEdits(output) {
  const lines = stripFence(output);
  const whole = lines.join('\n').trim();
  if (whole.startsWith('[')) {
    try {
      const arr = JSON.parse(whole);
      if (Array.isArray(arr)) return arr.map((v) => ({ value: v }));
    } catch {
      // fall through to JSON lines
    }
  }
  const out = [];
  for (const l of lines) {
    const t = l.trim().replace(/,$/, '');
    if (t === '' || t === '[' || t === ']') continue;
    if (NOT_IN_INPUT.test(t)) continue;
    try {
      out.push({ value: JSON.parse(t) });
    } catch {
      out.push({ error: 'not JSON', raw: clipText(l) });
    }
  }
  return out;
}

function lineNumber(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string') {
    const m = /^L?(\d+)$/.exec(v.trim());
    if (m) return Number(m[1]);
  }
  return null;
}

function occurrences(hay, needle) {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

export function checkEditsChunk(output, view, chunkIndex) {
  const valid = [];
  const rejected = [];
  for (const p of parseEdits(output)) {
    if (p.error) {
      rejected.push({ chunk: chunkIndex, reason: p.error, raw: p.raw });
      continue;
    }
    const v = p.value;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      rejected.push({ chunk: chunkIndex, reason: 'not an object', raw: clipText(JSON.stringify(v)) });
      continue;
    }
    const n = lineNumber(v.line);
    const found = view.lookupAt(typeof v.file === 'string' ? v.file : null, n ?? 0);
    const name = found.name ?? null;
    const edit = { chunk: chunkIndex, file: name ?? v.file ?? null, line: n, old: v.old, new: v.new, why: v.why };
    const page = name && n !== null ? view.page(name, n) : null;
    if (page !== null) edit.page = page;
    const place = name && n !== null ? view.place(name, n) : null;
    if (place !== null) edit.place = place;
    const reject = (reason) => rejected.push({ ...edit, reason });
    if (typeof v.old !== 'string' || typeof v.new !== 'string' || v.old === '') reject('"old" and "new" must be strings, "old" non-empty');
    else if (n === null) reject('bad "line"');
    else if (!name) reject(v.file ? view.nameProblem(v.file, 'unknown file name', found) : 'file name missing (several files)');
    else if (!view.has(name, n)) reject('line not in this chunk\'s input');
    else if (MASK_TOKEN.test(v.old) || MASK_TOKEN.test(v.new)) reject('touches a mask: the masked text is not what is on disk');
    else {
      const k = occurrences(view.text(name, n), v.old);
      if (k === 0) reject('"old" is not in the source line');
      else if (k > 1) reject(`"old" occurs ${k} times in the source line`);
      else valid.push(edit);
    }
  }
  return { valid, rejected };
}

// ---- whole job ----

function keyOf(file, line) {
  return `${file}\u0000${line}`;
}

/**
 * Check every chunk's answer and assemble the result text. Overlap duplicates are
 * dropped by (file, line) for extract and edits: a later chunk's line or edit on a
 * (file, line) an earlier chunk already covered is dropped.
 * `outs[i]` may be null for a chunk that did not finish.
 */
export function checkJob({ mode, chunks, outs, sources, pages, places, singleName, spanText }) {
  const views = chunks.map((c) => chunkView(c, sources, singleName, pages, places));
  if (mode === 'extract') {
    const items = [];
    const seen = new Set();
    const textLines = [];
    outs.forEach((o, i) => {
      if (!o) return;
      for (const it of checkExtractChunk(o.text, views[i], i + 1)) {
        if (it.file && it.line && it.status !== 'bad') {
          const k = keyOf(it.file, it.line);
          if (seen.has(k)) continue;
          seen.add(k);
        }
        textLines.push(it.raw ?? it.text);
        items.push(lean({ ...it, result_line: textLines.length, raw: undefined }));
      }
    });
    const c = count(items, ['ok', 'ok~', 'partial', 'bad', 'not_in_input']);
    const quoted = c.ok + c['ok~'] + c.partial + c.bad;
    return {
      mode,
      summary: { ...c, refs_ok: c.ok + c['ok~'] + c.partial, refs_bad: c.bad, pass_rate: quoted ? (c.ok + c['ok~']) / quoted : null },
      items,
      text: textLines.length ? textLines.join('\n') + '\n' : '',
    };
  }
  if (mode === 'draft') {
    const items = [];
    const parts = [];
    let offset = 0;
    const multi = outs.filter(Boolean).length > 1 || chunks.length > 1;
    outs.forEach((o, i) => {
      if (!o) return;
      const body = o.text.replace(/\s+$/, '');
      if (multi) {
        parts.push(`=== chunk ${i + 1} (${spanText(chunks[i].span)}) ===`);
        offset++;
      }
      for (const it of checkDraftChunk(body, views[i], i + 1)) items.push(lean({ ...it, result_line: offset + it.out_line }));
      parts.push(body);
      offset += body === '' ? 1 : body.split('\n').length;
    });
    const c = count(items, ['ok', 'flag', 'bad', 'not_in_input']);
    const content = c.ok + c.flag + c.bad;
    const refsOk = items.reduce((s, it) => s + (it.refs_ok ?? 0), 0);
    const refsBad = items.reduce((s, it) => s + (it.refs_bad ?? 0), 0);
    const flagsPerLine = content ? items.reduce((s, it) => s + (it.issues?.length ?? 0), 0) / content : null;
    return {
      mode,
      summary: { lines: content, ...c, refs_ok: refsOk, refs_bad: refsBad, flags_per_line: flagsPerLine, pass_rate: content ? c.ok / content : null },
      items,
      text: parts.length ? parts.join('\n') + '\n' : '',
    };
  }
  // edits
  const valid = [];
  const rejected = [];
  const seen = new Set();
  outs.forEach((o, i) => {
    if (!o) return;
    const r = checkEditsChunk(o.text, views[i], i + 1);
    const chunkKeys = new Set();
    for (const e of r.valid) {
      const k = keyOf(e.file, e.line);
      if (seen.has(k)) continue;
      chunkKeys.add(k);
      valid.push(e);
    }
    for (const e of r.rejected) {
      if (e.file && e.line && seen.has(keyOf(e.file, e.line))) continue;
      rejected.push(e);
    }
    for (const k of chunkKeys) seen.add(k);
  });
  const lines = [...valid, ...rejected.filter((e) => e.old !== undefined)].map((e) =>
    JSON.stringify({ file: e.file, line: e.line, old: e.old, new: e.new, why: e.why }),
  );
  const total = valid.length + rejected.length;
  return {
    mode,
    summary: { valid: valid.length, rejected: rejected.length, refs_ok: valid.length, refs_bad: rejected.length, pass_rate: total ? valid.length / total : null },
    valid,
    rejected,
    items: [...rejected.map((e) => ({ ...e, status: 'bad' })), ...valid.map((e) => ({ ...e, status: 'ok' }))],
    text: lines.length ? lines.join('\n') + '\n' : '',
  };
}

export const OK_STATUSES = new Set(['ok', 'ok~']);

// An ok item keeps its ref and status only: the line itself is in the result.
function lean(it) {
  if (!OK_STATUSES.has(it.status)) return it;
  const { text, ...rest } = it;
  return rest;
}

function count(items, keys) {
  const c = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const it of items) if (it.status in c) c[it.status]++;
  return c;
}

// " (p.2, 3)" for PDF pages only, " (slide 2, notes 2)" otherwise, "" without places.
function placesText(it) {
  const list = it.places ?? (it.pages ? it.pages.map((p) => `p.${p}`) : []);
  if (!list.length) return '';
  if (it.pages && list.every((p) => /^p\.\d+$/.test(p))) return ` (p.${it.pages.join(', ')})`;
  return ` (${list.join(', ')})`;
}

// One line per bad item, for headers.
export function describeItem(it) {
  if (it.path !== undefined) {
    // schema: field path, ref, status, note
    const where = `${it.path || '(root)'}${it.ref ? ` ${it.ref}` : ''}`;
    return clipText(`${where} [${it.status}] ${it.note ?? it.reason ?? ''}`.trim(), 180);
  }
  if (it.status === 'failed') return clipText(`chunk ${it.chunk} [failed] ${it.reason}`, 180);
  const at = it.place ?? (it.page ? `p.${it.page}` : null);
  const where =
    it.ref ??
    (it.file !== undefined && it.line !== undefined
      ? `${it.file ?? ''}:L${it.line}${at ? ` (${at})` : ''}`
      : `line ${it.result_line ?? it.out_line ?? '?'}${placesText(it)}`);
  const why = it.reason ?? (it.issues ?? []).join('; ');
  return clipText(`${where} [${it.status ?? 'bad'}] ${why}`, 180);
}

export function summaryLine(check) {
  const s = check.summary;
  if (check.mode === 'extract') {
    return `check (extract): refs ok ${s.refs_ok} / bad ${s.refs_bad} — ok ${s.ok}, ok~ ${s['ok~']}, partial ${s.partial}, not-in-input ${s.not_in_input}`;
  }
  if (check.mode === 'draft') {
    return `check (draft): refs ok ${s.refs_ok} / bad ${s.refs_bad} — lines ${s.lines}: ok ${s.ok}, flagged ${s.flag}, bad ${s.bad}, not-in-input ${s.not_in_input}`;
  }
  return `check (edits): refs ok ${s.refs_ok} / bad ${s.refs_bad} — valid ${s.valid}, rejected ${s.rejected} (never applied)`;
}

export function badItems(check) {
  return check.items.filter((it) => it.status === 'bad' || it.status === 'flag');
}
