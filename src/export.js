// Optional export of a result (and its .check.json) into write_roots. The server
// writes nowhere else outside state_dir. Every export is recorded in
// <state_dir>/exports.jsonl; only files listed there may be overwritten or deleted.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { InputError } from './errors.js';
import { hasControlChars, hasDotDot } from './input/files.js';
import { isAbsoluteStrict, isInside, pathApi } from './paths.js';

export function manifestPath(stateDir) {
  return path.join(stateDir, 'exports.jsonl');
}

function keyOf(p, platform) {
  return platform === 'win32' ? p.toLowerCase() : p;
}

// All records, and the latest record per path.
export async function readManifest(stateDir, platform = process.platform) {
  let text = '';
  try {
    text = await fs.readFile(manifestPath(stateDir), 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const latest = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.path === 'string') latest.set(keyOf(r.path, platform), r);
    } catch {
      // torn line
    }
  }
  return latest;
}

async function appendManifest(stateDir, record) {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.appendFile(manifestPath(stateDir), JSON.stringify(record) + '\n');
}

async function rewriteManifest(stateDir, records) {
  const file = manifestPath(stateDir);
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), { flag: 'wx' });
  await fs.rename(tmp, file);
}

async function realRoots(writeRoots) {
  const out = [];
  for (const r of writeRoots) {
    try {
      out.push({ given: r, real: await fs.realpath(r) });
    } catch {
      // a missing write root accepts nothing
    }
  }
  return out;
}

// Lexical rules for one target path: absolute, inside a write root, no "..", no
// control characters, and no segment below the root that starts with "." (dotfiles,
// .vault-policy, anything under .vault-trash/).
function lexicalCheck(target, writeRoots, platform) {
  const api = pathApi(platform);
  if (!isAbsoluteStrict(target, platform)) throw new InputError(`export path must be absolute: ${target}`);
  if (hasControlChars(target)) throw new InputError(`control characters in an export path are refused: ${JSON.stringify(target)}`);
  if (hasDotDot(target, platform)) throw new InputError(`".." segments are refused: ${target}`);
  const root = writeRoots.find((r) => isInside(target, r, platform));
  if (!root) throw new InputError(`export path outside write_roots: ${target}`);
  const rel = api.relative(api.resolve(root), api.resolve(target));
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  if (segs.length === 0) throw new InputError(`export path is a write root itself: ${target}`);
  if (segs.some((s) => s.startsWith('.'))) throw new InputError(`export refused: dotfiles and dot-directories (.vault-trash, .vault-policy …) are never written: ${target}`);
  return root;
}

/**
 * Where the export goes: `export_to` (a file path, or an existing directory / a path
 * ending in a separator) or `export_dir`. Returns { md, check } absolute paths.
 * Throws InputError on any lexical problem, before anything is written.
 */
export function exportTargets({ exportTo, exportDir, id, platform = process.platform, isDir = false }) {
  const api = pathApi(platform);
  let md;
  if (exportTo !== undefined && exportTo !== null) {
    if (isDir || /[\\/]$/.test(exportTo)) md = api.join(exportTo, `${id}.md`);
    else md = api.resolve(exportTo);
  } else if (exportDir) md = api.join(exportDir, `${id}.md`);
  else return null;
  const check = /\.md$/i.test(md) ? md.replace(/\.md$/i, '.check.json') : `${md}.check.json`;
  return { md, check };
}

export async function planExport({ config, exportTo, id, platform = process.platform }) {
  if (exportTo !== undefined && config.write_roots.length === 0) throw new InputError('export is off: write_roots is empty');
  let isDir = false;
  if (exportTo !== undefined) {
    if (!isAbsoluteStrict(exportTo, platform)) throw new InputError(`export path must be absolute: ${exportTo}`);
    // Checked on the raw string, before any normalisation could fold ".." away.
    if (hasControlChars(exportTo)) throw new InputError(`control characters in an export path are refused: ${JSON.stringify(exportTo)}`);
    if (hasDotDot(exportTo, platform)) throw new InputError(`".." segments are refused: ${exportTo}`);
    try {
      const st = await fs.lstat(exportTo);
      isDir = st.isDirectory();
    } catch {
      isDir = false;
    }
  }
  const t = exportTargets({ exportTo, exportDir: config.export_dir, id, platform, isDir });
  if (!t) return null;
  for (const p of [t.md, t.check]) lexicalCheck(p, config.write_roots, platform);
  return t;
}

