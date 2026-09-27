// Secret masking. Always on; applied to file content and to `task` before anything
// leaves the machine. Works per line so line numbers never shift; multi-line secrets
// (PEM blocks, YAML block scalars under a secret key) are found on the whole text first.
// Existing masks (`[token]`, `<SECRET>` …) stay.
//
// Every built-in rule is linear in the line length: each has a literal anchor, a
// bounded quantifier or a lookbehind that allows one start per run of characters.
// A 2 MB single-line file must not stall the event loop (see test/mask-perf.test.js).

const MASK_WORD = String.raw`(?:\[[a-z_]+\]|<[A-Z][A-Z_]*>)`;
const IS_MASK = new RegExp(`^${MASK_WORD}$`);
const KV_SKIP_VALUE = /^(?:|null|true|false|none|~|[|>][0-9+-]{0,2}|!secret(?:\s.*)?|\$\{.*\}|\{\{.*\}\})$/i;
const KEY_CHARS = 'A-Za-z0-9_.-';
const MAX_KEY = 64;

// ---- secret key names, compared by segments ----

const SECRET_SEGMENTS = new Set(['password', 'passwd', 'pwd', 'secret', 'token']);
// A `key` segment is secret when the same key name also has one of these, anywhere.
const KEY_QUALIFIERS = new Set(['api', 'access', 'private', 'secret', 'client', 'auth']);
const SECRET_JOINED = new Set(['apikey', 'clientsecret', 'privatekey', 'accesskey']);
// Shell working directories, not passwords.
const NOT_SECRET_KEYS = new Set(['PWD', 'OLDPWD']);

