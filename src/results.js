// Results store: <state_dir>/results/<id>.md + <id>.check.json, ids UTC-stamped.
// Results are files, so ids survive restarts; only running-job state lives in memory
// (module level, shared by every server instance). A job whose .check.json still says
// "running" but is not in this process is reported as "interrupted".
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RESULT_ID_RE } from './tools.js';

const ID_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})-/;
const FILE_RE = /^(\d{4}-\d{2}-\d{2}_\d{6}-(?:extract|draft|edits|grep|schema)-[0-9a-f]{6})\.(md|check\.json|sources)$/;
const TMP_RE = /\.tmp-[0-9a-f]{8}$/;

// id → { controller, promise, progress: { done, total } }
export const running = new Map();

export function newResultId(mode, now = new Date()) {
  const iso = now.toISOString(); // 2026-09-26T12:57:03.123Z
  const stamp = `${iso.slice(0, 10)}_${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  const id = `${stamp}-${mode}-${randomBytes(3).toString('hex')}`;
  if (!RESULT_ID_RE.test(id)) throw new Error(`bad result id generated: ${id}`);
  return id;
}

export function idTime(id) {
  const m = ID_TIME_RE.exec(id);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

// Only ever called with an id that matched RESULT_ID_RE: never a path.
function paths(resultsDir, id) {
  if (!RESULT_ID_RE.test(id)) throw new Error(`not a result id: ${id}`);
  return { md: path.join(resultsDir, `${id}.md`), check: path.join(resultsDir, `${id}.check.json`) };
}

async function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, text, { flag: 'wx' });
  await fs.rename(tmp, file);
}

// Reserve a new id by creating its .check.json exclusively (O_EXCL).
export async function allocateResult(resultsDir, mode, meta, now = new Date()) {
  await fs.mkdir(resultsDir, { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newResultId(mode, now);
    const body = typeof meta === 'function' ? meta(id) : { ...meta, id };
    try {
      await fs.writeFile(paths(resultsDir, id).check, JSON.stringify(body, null, 2) + '\n', { flag: 'wx' });
      return id;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('could not allocate a result id');
}

export async function writeResultText(resultsDir, id, text) {
  await atomicWrite(paths(resultsDir, id).md, text);
}

export async function writeCheck(resultsDir, id, obj) {
  await atomicWrite(paths(resultsDir, id).check, JSON.stringify(obj, null, 2) + '\n');
}

// One call: allocate, write text and check (used by dry_run).
export async function writeResult(resultsDir, mode, { md, check }, now = new Date()) {
  const id = await allocateResult(resultsDir, mode, { status: 'running' }, now);
  await writeResultText(resultsDir, id, md);
  await writeCheck(resultsDir, id, typeof check === 'function' ? check(id) : check);
  return id;
}

export async function readCheck(resultsDir, id) {
  try {
    return JSON.parse(await fs.readFile(paths(resultsDir, id).check, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function readResultText(resultsDir, id) {
  try {
    return await fs.readFile(paths(resultsDir, id).md, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function statusOf(id, check) {
  if (check?.status === 'running' && !running.has(id)) return 'interrupted';
  return check?.status ?? 'unknown';
}

// Bytes of the regular files directly in a <id>.sources directory (it has no subdirectories).
async function dirBytes(dir) {
  let total = 0;
  for (const name of await fs.readdir(dir).catch(() => [])) {
    const st = await fs.lstat(path.join(dir, name)).catch(() => null);
    if (st?.isFile()) total += st.size;
  }
  return total;
}

/**
 * The store is the server's own cache (sources folders included): drop results older than `retentionDays`, then
 * the oldest ones while the store is above `maxMb`. Running jobs are never touched.
 */
export async function pruneResults(resultsDir, { retentionDays, maxMb, now = Date.now() }) {
  let names;
  try {
    names = await fs.readdir(resultsDir);
  } catch (e) {
    if (e.code === 'ENOENT') return { deleted: [] };
    throw e;
  }
  const byId = new Map();
  for (const name of names) {
    const full = path.join(resultsDir, name);
    if (TMP_RE.test(name)) {
      // A temp file older than an hour is left over from a crash.
      try {
        const st = await fs.lstat(full);
        if (st.isFile() && now - st.mtimeMs > 3600e3) await fs.unlink(full);
      } catch {
        // gone already
      }
      continue;
    }
    const m = FILE_RE.exec(name);
    if (!m) continue;
    let st;
    try {
      st = await fs.lstat(full);
    } catch {
      continue;
    }
    let size;
    if (m[2] === 'sources') {
      if (!st.isDirectory()) continue;
      size = await dirBytes(full);
    } else {
      if (!st.isFile()) continue;
      size = st.size;
    }
    const e = byId.get(m[1]) ?? { id: m[1], time: idTime(m[1]), files: [], bytes: 0 };
    e.files.push(full);
    e.bytes += size;
    byId.set(m[1], e);
  }
  const entries = [...byId.values()].filter((e) => !running.has(e.id)).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  const deleted = [];
  const drop = async (e) => {
    for (const f of e.files) await fs.rm(f, { force: true, recursive: true });
    deleted.push(e.id);
  };
  const cutoff = now - retentionDays * 86400e3;
  const keep = [];
  for (const e of entries) {
    if (e.time !== null && e.time < cutoff) await drop(e);
    else keep.push(e);
  }
  const limit = maxMb * 1024 * 1024;
  let total = [...byId.values()].filter((e) => !deleted.includes(e.id)).reduce((s, e) => s + e.bytes, 0);
  for (const e of keep) {
    if (total <= limit) break;
    await drop(e);
    total -= e.bytes;
  }
  return { deleted };
}