// Create missing parents only below an existing ancestor whose realpath is inside a write root.
async function ensureParent(file, roots, platform) {
  const api = pathApi(platform);
  const parent = api.dirname(file);
  const missing = [];
  let cur = parent;
  for (;;) {
    try {
      await fs.lstat(cur);
      break;
    } catch {
      missing.unshift(api.basename(cur));
      const up = api.dirname(cur);
      if (up === cur) throw new InputError(`export path has no existing parent: ${file}`);
      cur = up;
    }
  }
  const base = await fs.realpath(cur);
  if (!roots.some((r) => isInside(base, r.real, platform))) throw new InputError(`export parent resolves outside write_roots: ${parent}`);
  if (missing.length) await fs.mkdir(api.join(base, ...missing), { recursive: true });
  const realParent = await fs.realpath(parent);
  if (!roots.some((r) => isInside(realParent, r.real, platform))) throw new InputError(`export parent resolves outside write_roots: ${parent}`);
  return api.join(realParent, api.basename(file));
}

/**
 * Write `files` ([{ path, text }]) with every guard; returns the written real paths.
 * All targets are checked before the first byte is written.
 */
export async function writeExport({ config, stateDir, files, overwrite = false, resultId, platform = process.platform, now = Date.now() }) {
  const roots = await realRoots(config.write_roots);
  if (roots.length === 0) throw new InputError('export refused: no write root exists');
  const manifest = await readManifest(stateDir, platform);
  const plan = [];
  for (const f of files) {
    lexicalCheck(f.path, config.write_roots, platform);
    const real = await ensureParent(f.path, roots, platform);
    let st = null;
    try {
      st = await fs.lstat(real);
    } catch {
      st = null;
    }
    if (st?.isSymbolicLink()) throw new InputError(`export refused: target is a symlink: ${f.path}`);
    if (st && !st.isFile()) throw new InputError(`export refused: target exists and is not a file: ${f.path}`);
    if (st && !overwrite) throw new InputError(`export refused: ${f.path} exists (overwrite: true works only for files this server exported)`);
    if (st && !manifest.has(keyOf(real, platform))) throw new InputError(`export refused: ${f.path} exists and was not exported by this server`);
    plan.push({ ...f, real, replace: Boolean(st) });
  }
  const written = [];
  for (const p of plan) {
    if (p.replace) {
      const tmp = `${p.real}.tmp-${randomBytes(4).toString('hex')}`;
      await fs.writeFile(tmp, p.text, { flag: 'wx' });
      await fs.rename(tmp, p.real);
    } else {
      await fs.writeFile(p.real, p.text, { flag: 'wx' });
    }
    const st = await fs.stat(p.real);
    await appendManifest(stateDir, { path: p.real, size: st.size, mtime_ms: st.mtimeMs, ts: new Date(now).toISOString(), result_id: resultId });
    written.push(p.real);
  }
  return written;
}

/**
 * export_retention_days: 0 → never delete. N → delete this server's exports older than
 * N days whose size and mtime still match the manifest; an edited or replaced file is
 * kept and dropped from the manifest. Nothing outside the manifest is ever touched.
 */
export async function pruneExports(stateDir, { retentionDays, now = Date.now(), platform = process.platform }) {
  if (!retentionDays) return { deleted: [], dropped: [] };
  const latest = await readManifest(stateDir, platform);
  if (latest.size === 0) return { deleted: [], dropped: [] };
  const cutoff = now - retentionDays * 86400e3;
  const keep = [];
  const deleted = [];
  const dropped = [];
  for (const r of latest.values()) {
    const t = Date.parse(r.ts);
    if (!(t < cutoff)) {
      keep.push(r);
      continue;
    }
    let st = null;
    try {
      st = await fs.lstat(r.path);
    } catch {
      st = null;
    }
    if (st && st.isFile() && !st.isSymbolicLink() && st.size === r.size && st.mtimeMs === r.mtime_ms) {
      await fs.unlink(r.path);
      deleted.push(r.path);
    } else {
      dropped.push(r.path);
    }
  }
  await rewriteManifest(stateDir, keep);
  return { deleted, dropped };
}
