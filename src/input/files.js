// files[] → guarded list of real files inside read_roots.
// Literal paths: any problem refuses the job. Glob matches: denied, gitignored,
// binary or oversized files are skipped and reported, never silently.
import fs from 'node:fs/promises';
import ignore from 'ignore';
import { InputError } from '../errors.js';
import { isAbsoluteStrict, isInside, pathApi } from '../paths.js';

const RANGE_RE = /#L(\d+)-L(\d+)$/;
const GLOB_MAGIC = /[*?[\]{}()!]/;
// C0/C1 controls and Unicode line separators: a name carrying them could forge a
// "=== file: … ===" header or a numbered line.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function hasControlChars(s) {
  return CONTROL_RE.test(s);
}

// Any ".." segment, in a path or a glob, is refused before anything touches the disk.
export function hasDotDot(p, platform = process.platform) {
  return p.split(platform === 'win32' ? /[\\/]/ : /\//).includes('..');
}
// Pruned during the walk; both are in the built-in deny list anyway.
const WALK_EXCLUDE = ['**/.git', '**/node_modules'];

export function parseRange(entry) {
  const m = RANGE_RE.exec(entry);
  if (!m) return { path: entry, range: null };
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start < 1 || end < start) throw new InputError(`bad range in ${entry}: expected #L<start>-L<end> with 1 <= start <= end`);
  return { path: entry.slice(0, m.index), range: { start, end } };
}

export function toPosix(rel, platform = process.platform) {
  return platform === 'win32' ? rel.replace(/\\/g, '/') : rel;
}

// Read roots with their realpath; missing roots are kept so that paths under them
// can be refused with a precise message.
export async function resolveRoots(readRoots) {
  const out = [];
  for (const [i, given] of readRoots.entries()) {
    try {
      const real = await fs.realpath(given);
      const st = await fs.stat(real);
      out.push({ index: i + 1, given, real, kind: st.isDirectory() ? 'dir' : 'file' });
    } catch (e) {
      out.push({ index: i + 1, given, real: null, kind: 'missing', error: e.code ?? e.message });
    }
  }
  return out;
}

// Deny globs with gitignore semantics, unanchored: `.env*` and `.git/**` match at any depth.
export function makeDenyMatcher(denyGlobs) {
  const ig = ignore({ ignorecase: true });
  ig.add(denyGlobs.map((g) => (g.startsWith('/') || g.startsWith('**/') ? g : `**/${g}`)));
  return (relPosix) => relPosix !== '' && ig.ignores(relPosix);
}

function lexicalRoot(p, roots, platform) {
  return roots.find((r) => isInside(p, r.given, platform) || (r.real && isInside(p, r.real, platform)));
}

function realRoot(real, roots, platform) {
  return roots.find((r) => r.real && isInside(real, r.real, platform));
}

function relToRoot(real, root, platform) {
  const api = pathApi(platform);
  if (root.kind === 'file') return api.basename(root.real);
  return toPosix(api.relative(root.real, real), platform);
}

