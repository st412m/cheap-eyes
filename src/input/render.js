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

// The chain of a line: the markers of the doclines sections that contain it, outermost
// first (`--- attachment: spec.pdf ---`, `--- page 4 ---`). Needs marker i to open
// section i (doclines pairs them one to one); otherwise null and callers show only the
// last marker, as before. Returns chainOf(n) for 1-based n called in ascending order;
// lines inside the same sections share one array.
export function chainSweep(markers, sections) {
  if (!sections.length || markers.length !== sections.length) return null;
  if (sections.some((s, i) => markers[i].at !== s.start - 1)) return null;
  let si = 0;
  const stack = []; // open sections: { end, ref, text }
  let chain = [];
  return (n) => {
    let changed = false;
    while (stack.length && stack.at(-1).end < n) {
      stack.pop();
      changed = true;
    }
    for (; si < sections.length && sections[si].start <= n; si++) {
      if (sections[si].end < n) continue;
      stack.push({ end: sections[si].end, ref: si, text: markers[si].text });
      changed = true;
    }
    if (changed) chain = stack.map(({ ref, text }) => ({ ref, text }));
    return chain;
  };
}

// Render items of one file: numbered lines, gap markers when a filter dropped lines,
// and unnumbered marker lines (`--- page 3 ---`). `masked`: Map 0-based index → masked
// text; `markers`: [{ at, text }] sorted, each placed before the 0-based line `at`;
// `sections`: doclines sections. After skipped lines the line's whole chain is shown;
// without a chain (no sections, or they do not pair with the markers) only the last
// marker. Marker items carry `ref` (marker index); line items carry `chain` or null.
export function fileItems({ nums, masked, total, filtered, markers = [], sections = [] }) {
  const chainOf = chainSweep(markers, sections);
  const items = [];
  let prev = 0;
  let mi = 0;
  for (const n of nums) {
    if (filtered && n > prev + 1) items.push({ kind: 'gap', text: gapText(prev + 1, n - 1) });
    const here = [];
    for (; mi < markers.length && markers[mi].at + 1 <= n; mi++) if (markers[mi].at + 1 > prev) here.push({ ref: mi, text: markers[mi].text });
    const chain = chainOf ? chainOf(n) : null;
    const shown = n === prev + 1 ? here : chain?.length ? chain : here.slice(-1);
    for (const m of shown) items.push({ kind: 'marker', text: m.text, ref: m.ref });
    items.push({ kind: 'line', n, text: `L${n}| ${masked.get(n - 1)}`, chain });
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
 * Never splits a line or a file header; a break inside a file repeats its header, the
 * chain of the chunk's first line and the last `overlap` lines. Returns
 * [{ text, tokens, lines: { name: [[a, b], …] }, span, entries }].
 */
export function chunkBlocks(blocks, { budget, multi, overlap = OVERLAP_LINES }) {
  const chunks = [];
  let cur = null;
  const tok = (it) => (it ? estimateTokens(it.text + '\n') : 0);
  const open = () => {
    cur = { parts: [], tokens: 0, lines: new Map(), first: null, last: null, entries: [] };
  };
  // `name` undefined: a file header (derived again when a chunk is split).
  const push = (it, name) => {
    cur.parts.push(it.text);
    if (name !== undefined) cur.entries.push({ name, kind: it.kind, n: it.n, text: it.text, ref: it.ref, chain: it.chain });
    cur.tokens += tok(it);
    if (it.kind === 'line') {
      if (!cur.lines.has(name)) cur.lines.set(name, []);
      cur.lines.get(name).push(it.n);
      cur.first ??= { name, n: it.n };
      cur.last = { name, n: it.n };
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
    const header = multi ? { kind: 'header', text: fileHeader(name) } : null;
    const headerCost = tok(header);
    let headerDone = false;
    const emitted = []; // line items of this file already placed, for overlap
    const marks = []; // { item, before: index into emitted } of this file's marker lines
    // Refs of the chain repeated at the top of this chunk: the same markers from the
    // item stream are dropped until the chunk's first line of this file.
    let repeated = null;

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const cost = tok(item);
      if (headerCost + cost > budget) {
        const where = item.kind === 'line' ? `${name}:L${item.n}` : name;
        throw new InputError(`a single line does not fit one chunk: ${where} (~${cost} tokens > budget ~${budget})`);
      }
      const need = (headerDone ? 0 : headerCost) + cost;
      if (cur.first && cur.tokens + need > budget) {
        const inFile = cur.lines.has(name);
        close();
        headerDone = false;
        repeated = null;
        // The line the new chunk starts with: this one, or the first after this marker.
        let next = item.kind === 'line' ? item : null;
        if (item.kind === 'marker') for (let j = idx + 1; j < items.length && !next; j++) if (items[j].kind === 'line') next = items[j];
        if (inFile && item.kind === 'line' && !item.chain) {
          let carry = emitted.slice(-overlap);
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
          if (mk) push(mk, name);
          for (const c of carry) push(c, name);
          if (own) push(own, name);
        } else if (inFile && next?.chain) {
          // The chain of the first shown line, then the carried lines with the markers
          // between them that the chain does not already show.
          const prefix = (k) => {
            const start = emitted.length - k;
            const first = k ? emitted[start] : next;
            const seq = first.chain.map(({ text, ref }) => ({ kind: 'marker', text, ref }));
            if (!k) return seq;
            const inChain = new Set(first.chain.map((m) => m.ref));
            const late = [];
            for (let i = marks.length - 1; i >= 0 && marks[i].before > start; i--) if (!inChain.has(marks[i].item.ref)) late.unshift(marks[i]);
            for (let j = start; j <= emitted.length; j++) {
              for (const m of late) if (m.before === j) seq.push(m.item);
              if (j < emitted.length) seq.push(emitted[j]);
            }
            return seq;
          };
          const weight = (seq) => seq.reduce((s, it) => s + tok(it), 0);
          let k = item.kind === 'line' ? Math.min(overlap, emitted.length) : 0;
          let seq = prefix(k);
          while (k > 0 && headerCost + cost + weight(seq) > budget) seq = prefix(--k);
          while (seq.length && headerCost + cost + weight(seq) > budget) seq = seq.slice(1);
          if (header) push(header);
          headerDone = true;
          for (const it of seq) push(it, name);
          repeated = new Set(seq.filter((it) => it.kind === 'marker').map((it) => it.ref));
        }
      }
      if (!headerDone && header) {
        push(header);
        headerDone = true;
      }
      if (item.kind === 'line') {
        push(item, name);
        emitted.push(item);
        repeated = null;
      } else {
        if (item.kind === 'marker') marks.push({ item, before: emitted.length });
        if (!(item.kind === 'marker' && repeated?.has(item.ref))) push(item, name);
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
 * half opens with the chain of its first line and repeats the last `overlap` lines of
 * its file before the cut; without a chain, the marker in force for those lines.
 * Returns [a, b], or null when the chunk has fewer than two lines.
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
  const rest = [...carried, ...entries.slice(cut)];
  const first = rest.find((e) => e.kind === 'line' && e.name === name);
  if (!first?.chain) return [buildChunk(head, multi), buildChunk([...(carry.length && marker ? [marker] : []), ...rest], multi)];
  // The chain replaces its own markers that stand before the first line.
  const chain = first.chain.map(({ text, ref }) => ({ name, kind: 'marker', text, ref }));
  const inChain = new Set(first.chain.map((m) => m.ref));
  const at = rest.indexOf(first);
  const kept = rest.filter((e, i) => !(i < at && e.name === name && e.kind === 'marker' && inChain.has(e.ref)));
  return [buildChunk(head, multi), buildChunk([...chain, ...kept], multi)];
}