// `accessToken` → access, token; `APIKey` → api, key; `db_password2` → db, password, 2.
export function keySegments(key) {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

export function isSecretKey(key) {
  if (NOT_SECRET_KEYS.has(key)) return false;
  const segs = keySegments(key);
  if (segs.some((s) => SECRET_SEGMENTS.has(s) || SECRET_JOINED.has(s))) return true;
  return segs.includes('key') && segs.some((s) => KEY_QUALIFIERS.has(s));
}

// ---- single-line rules ----

// [name, regex, replacer]. Order matters: specific token shapes first, generic shapes last.
const RULES = [
  [
    'auth_header',
    /(["']?Authorization["']?[ \t]*[:=][ \t]*["']?)([^"'\r\n]+)/gi,
    (m, head, value) => (IS_MASK.test(value.trim()) ? m : `${head}[token]`),
  ],
  ['bearer', /\b(Bearer[ \t]+)([A-Za-z0-9._~+/=-]{8,})/g, (m, head) => `${head}[token]`],
  ['url_userinfo', /\b(ss:\/\/)([A-Za-z0-9+/=_-]+)@/gi, (m, scheme, info) => (IS_MASK.test(info) ? m : `${scheme}[token]@`)],
  // Scheme length is bounded: an unbounded scheme is quadratic on `a.a.a.…`.
  [
    'url_userinfo',
    /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/@?#[\]]+)@/gi,
    (m, scheme, info) => (IS_MASK.test(info) ? m : `${scheme}[token]@`),
  ],
  ['url_query', /([?&]pbk=)([^&#\s"']+)/gi, (m, head, v) => (IS_MASK.test(v) ? m : `${head}[key]`)],
  ['url_query', /([?&]sid=)([^&#\s"']+)/gi, (m, head, v) => (IS_MASK.test(v) ? m : `${head}[id]`)],
  ['jwt', /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, () => '[token]'],
  ['sk_key', /\bsk-[A-Za-z0-9_-]{16,}/g, () => '[key]'],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, () => '[token]'],
  ['telegram_bot_token', /(?<![A-Za-z0-9_-])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, () => '[token]'],
  // Any `key: value` / `key=value` whose key starts on a boundary and is at most 64
  // chars; the replacer decides by the key's segments.
  [
    'kv_secret',
    new RegExp(
      String.raw`(?<![${KEY_CHARS}])(["']?)([${KEY_CHARS}]{1,${MAX_KEY}})\1([ \t]*[:=][ \t]*)` +
        String.raw`(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"',;{}#][^\s,;{}]*(?:[ \t]+[^\s,;{}#][^\s,;{}]*)*))`,
      'g',
    ),
    (m, q, key, sep, dq, sq, bare) => {
      if (!isSecretKey(key)) return m;
      const value = dq ?? sq ?? bare ?? '';
      if (KV_SKIP_VALUE.test(value.trim()) || IS_MASK.test(value.trim())) return m;
      const wrap = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
      return `${q}${key}${q}${sep}${wrap}[token]${wrap}`;
    },
  ],
  ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, () => '[uuid]'],
  // 43-char base64/base64url (WireGuard, Reality keys), optional `=`; needs upper,
  // lower and digit. A 43-char path without dots may be masked too: that is the
  // price of never letting a key through. `=` is not in the lookbehind: `Key=<key>`.
  [
    'base64_43',
    /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]{0,42}[0-9])(?=[A-Za-z0-9+/_-]{0,42}[a-z])(?=[A-Za-z0-9+/_-]{0,42}[A-Z])[A-Za-z0-9+/_-]{43}=?(?![A-Za-z0-9+/_=-])/g,
    () => '[key]',
  ],
  // Exactly 32 hex, bounded: 40-char SHAs and short hashes survive.
  ['hex32', /(?<![A-Za-z0-9])[0-9a-fA-F]{32}(?![A-Za-z0-9])/g, () => '[id]'],
  // Mixed-case alphanumerics 28–40 long with a digit.
  [
    'mixed_alnum',
    /(?<![A-Za-z0-9])(?=[A-Za-z0-9]{0,39}[0-9])(?=[A-Za-z0-9]{0,39}[a-z])(?=[A-Za-z0-9]{0,39}[A-Z])[A-Za-z0-9]{28,40}(?![A-Za-z0-9])/g,
    () => '[token]',
  ],
];

export const RULE_NAMES = [...new Set(RULES.map((r) => r[0]))];

// ---- multi-line secrets ----

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{1,64}-----/;
const PEM_END = /-----END [A-Z0-9 ]{1,64}-----/;
// `password: |`, `- api_key: >-`, `"token": |2` …
const YAML_BLOCK_KEY = new RegExp(
  String.raw`^([ \t]*(?:-[ \t]+)?)(["']?)([${KEY_CHARS}]{1,${MAX_KEY}})\2[ \t]*:[ \t]*[|>][0-9+-]{0,2}[ \t]*(?:#.*)?$`,
);

function indentOf(line) {
  return /^[ \t]*/.exec(line)[0].length;
}

// Line index (0-based) → { kind: 'pem' | 'yaml', block }. For PEM the BEGIN/END lines
// stay; for YAML the key line stays and the indented body below it is masked.
export function multilineSecrets(lines) {
  const map = new Map();
  let block = 0;
  for (let i = 0; i < lines.length; i++) {
    if (PEM_BEGIN.test(lines[i])) {
      block++;
      let j = i + 1;
      for (; j < lines.length && !PEM_END.test(lines[j]); j++) map.set(j, { kind: 'pem', block });
      i = j;
      continue;
    }
    const y = YAML_BLOCK_KEY.exec(lines[i]);
    if (y && isSecretKey(y[3])) {
      block++;
      const keyIndent = y[1].length;
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].trim() === '') continue;
        if (indentOf(lines[j]) <= keyIndent) break;
        map.set(j, { kind: 'yaml', block });
      }
      i = j - 1;
    }
  }
  return map;
}

export function compileExtra(patterns = []) {
  return patterns.map((p, i) => [`extra_${i + 1}`, new RegExp(p, 'g'), () => '[token]']);
}

function maskLine(line, rules, counts) {
  let out = line;
  for (const [name, re, fn] of rules) {
    re.lastIndex = 0;
    out = out.replace(re, (...args) => {
      const r = fn(...args);
      if (r !== args[0]) counts[name] = (counts[name] ?? 0) + 1;
      return r;
    });
  }
  return out;
}

export class Masker {
  constructor(extraPatterns = []) {
    this.rules = [...RULES, ...compileExtra(extraPatterns)];
    this.counts = {};
  }

  // `lines`: the whole file; `indices`: 0-based lines to mask (default all).
  // Returns Map index → { text, hits, block } without counting anything yet.
  maskEach(lines, indices) {
    const multi = multilineSecrets(lines);
    const want = indices ?? lines.keys();
    const out = new Map();
    for (const i of want) {
      const hit = multi.get(i);
      if (hit) {
        const line = lines[i];
        const indent = hit.kind === 'yaml' ? /^[ \t]*/.exec(line)[0] : '';
        const replacement = hit.kind === 'pem' ? '[key]' : `${indent}[token]`;
        const masked = !IS_MASK.test(line.trim());
        out.set(i, { text: masked ? replacement : line, hits: null, block: masked ? `${hit.kind}:${hit.block}` : null });
      } else {
        const hits = {};
        out.set(i, { text: maskLine(lines[i], this.rules, hits), hits, block: null });
      }
    }
    return out;
  }

  // Add the masks of these entries (from maskEach) to this.counts; a multi-line
  // block counts once however many of its lines are included.
  tally(entries) {
    const blocks = new Set();
    for (const e of entries) {
      if (e.block) blocks.add(e.block);
      else for (const [k, v] of Object.entries(e.hits)) this.counts[k] = (this.counts[k] ?? 0) + v;
    }
    for (const b of blocks) {
      const name = b.startsWith('pem:') ? 'pem' : 'kv_secret';
      this.counts[name] = (this.counts[name] ?? 0) + 1;
    }
  }

  // Map index → masked text, counted.
  maskLines(lines, indices) {
    const entries = this.maskEach(lines, indices);
    this.tally(entries.values());
    return new Map([...entries].map(([i, e]) => [i, e.text]));
  }

  maskText(text) {
    const lines = text.split('\n');
    const m = this.maskLines(lines);
    return lines.map((_, i) => m.get(i)).join('\n');
  }
}
