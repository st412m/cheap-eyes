// Models picked by the server when the settings name none. Candidates come from live
// data only (the ZDR endpoint list and the models the account allows); each one must
// pass the built-in probe; the pick is pinned in <state_dir>/models.json and acts as
// the alias "auto" for every mode. The pin never moves on its own: only when no
// pinned id is usable any more is a new pick made.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InputError } from './errors.js';
import { hasFreeSuffix, refusedSuffix } from './model-ids.js';
import { fmtPrice, screenIds } from './models.js';

export const AUTO = 'auto';
// USD per 1M tokens; applies to picked models when max_price_usd_per_mtok is not set.
export const BUILTIN_CAP = Object.freeze({ in: 1, out: 4 });
export const MIN_CONTEXT = 32000;
// The extract default output cap.
export const MIN_MAX_OUT = 16000;
export const MAX_PROBES = 5;
export const WANT_PASSED = 2;
export const PICK_HINT = 'to pick again: run `cheap-eyes models --pick`';
const CHOOSE_YOURSELF = 'to choose a model yourself: `cheap-eyes models --candidates`, then `cheap-eyes set models.<alias> <id>`';

const PIN_FILE = 'models.json';
// A pick probes up to five models at up to 60 s each; the holder refreshes the lock
// every minute, so a lock untouched for 10 minutes has no live holder.
const LOCK_STALE_MS = 10 * 60e3;
const LOCK_WAIT_MS = 2 * 60e3;
const LOCK_TOUCH_MS = 60e3;
const LOCK_POLL_MS = 250;

export function pinPath(stateDir) {
  return path.join(stateDir, PIN_FILE);
}

// True when the picked models are in use: the settings name no models at all.
export function usesAuto(model, mode, config) {
  if (Object.keys(config.models).length > 0) return false;
  const name = model ?? config.defaults[mode] ?? (mode === 'schema' ? config.defaults.extract : undefined);
  return name === undefined || name === AUTO;
}

export function capFor(config) {
  return config.max_price_usd_per_mtok ?? BUILTIN_CAP;
}

// The settings an auto job runs with: the cap in force for picked models.
export function autoConfig(config) {
  return { ...config, max_price_usd_per_mtok: capFor(config) };
}

export function autoChoice(ids) {
  return { alias: AUTO, label: AUTO, ids, params: { reasoning: { effort: 'none' } } };
}

export function pinDate(pin) {
  return String(pin.picked_at).slice(0, 10);
}

export function capText(cap) {
  return `in ${fmtPrice(cap.in)} / out ${fmtPrice(cap.out)} per 1M`;
}

function validPin(p) {
  return (
    p !== null &&
    typeof p === 'object' &&
    typeof p.picked_at === 'string' &&
    Array.isArray(p.ids) &&
    p.ids.length > 0 &&
    p.ids.every((id) => typeof id === 'string' && id !== '' && !refusedSuffix(id))
  );
}

