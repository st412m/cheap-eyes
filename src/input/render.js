// Names, numbered rendering and chunking. Every chunk records which lines it
// carries: the checks validate against that, not against the whole file.
import { InputError } from '../errors.js';
import { pathApi } from '../paths.js';

export const OVERLAP_LINES = 5;

// Token estimate: UTF-8 bytes / 3 (conservative for Cyrillic).
export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

// `<rel>` by default; on a clash the root's last segment is prefixed (`vault/x.md`);
// still equal → the root index (`#2/x.md`). A URL is `host/path` under its own
// pseudo-root (`url/…`, then `#u2/…`).
export function assignNames(files, platform = process.platform) {
  const api = pathApi(platform);
  const lastSeg = (root) => {
    if (root.kind === 'url') return 'url';
    const base = root.kind === 'file' ? api.basename(api.dirname(root.real)) : api.basename(root.real);
    return base || `#${root.index}`;
  };
  const names = files.map((f) => f.rel);
  const clash = (arr, i) => arr.some((n, j) => j !== i && n === arr[i]);
  const step1 = names.map((n, i) => (clash(names, i) ? `${lastSeg(files[i].root)}/${files[i].rel}` : n));
  return step1.map((n, i) => (clash(step1, i) ? `#${files[i].root.index}/${files[i].rel}` : n));
}

export function gapText(from, to) {
  return from === to ? `… (line ${from} skipped)` : `… (lines ${from}–${to} skipped)`;
}

// Render items of one file: numbered lines, gap markers when a filter dropped lines,
// and unnumbered marker lines (`--- page 3 ---`). `masked`: Map 0-based index → masked
// text; `markers`: [{ at, text }] sorted, each placed before the 0-based line `at`.
// Across skipped lines only the last marker is shown (the page of the next line).
export function fileItems({ nums, masked, total, filtered, markers = [] }) {
  const items = [];
  let prev = 0;
  let mi = 0;
  for (const n of nums) {
    if (filtered && n > prev + 1) items.push({ kind: 'gap', text: gapText(prev + 1, n - 1) });
    const here = [];
    for (; mi < markers.length && markers[mi].at + 1 <= n; mi++) if (markers[mi].at + 1 > prev) here.push(markers[mi]);
    for (const m of n === prev + 1 ? here : here.slice(-1)) items.push({ kind: 'marker', text: m.text });
    items.push({ kind: 'line', n, text: `L${n}| ${masked.get(n - 1)}` });
    prev = n;
  }
  if (filtered && nums.length && prev < total) items.push({ kind: 'gap', text: gapText(prev + 1, total) });
  return items;
}

export function fileHeader(name) {
  return `=== file: ${name} ===`;
}

