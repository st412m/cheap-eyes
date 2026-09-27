// Time window over log lines. A line without its own stamp belongs to the last
// stamped line above it (tracebacks stay whole); lines before the first stamp are dropped.
import { isValidTimeZone } from '../config.js';
import { InputError } from '../errors.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PREFIX = String.raw`^(?:\x1b\[[0-9;]*m)*\[?`;
// ISO 8601, `YYYY-MM-DD HH:MM:SS[.mmm]` (HA, Supervisor), journalctl short-iso (+0300).
const ISO_RE = new RegExp(
  PREFIX + String.raw`(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?(?![\d:])`,
);
// syslog / journalctl short: `Sep  6 12:00:00`, no year.
const SYSLOG_RE = new RegExp(PREFIX + String.raw`(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?!\d)`);
const WHEN_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

const dtfCache = new Map();
function formatter(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

// Offset of `tz` from UTC at instant `epoch`, in ms. Memoised per 15-minute slot
// (every real-world offset change falls on one) so large logs stay fast.
const offsetCache = new Map();
function offsetAt(epoch, tz) {
  const key = `${tz}|${Math.floor(epoch / 900000)}`;
  let v = offsetCache.get(key);
  if (v === undefined) {
    v = computeOffset(epoch, tz);
    if (offsetCache.size > 10000) offsetCache.clear();
    offsetCache.set(key, v);
  }
  return v;
}

function computeOffset(epoch, tz) {
  const parts = {};
  for (const p of formatter(tz).formatToParts(new Date(epoch))) parts[p.type] = p.value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(epoch / 1000) * 1000;
}

// Wall-clock time in `tz` → epoch ms. In a DST gap the later offset wins.
export function zonedToEpoch(y, mo, d, h, mi, s, ms, tz) {
  const local = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (tz === 'UTC') return local;
  let t = local - offsetAt(local, tz);
  const o2 = offsetAt(t, tz);
  if (local - o2 !== t) t = local - o2;
  return t;
}

function offsetMs(off) {
  if (off === 'Z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(off);
  const v = (+m[2] * 60 + +(m[3] ?? 0)) * 60000;
  return m[1] === '-' ? -v : v;
}

function fracMs(f) {
  return f ? Math.floor(Number(`0.${f}`) * 1000) : 0;
}

function build(y, mo, d, h, mi, s, frac, off, tz) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const ms = fracMs(frac);
  if (off) return Date.UTC(y, mo - 1, d, h, mi, s, ms) - offsetMs(off);
  return zonedToEpoch(y, mo, d, h, mi, s, ms, tz);
}

// since/until: ISO 8601 date or date-time; `tz` applies when there is no offset.
export function parseWhen(str, tz, label = 'time') {
  const m = WHEN_RE.exec(String(str).trim());
  if (!m) throw new InputError(`${label}: not an ISO 8601 date/time: ${str}`);
  const t = build(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), m[7], m[8], tz);
  if (t === null || Number.isNaN(t)) throw new InputError(`${label}: invalid date/time: ${str}`);
  return t;
}

let lastYear = { tz: null, now: null, year: 0 };
function yearIn(tz, now) {
  if (lastYear.tz !== tz || lastYear.now !== now) {
    lastYear = { tz, now, year: +new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(new Date(now)) };
  }
  return lastYear.year;
}

// Epoch ms of the leading stamp of `line`, or null. Syslog stamps take the
// current year in `tz`, the previous one if that lands in the future.
export function stampOf(line, tz, now = Date.now()) {
  let m = ISO_RE.exec(line);
  if (m) return build(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0), m[7], m[8], tz);
  m = SYSLOG_RE.exec(line);
  if (m) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    const year = yearIn(tz, now);
    let t = build(year, mo, +m[2], +m[3], +m[4], +m[5], m[6], null, tz);
    if (t !== null && t > now) t = build(year - 1, mo, +m[2], +m[3], +m[4], +m[5], m[6], null, tz);
    return t;
  }
  return null;
}

export function resolveTimeOptions(time, defaultTz) {
  const tz = time.tz ?? defaultTz;
  if (!isValidTimeZone(tz)) throw new InputError(`time.tz: unknown IANA time zone: ${tz}`);
  if (time.since === undefined && time.until === undefined) throw new InputError('time: give since, until or both');
  const since = time.since !== undefined ? parseWhen(time.since, tz, 'time.since') : -Infinity;
  const until = time.until !== undefined ? parseWhen(time.until, tz, 'time.until') : Infinity;
  if (since > until) throw new InputError('time: since is after until');
  return { since, until, tz };
}

// `nums`: candidate line numbers (1-based, ascending) of `lines`. Returns kept numbers.
export function timeWindow(lines, nums, { since, until, tz, now = Date.now(), name = 'file' }) {
  const kept = [];
  let current = null;
  let anyStamp = false;
  for (const n of nums) {
    const t = stampOf(lines[n - 1], tz, now);
    if (t !== null) {
      anyStamp = true;
      current = t;
    }
    if (current !== null && current >= since && current <= until) kept.push(n);
  }
  if (!anyStamp) throw new InputError(`time filter: no recognised timestamp in ${name}`);
  return kept;
}