/** { pin } with pin null when there is no file; { pin: null, error } when it cannot be used. */
export function readPin(stateDir) {
  let text;
  try {
    text = fs.readFileSync(pinPath(stateDir), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { pin: null };
    return { pin: null, error: `cannot read it (${e.code ?? e.message})` };
  }
  let p;
  try {
    p = JSON.parse(text);
  } catch {
    return { pin: null, error: 'not valid JSON' };
  }
  if (!validPin(p)) return { pin: null, error: 'picked_at and ids are missing or wrong' };
  return { pin: p };
}

/**
 * Moves a pin file that cannot be used aside under a new name; it is never overwritten
 * or deleted. Returns the new path, or null when the file is already gone (another
 * process moved it).
 */
export function setAsidePin(stateDir, now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const base = `${pinPath(stateDir)}.unreadable-${stamp}`;
  for (let n = 0; ; n++) {
    const target = n ? `${base}-${n}` : base;
    if (fs.existsSync(target)) continue;
    try {
      fs.renameSync(pinPath(stateDir), target);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new InputError(`the pin file ${pinPath(stateDir)} cannot be used and cannot be moved aside (${e.code ?? e.message}): move or delete it, then try again`);
    }
    return target;
  }
}

export function writePin(stateDir, pin) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = pinPath(stateDir);
  const tmp = path.join(stateDir, `.${PIN_FILE}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(pin, null, 2) + '\n', { flag: 'wx' });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Already gone.
    }
    throw e;
  }
  return file;
}

// The cheapest endpoint of an id within the cap (prompt price first), or null. With
// `paid`, an endpoint charging nothing for prompt and completion does not count: free
// endpoints are rate-limited and come and go.
function cheapestFitting(s, cap, paid) {
  let best = null;
  for (const p of s.prices) {
    if (p.in > cap.in || p.out > cap.out) continue;
    if (paid && p.in === 0 && p.out === 0) continue;
    if (!best || p.in < best.in || (p.in === best.in && p.out < best.out)) best = p;
  }
  return best;
}

function listCandidates(zdr, allowed, cap, { free }) {
  const ids = new Set();
  for (const m of allowed ?? []) {
    if (m?.id) ids.add(m.id);
    if (m?.canonical_slug) ids.add(m.canonical_slug);
  }
  const out = [];
  for (const s of zdr.values()) {
    if (!ids.has(s.id) || refusedSuffix(s.id)) continue;
    if (!free && hasFreeSuffix(s.id)) continue;
    if (s.context === null || s.context < MIN_CONTEXT) continue;
    if (s.maxOut !== null && s.maxOut < MIN_MAX_OUT) continue;
    const best = cheapestFitting(s, cap, !free);
    if (best) out.push({ ...s, fitIn: best.in, fitOut: best.out });
  }
  return out.sort((a, b) => a.fitIn - b.fitIn || a.fitOut - b.fitOut || a.id.localeCompare(b.id));
}

/**
 * Candidates for the pick: ZDR ids that `allowed` lists (the account's models, or the
 * public text models when the account list is unavailable), without a refused suffix
 * and without the `:free` variant, with context ≥ 32 000, max output not given or
 * ≥ 16 000 and a paid endpoint within the cap. Ordered by the prices of that cheapest
 * fitting endpoint (prompt, then completion), then by id. Each carries fitIn / fitOut.
 * Free variants and free endpoints are left out of the pick only: an alias in the
 * settings may name them.
 */
export function pickCandidates(zdr, allowed, cap) {
  return listCandidates(zdr, allowed, cap, { free: false });
}

/**
 * Probe candidates in order until two pass or five were tried. `runProbe(id)` returns
 * { id, ok, reason, cost, ms }. Returns the pin; throws InputError (with `probes` when
 * any ran) when nothing passes.
 */
export async function pickModels({ zdr, allowed, accountKnown, cap, runProbe, now = () => Date.now() }) {
  const note = accountKnown ? '' : '; account availability unknown';
  const cands = pickCandidates(zdr, allowed, cap);
  if (cands.length === 0) {
    const onlyFree = listCandidates(zdr, allowed, cap, { free: true }).length > 0;
    throw new InputError(
      `no model to pick: no ZDR text model${accountKnown ? ' the account allows' : ''} has context ≥ ${MIN_CONTEXT}, max output ≥ ${MIN_MAX_OUT} (or none given) and a paid endpoint within ${capText(cap)}${onlyFree ? '; free variants (:free, or $0 endpoints) match but are not picked: they are rate-limited and come and go' : ''}${note}; ${CHOOSE_YOURSELF}`,
    );
  }
  const probes = [];
  for (const c of cands) {
    if (probes.filter((p) => p.ok).length >= WANT_PASSED || probes.length >= MAX_PROBES) break;
    probes.push(await runProbe(c.id));
  }
  const passed = probes.filter((p) => p.ok);
  if (passed.length === 0) {
    const e = new InputError(`no model passed the probe: ${probes.map((p) => `${p.id}: ${p.reason}`).join('; ')}${note}; ${CHOOSE_YOURSELF}`);
    e.probes = probes;
    throw e;
  }
  return {
    picked_at: new Date(now()).toISOString(),
    ids: passed.slice(0, WANT_PASSED).map((p) => p.id),
    cap: { in: cap.in, out: cap.out },
    probe: probes.map(({ id, ok, reason, cost, ms }) => ({ id, ok, reason, cost, ...(typeof ms === 'number' ? { ms } : {}) })),
  };
}

const inFlight = new Map(); // state dir → the pick running in this process

// True when a process with this pid runs on this machine. EPERM: it runs, owned by
// another user.
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Why a lock held by someone else may be taken over now, or null to keep waiting:
 * its process is gone (recorded on this machine), or it is older than `staleMs`
 * (any machine, or content that cannot be read).
 */
export function lockTakeover(text, ageMs, { staleMs = LOCK_STALE_MS, host = os.hostname(), alive = processAlive } = {}) {
  if (ageMs > staleMs) return `older than ${Math.round(staleMs / 60e3)} minutes`;
  let info = null;
  try {
    info = JSON.parse(text);
  } catch {
    return null;
  }
  if (info && info.host === host && Number.isInteger(info.pid) && !alive(info.pid)) return `process ${info.pid} is gone`;
  return null;
}

/**
 * Run `pickFn` and write its pin, one pick at a time per state dir: in this process
 * through a shared promise, across processes through `models.json.lock`, created
 * exclusively with { pid, host, at }. The holder refreshes its mtime while it picks.
 * A waiter takes the lock over at once when its process is gone (same machine), and
 * when it is older than 10 minutes; after waiting 2 minutes a waiter is refused. A
 * caller that waited finds the pin the other one wrote — any pin whose picked_at
 * differs from `seenPickedAt` (what the caller read before deciding to pick) — and
 * uses it. Returns { pin, picked } where picked is false for a pin written by someone else.
 */
export async function underPickLock(
  stateDir,
  seenPickedAt,
  pickFn,
  { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, alive = processAlive } = {},
) {
  const newer = () => {
    const r = readPin(stateDir);
    return r.pin && r.pin.picked_at !== seenPickedAt ? r.pin : null;
  };
  while (inFlight.has(stateDir)) {
    try {
      await inFlight.get(stateDir);
    } catch {
      // That pick failed; this caller tries its own.
    }
    const pin = newer();
    if (pin) return { pin, picked: false };
  }
  const job = (async () => {
    const lock = `${pinPath(stateDir)}.lock`;
    const started = Date.now();
    fs.mkdirSync(stateDir, { recursive: true });
    const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date(now()).toISOString() }) + '\n';
    for (;;) {
      try {
        fs.writeFileSync(lock, mine, { flag: 'wx' });
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      const pin = newer();
      if (pin) return { pin, picked: false };
      let text;
      let age;
      try {
        text = fs.readFileSync(lock, 'utf8');
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (lockTakeover(text, age, { staleMs, alive })) {
        // Only the lock that was judged: another waiter may have replaced it meanwhile.
        try {
          if (fs.readFileSync(lock, 'utf8') === text) fs.unlinkSync(lock);
        } catch {
          // Another waiter took it over first.
        }
        continue;
      }
      if (Date.now() - started > waitMs) {
        let holder = '';
        try {
          const info = JSON.parse(text);
          holder = ` by process ${info.pid}${info.host ? ` on ${info.host}` : ''} since ${info.at}`;
        } catch {
          // Content not readable: the lock is named without its holder.
        }
        throw new InputError(
          `models are being picked${holder} (lock ${lock}); waited ${Math.round(waitMs / 1000)} s. Try again in a few minutes; if no other cheap-eyes is running, delete the lock file`,
        );
      }
      await sleep(LOCK_POLL_MS);
    }
    const touch = setInterval(() => {
      try {
        const t = new Date();
        fs.utimesSync(lock, t, t);
      } catch {
        // The lock was taken over: the pin written last wins.
      }
    }, LOCK_TOUCH_MS);
    touch.unref();
    try {
      const pin = newer();
      if (pin) return { pin, picked: false };
      const fresh = await pickFn();
      writePin(stateDir, fresh);
      return { pin: fresh, picked: true };
    } finally {
      clearInterval(touch);
      try {
        if (fs.readFileSync(lock, 'utf8') === mine) fs.unlinkSync(lock);
      } catch {
        // Already gone.
      }
    }
  })();
  inFlight.set(stateDir, job);
  try {
    return await job;
  } finally {
    if (inFlight.get(stateDir) === job) inFlight.delete(stateDir);
  }
}

// The usable pinned ids from the first usable one on, or null when none is usable.
function usePin(pin, zdr, cfg, accountIds) {
  const screened = screenIds(pin.ids, zdr, cfg, accountIds);
  const i = screened.findIndex((s) => s.ok);
  if (i < 0) return null;
  return {
    choice: autoChoice(screened.slice(i).filter((s) => s.ok).map((s) => s.id)),
    modelLine: `model: auto -> ${screened[i].id} (pinned ${pinDate(pin)})`,
    notes: screened.slice(0, i).map((s) => `pinned ${s.id} skipped: ${s.reason}`),
  };
}

function probeLine(pin) {
  const total = pin.probe.reduce((s, p) => s + (p.cost ?? 0), 0);
  return `probes: ${pin.probe.map((p) => `${p.id} ${p.ok ? 'ok' : `failed (${p.reason})`}`).join('; ')}; total $${total.toFixed(6)}`;
}

/**
 * The ids an auto job runs with. A usable pin is used as it is; with no pin, an
 * unreadable one (set aside) or no usable pinned id, `pick(seenPickedAt)` picks under
 * the lock and returns { pin, picked }. Returns { choice, config, modelLine, notes }.
 */
export async function resolveAuto({ stateDir, config, zdr, accountIds, pick, now = () => Date.now() }) {
  const cfg = autoConfig(config);
  const notes = [];
  let read = readPin(stateDir);
  if (read.error) {
    const aside = setAsidePin(stateDir, now());
    notes.push(`the pin file could not be used (${read.error})${aside ? `; kept as ${aside}` : ''}; picked again`);
    read = { pin: null };
  }
  let old = null;
  if (read.pin) {
    const r = usePin(read.pin, zdr, cfg, accountIds);
    if (r) return { ...r, config: cfg, notes: [...notes, ...r.notes] };
    old = { id: read.pin.ids[0], reason: screenIds([read.pin.ids[0]], zdr, cfg, accountIds)[0].reason };
  }
  const got = await pick(read.pin?.picked_at ?? null);
  if (!got.picked) {
    const r = usePin(got.pin, zdr, cfg, accountIds);
    if (!r) throw new InputError(`the models another cheap-eyes process just picked are not usable here (${got.pin.ids.join(', ')}); ${PICK_HINT}`);
    return { ...r, config: cfg, notes: [...notes, ...r.notes] };
  }
  const first = got.pin.probe.find((p) => p.id === got.pin.ids[0]);
  const modelLine = old ? `model: auto re-picked: ${old.id} -> ${got.pin.ids[0]} (${old.reason})` : `model: auto picked ${got.pin.ids[0]} (probe ok, $${(first?.cost ?? 0).toFixed(6)})`;
  return { choice: autoChoice(got.pin.ids), config: cfg, modelLine, notes: [...notes, probeLine(got.pin)] };
}

/**
 * dry_run: what an auto job would use, without probing, picking or touching the pin.
 * Returns { choice, config, modelLine }; choice is null when nothing is picked yet.
 */
export function peekAuto({ stateDir, config, zdr }) {
  const cfg = autoConfig(config);
  const read = readPin(stateDir);
  if (read.error) return { choice: null, config: cfg, modelLine: `model: auto (not picked yet: the pin file could not be used, ${read.error}; the next job picks again)` };
  if (!read.pin) return { choice: null, config: cfg, modelLine: 'model: auto (not picked yet)' };
  if (!zdr) return { choice: autoChoice(read.pin.ids), config: cfg, modelLine: `model: auto -> ${read.pin.ids[0]} (pinned ${pinDate(read.pin)})` };
  const r = usePin(read.pin, zdr, cfg, null);
  if (r) return { choice: r.choice, config: cfg, modelLine: r.modelLine };
  const reason = screenIds([read.pin.ids[0]], zdr, cfg, null)[0].reason;
  return { choice: null, config: cfg, modelLine: `model: auto (pinned ids not usable: ${read.pin.ids[0]}: ${reason}; the next job picks again)` };
}

// The pin for check-config and the model table, offline.
export function pinSummary(stateDir) {
  const read = readPin(stateDir);
  if (read.error) return `auto (the pin file cannot be used: ${read.error}; the next model job sets it aside and picks again)`;
  if (!read.pin) return 'auto (not picked yet)';
  const more = read.pin.ids.slice(1);
  return `auto (pinned ${read.pin.ids[0]}, ${pinDate(read.pin)}${more.length ? `; next: ${more.join(', ')}` : ''})`;
}

// How long a probe call took; nothing for a pin written without it.
export function probeTime(p) {
  return typeof p.ms === 'number' ? `, ${(p.ms / 1000).toFixed(1)} s` : '';
}

export function probeTable(probes, cands = []) {
  const price = new Map(cands.map((c) => [c.id, `in ${fmtPrice(c.fitIn)} / out ${fmtPrice(c.fitOut)} per 1M`]));
  return probes.map((p) => `  ${p.ok ? 'ok    ' : 'failed'} ${p.id}${price.has(p.id) ? `  ${price.get(p.id)}` : ''}  probe $${(p.cost ?? 0).toFixed(6)}${probeTime(p)}${p.ok ? '' : `  (${p.reason})`}`);
}