function toRanges(nums) {
  const out = [];
  for (const n of nums) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

/**
 * Split `blocks` ([{ name, items }]) into chunks of at most `budget` estimated tokens.
 * Never splits a line or a file header; a break inside a file repeats its header and
 * the last `overlap` lines. Returns [{ text, tokens, lines: { name: [[a, b], …] }, span }].
 */
export function chunkBlocks(blocks, { budget, multi, overlap = OVERLAP_LINES }) {
  const chunks = [];
  let cur = null;
  const open = () => {
    cur = { parts: [], tokens: 0, lines: new Map(), first: null, last: null, entries: [] };
  };
  // `name` undefined: a file header (derived again when a chunk is split).
  const push = (text, name, n, kind = n === undefined ? 'marker' : 'line') => {
    cur.parts.push(text);
    if (name !== undefined) cur.entries.push({ name, kind, n, text });
    cur.tokens += estimateTokens(text + '\n');
    if (n !== undefined) {
      if (!cur.lines.has(name)) cur.lines.set(name, []);
      cur.lines.get(name).push(n);
      cur.first ??= { name, n };
      cur.last = { name, n };
    }
  };
  const close = () => {
    if (cur && cur.first) {
      chunks.push({
        text: cur.parts.join('\n'),
        tokens: cur.tokens,
        lines: Object.fromEntries([...cur.lines].map(([k, v]) => [k, toRanges(v)])),
        span: { from: cur.first, to: cur.last },
        entries: cur.entries,
      });
    }
    open();
  };
  open();

  for (const { name, items } of blocks) {
    const header = multi ? fileHeader(name) : null;
    const headerCost = header ? estimateTokens(header + '\n') : 0;
    let headerDone = false;
    const emitted = []; // line items of this file already placed, for overlap
    const marks = []; // { item, before: index into emitted } of this file's marker lines

    for (const item of items) {
      const cost = estimateTokens(item.text + '\n');
      if (headerCost + cost > budget) {
        const where = item.kind === 'line' ? `${name}:L${item.n}` : name;
        throw new InputError(`a single line does not fit one chunk: ${where} (~${cost} tokens > budget ~${budget})`);
      }
      const need = (headerDone ? 0 : headerCost) + cost;
      if (cur.first && cur.tokens + need > budget) {
        const inFile = cur.lines.has(name);
        close();
        headerDone = false;
        if (inFile && item.kind === 'line') {
          let carry = emitted.slice(-overlap);
          const tok = (it) => (it ? estimateTokens(it.text + '\n') : 0);
          // The marker in force for the first carried line (its page), and a marker
          // that sat right before this line at the end of the previous chunk.
          const markerFor = (k) => (k ? (marks.filter((m) => m.before <= emitted.length - k).at(-1)?.item ?? null) : null);
          const last = marks.at(-1);
          let own = last && last.before === emitted.length ? last.item : null;
          if (own && headerCost + cost + tok(own) > budget) own = null;
          const weight = (k) => carry.reduce((s, c) => s + tok(c), 0) + tok(markerFor(k)) + tok(own);
          while (carry.length && headerCost + cost + weight(carry.length) > budget) carry = carry.slice(1);
          if (header) push(header);
          headerDone = true;
          const mk = markerFor(carry.length);
          if (mk) push(mk.text, name);
          for (const c of carry) push(c.text, name, c.n);
          if (own) push(own.text, name);
        }
      }
      if (!headerDone && header) {
        push(header);
        headerDone = true;
      }
      if (item.kind === 'line') {
        push(item.text, name, item.n);
        emitted.push(item);
      } else {
        if (item.kind === 'marker') marks.push({ item, before: emitted.length });
        push(item.text, name, undefined, item.kind);
      }
    }
  }
  close();
  return chunks;
}

// A chunk from entries ([{ name, kind, n, text }]); with `multi` a file header opens
// every run of one file, as in chunkBlocks.
export function buildChunk(entries, multi) {
  const parts = [];
  let tokens = 0;
  const lines = new Map();
  let first = null;
  let last = null;
  let prev = null;
  const add = (text) => {
    parts.push(text);
    tokens += estimateTokens(text + '\n');
  };
  for (const e of entries) {
    if (multi && e.name !== prev) add(fileHeader(e.name));
    prev = e.name;
    add(e.text);
    if (e.kind === 'line') {
      if (!lines.has(e.name)) lines.set(e.name, []);
      lines.get(e.name).push(e.n);
      first ??= { name: e.name, n: e.n };
      last = { name: e.name, n: e.n };
    }
  }
  return { text: parts.join('\n'), tokens, lines: Object.fromEntries([...lines].map(([k, v]) => [k, toRanges(v)])), span: { from: first, to: last }, entries };
}

/**
 * Split a chunk in two by lines (a truncated answer is retried on halves). The second
 * half repeats the last `overlap` lines of its file before it, after the marker in
 * force for them. Returns [a, b], or null when the chunk has fewer than two lines.
 */
export function splitChunk(chunk, { multi, overlap = OVERLAP_LINES }) {
  const entries = chunk.entries;
  const lineAt = entries.map((e, i) => (e.kind === 'line' ? i : -1)).filter((i) => i >= 0);
  if (lineAt.length < 2) return null;
  let cut = lineAt[Math.floor(lineAt.length / 2)];
  // Markers and gap lines right before the cut belong to the second half.
  while (cut > 0 && entries[cut - 1].kind !== 'line') cut--;
  const head = entries.slice(0, cut);
  const name = entries[cut].name;
  const own = head.map((e, i) => ({ e, i })).filter(({ e }) => e.name === name && e.kind === 'line');
  const carry = own.slice(-overlap);
  const from = carry.length ? carry[0].i : cut;
  const marker = head.slice(0, from).filter((e) => e.name === name && e.kind === 'marker').at(-1);
  const carried = carry.length ? head.slice(from).filter((e) => e.name === name) : [];
  const tail = [...(carry.length && marker ? [marker] : []), ...carried, ...entries.slice(cut)];
  return [buildChunk(head, multi), buildChunk(tail, multi)];
}