// Split an absolute glob into its literal directory prefix and the pattern below it.
export function splitGlob(p, platform = process.platform) {
  const sepRe = platform === 'win32' ? /[\\/]+/ : /\/+/;
  const api = pathApi(platform);
  let head = '';
  let rest = p;
  if (platform === 'win32') {
    const m = /^([A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+[\\/]?)/.exec(p);
    head = m[1];
    rest = p.slice(head.length);
  } else {
    head = '/';
    rest = p.slice(1);
  }
  const segs = rest.split(sepRe).filter(Boolean);
  const i = segs.findIndex((s) => GLOB_MAGIC.test(s));
  if (i < 0) return { dir: p, pattern: null };
  return { dir: api.join(head, ...segs.slice(0, i)), pattern: segs.slice(i).join('/') };
}

// Nearest-repo .gitignore rules, cached per directory.
class GitIgnore {
  constructor(platform) {
    this.platform = platform;
    this.api = pathApi(platform);
    this.repoOf = new Map();
    this.rules = new Map();
  }

  async exists(p) {
    try {
      await fs.lstat(p);
      return true;
    } catch {
      return false;
    }
  }

  async repoRoot(dir) {
    if (this.repoOf.has(dir)) return this.repoOf.get(dir);
    let found = null;
    if (await this.exists(this.api.join(dir, '.git'))) found = dir;
    else {
      const parent = this.api.dirname(dir);
      if (parent !== dir) found = await this.repoRoot(parent);
    }
    this.repoOf.set(dir, found);
    return found;
  }

  async rulesFor(dir, isRepoRoot) {
    const key = `${dir}\0${isRepoRoot}`;
    if (this.rules.has(key)) return this.rules.get(key);
    const files = [this.api.join(dir, '.gitignore')];
    if (isRepoRoot) files.push(this.api.join(dir, '.git', 'info', 'exclude'));
    let ig = null;
    for (const f of files) {
      let text;
      try {
        text = await fs.readFile(f, 'utf8');
      } catch {
        continue;
      }
      ig ??= ignore({ ignorecase: this.platform === 'win32' });
      ig.add(text);
    }
    this.rules.set(key, ig);
    return ig;
  }

  // Deeper .gitignore files win over shallower ones, as in git.
  async ignored(file) {
    const dir = this.api.dirname(file);
    const repo = await this.repoRoot(dir);
    if (!repo) return false;
    const chain = [];
    for (let d = dir; ; d = this.api.dirname(d)) {
      chain.unshift(d);
      if (d === repo || this.api.dirname(d) === d) break;
    }
    let state = false;
    for (const d of chain) {
      const ig = await this.rulesFor(d, d === repo);
      if (!ig) continue;
      const r = ig.test(toPosix(this.api.relative(d, file), this.platform));
      if (r.ignored) state = true;
      else if (r.unignored) state = false;
    }
    return state;
  }
}

/**
 * Expand and guard `entries`.
 * Returns { files: [{ real, root, rel, range }], skipped: [{ path, reason }] }.
 * Files carry `rel` (POSIX, relative to their root) and `root` ({ index, real, kind }).
 */
export async function expandFiles(entries, { config, platform = process.platform, roots }) {
  const api = pathApi(platform);
  roots ??= await resolveRoots(config.read_roots);
  const denied = makeDenyMatcher(config.deny_globs);
  const gi = new GitIgnore(platform);
  const files = [];
  const skipped = [];
  const seen = new Set();
  const key = (p) => (platform === 'win32' ? p.toLowerCase() : p);

  const add = (f) => {
    if (seen.has(key(f.real))) return;
    seen.add(key(f.real));
    files.push(f);
    if (files.length > config.max_files) {
      throw new InputError(`too many files: more than max_files ${config.max_files} (stopped at ${f.real})`);
    }
  };

  const guardRoot = (p) => {
    const root = lexicalRoot(p, roots, platform);
    if (!root) throw new InputError(`outside read roots: ${p}`);
    if (root.kind === 'missing') throw new InputError(`read root missing: ${root.given} (${root.error}); refused: ${p}`);
    return root;
  };

  for (const raw of entries) {
    if (hasControlChars(raw)) throw new InputError(`control characters in a path are refused: ${JSON.stringify(raw)}`);
    const { path: p, range } = parseRange(raw);
    if (hasDotDot(p, platform)) throw new InputError(`".." segments are refused: ${p}`);
    if (range && entries.length > 1) throw new InputError(`a line range is allowed only with a single file: ${raw}`);
    if (!isAbsoluteStrict(p, platform)) throw new InputError(`relative path refused: ${p} (use an absolute path or a glob inside a read root)`);
    guardRoot(p);

    let st = null;
    try {
      st = await fs.stat(p);
    } catch {
      st = null;
    }

    if (st) {
      if (st.isDirectory()) throw new InputError(`is a directory: ${p} (use a glob such as ${api.join(p, '**', '*.md')})`);
      const real = await fs.realpath(p);
      const root = realRoot(real, roots, platform);
      if (!root) throw new InputError(`resolves outside read roots: ${p}`);
      const rel = relToRoot(real, root, platform);
      if (hasControlChars(rel)) throw new InputError(`control characters in a file name are refused: ${JSON.stringify(p)}`);
      if (denied(rel)) throw new InputError(`denied by deny_globs: ${p}`);
      const lexRoot = lexicalRoot(p, roots, platform);
      const givenRel = lexRoot.kind === 'dir' && isInside(p, lexRoot.given, platform) ? toPosix(api.relative(lexRoot.given, p), platform) : '';
      if (denied(givenRel)) throw new InputError(`denied by deny_globs: ${p}`);
      add({ real, root, rel, range, literal: true, given: p });
      continue;
    }

    const { dir, pattern } = splitGlob(p, platform);
    if (pattern === null) throw new InputError(`file not found: ${p}`);
    if (range) throw new InputError(`a line range is not allowed on a glob: ${raw}`);
    const lexRoot = guardRoot(dir);
    if (lexRoot.kind !== 'dir') throw new InputError(`glob must start inside a read root directory: ${p}`);
    let cwd;
    try {
      cwd = await fs.realpath(dir);
    } catch (e) {
      throw new InputError(`glob base not found: ${dir} (${e.code ?? e.message})`);
    }
    if (!realRoot(cwd, roots, platform)) throw new InputError(`glob base resolves outside read roots: ${dir}`);

    let matched = 0;
    const skippedBefore = skipped.length;
    for await (const hit of fs.glob(pattern, { cwd, exclude: WALK_EXCLUDE })) {
      if (hasControlChars(hit)) {
        skipped.push({ path: JSON.stringify(api.join(cwd, hit)), reason: 'control characters in name' });
        continue;
      }
      const full = api.join(cwd, hit);
      let fst;
      try {
        fst = await fs.stat(full);
      } catch {
        continue;
      }
      if (!fst.isFile()) continue;
      const real = await fs.realpath(full);
      const root = realRoot(real, roots, platform);
      if (!root) throw new InputError(`resolves outside read roots: ${full}`);
      const rel = relToRoot(real, root, platform);
      if (hasControlChars(rel)) {
        skipped.push({ path: JSON.stringify(full), reason: 'control characters in name' });
        continue;
      }
      if (denied(rel) || denied(toPosix(api.relative(cwd, full), platform))) {
        skipped.push({ path: full, reason: 'deny_globs' });
        continue;
      }
      if (await gi.ignored(full)) {
        skipped.push({ path: full, reason: 'gitignore' });
        continue;
      }
      matched++;
      add({ real, root, rel, range: null, literal: false, given: full });
    }
    if (matched === 0) {
      const n = skipped.length - skippedBefore;
      throw new InputError(`no files match: ${p}${n ? ` (${n} skipped by deny_globs/.gitignore)` : ''}`);
    }
  }
  return { files, skipped };
}
