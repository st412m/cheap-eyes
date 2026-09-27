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
// still equal → the root index (`#2/x.md`).
export function assignNames(files, platform = process.platform) {
  const api = pathApi(platform);
  const lastSeg = (root) => {
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

// Render items of one file: numbered lines, plus gap markers when a filter dropped lines.
// `masked`: Map 0-based index → masked text.
export function fileItems({ nums, masked, total, filtered }) {
  const items = [];
  let prev = 0;
  for (const n of nums) {
    if (filtered && n > prev + 1) items.push({ kind: 'gap', text: gapText(prev + 1, n - 1) });
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
    cur = { parts: [], tokens: 0, lines: new Map(), first: null, last: null };
  };
  const push = (text, name, n) => {
    cur.parts.push(text);
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
          while (carry.length && headerCost + cost + carry.reduce((s, c) => s + estimateTokens(c.text + '\n'), 0) > budget) carry = carry.slice(1);
          if (header) push(header);
          headerDone = true;
          for (const c of carry) push(c.text, name, c.n);
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
        push(item.text);
      }
    }
  }
  close();
  return chunks;
}
