import assert from 'node:assert/strict';
import { test } from 'node:test';
import { grepMatches, withContext } from '../src/input/grep.js';
import { fileItems } from '../src/input/render.js';
import { parseWhen, resolveTimeOptions, stampOf, timeWindow, zonedToEpoch } from '../src/input/timefilter.js';

const all = (lines) => lines.map((_, i) => i + 1);
const utc = (s) => Date.parse(s);

test('stamp formats: ISO 8601, HA/Supervisor, journalctl short-iso, syslog', () => {
  assert.equal(stampOf('2026-09-26T10:00:00Z msg', 'UTC'), utc('2026-09-26T10:00:00Z'));
  assert.equal(stampOf('2026-09-26T13:00:00+03:00 msg', 'UTC'), utc('2026-09-26T10:00:00Z'));
  assert.equal(stampOf('2026-09-26T13:00:00+0300 host sshd[1]: x', 'UTC'), utc('2026-09-26T10:00:00Z'));
  assert.equal(stampOf('2026-09-26 10:00:00.123 INFO (MainThread) [x]', 'UTC'), utc('2026-09-26T10:00:00.123Z'));
  assert.equal(stampOf('2026-09-26 10:00:00,5 WARNING', 'UTC'), utc('2026-09-26T10:00:00.500Z'));
  assert.equal(stampOf('\x1b[32m2026-09-26 10:00:00.000 INFO', 'UTC'), utc('2026-09-26T10:00:00Z'));
  assert.equal(stampOf('[2026-09-26 10:00:00] x', 'UTC'), utc('2026-09-26T10:00:00Z'));
  const now = utc('2026-09-26T12:00:00Z');
  assert.equal(stampOf('Sep 26 10:00:00 host kernel: x', 'UTC', now), utc('2026-09-26T10:00:00Z'));
  assert.equal(stampOf('Sep  6 10:00:00 host x', 'UTC', now), utc('2026-09-06T10:00:00Z'));
  assert.equal(stampOf('Traceback (most recent call last):', 'UTC'), null);
  assert.equal(stampOf('  File "x.py", line 3', 'UTC'), null);
  assert.equal(stampOf('2026-09-26 is a date only', 'UTC'), null);
});

test('syslog without a year: current year, previous one if that lands in the future', () => {
  const now = utc('2026-01-02T00:00:00Z');
  assert.equal(stampOf('Dec 31 23:00:00 host x', 'UTC', now), utc('2025-12-31T23:00:00Z'));
  assert.equal(stampOf('Jan  1 23:00:00 host x', 'UTC', now), utc('2026-01-01T23:00:00Z'));
});

test('tz: stamps without an offset are read in tz; with an offset tz is ignored', () => {
  assert.equal(stampOf('2026-09-26 13:00:00 x', 'Europe/Moscow'), utc('2026-09-26T10:00:00Z'));
  assert.equal(stampOf('2026-09-26T13:00:00Z x', 'Europe/Moscow'), utc('2026-09-26T13:00:00Z'));
  assert.equal(zonedToEpoch(2026, 7, 1, 12, 0, 0, 0, 'America/New_York'), utc('2026-07-01T16:00:00Z'));
  assert.equal(zonedToEpoch(2026, 1, 15, 12, 0, 0, 0, 'America/New_York'), utc('2026-01-15T17:00:00Z'));
});

test('since/until parsing', () => {
  assert.equal(parseWhen('2026-09-26', 'Europe/Moscow'), utc('2026-09-25T21:00:00Z'));
  assert.equal(parseWhen('2026-09-26T12:00', 'UTC'), utc('2026-09-26T12:00:00Z'));
  assert.equal(parseWhen('2026-09-26 12:00:30+03:00', 'UTC'), utc('2026-09-26T09:00:30Z'));
  assert.throws(() => parseWhen('yesterday', 'UTC'), /not an ISO 8601/);
  assert.throws(() => resolveTimeOptions({ since: '2026-09-27', until: '2026-09-26' }, 'UTC'), /since is after until/);
  assert.throws(() => resolveTimeOptions({}, 'UTC'), /give since, until or both/);
  assert.throws(() => resolveTimeOptions({ since: '2026-09-26', tz: 'Mars/Base' }, 'UTC'), /unknown IANA time zone/);
  assert.equal(resolveTimeOptions({ since: '2026-09-26' }, 'Europe/Moscow').tz, 'Europe/Moscow');
});

const LOG = [
  'preamble without stamp', // 1 dropped: before the first stamp
  '2026-09-26 09:00:00 INFO early', // 2
  '2026-09-26 10:00:00 ERROR boom', // 3
  'Traceback (most recent call last):', // 4
  '  File "x.py", line 3', // 5
  'ValueError: bad', // 6
  '2026-09-26 11:30:00 INFO late', // 7
  'continuation of late', // 8
];

test('time window keeps tracebacks whole and drops lines before the first stamp', () => {
  const opts = resolveTimeOptions({ since: '2026-09-26T09:30:00', until: '2026-09-26T11:00:00' }, 'UTC');
  assert.deepEqual(timeWindow(LOG, all(LOG), opts), [3, 4, 5, 6]);
  const open = resolveTimeOptions({ since: '2026-09-26T08:00:00' }, 'UTC');
  assert.deepEqual(timeWindow(LOG, all(LOG), open), [2, 3, 4, 5, 6, 7, 8]);
});

test('time window with tz: log stamps and since/until without offset are Moscow time', () => {
  // since 06:30Z = 09:30 Moscow; until 10:30 Moscow. Stamp 10:00 (Moscow) is inside, 11:30 is not.
  const opts = resolveTimeOptions({ since: '2026-09-26T06:30:00Z', until: '2026-09-26T10:30:00', tz: 'Europe/Moscow' }, 'UTC');
  assert.deepEqual(timeWindow(LOG, all(LOG), opts), [3, 4, 5, 6]);
});

test('a file with no recognised stamp is an error, not an empty result', () => {
  const opts = resolveTimeOptions({ since: '2026-09-26' }, 'UTC');
  assert.throws(() => timeWindow(['no', 'stamps'], [1, 2], { ...opts, name: 'notes.md' }), /no recognised timestamp in notes\.md/);
});

test('grep: windows keep original numbers; gaps are marked', async () => {
  const lines = Array.from({ length: 20 }, (_, i) => (i + 1 === 8 || i + 1 === 15 ? `hit ${i + 1}` : `line ${i + 1}`));
  const nums = all(lines);
  const [hits] = await grepMatches([nums.map((n) => lines[n - 1])], { pattern: '^hit' });
  const kept = withContext(nums, hits, 2);
  assert.deepEqual(kept, [6, 7, 8, 9, 10, 13, 14, 15, 16, 17]);
  const masked = new Map(lines.map((l, i) => [i, l]));
  const items = fileItems({ nums: kept, masked, total: 20, filtered: true }).map((i) => i.text);
  assert.deepEqual(items, [
    '… (lines 1–5 skipped)',
    'L6| line 6',
    'L7| line 7',
    'L8| hit 8',
    'L9| line 9',
    'L10| line 10',
    '… (lines 11–12 skipped)',
    'L13| line 13',
    'L14| line 14',
    'L15| hit 15',
    'L16| line 16',
    'L17| line 17',
    '… (lines 18–20 skipped)',
  ]);
});

test('grep: ignore_case, context 0, candidates from an earlier filter', async () => {
  const lines = ['A', 'b', 'a', 'c'];
  const [hits] = await grepMatches([[lines[1], lines[2], lines[3]]], { pattern: 'a', ignoreCase: true });
  assert.deepEqual(withContext([2, 3, 4], hits, 0), [3]);
});

test('grep: invalid regex refused; catastrophic regex times out instead of hanging', async () => {
  await assert.rejects(grepMatches([['x']], { pattern: '(' }), /invalid regular expression/);
  const evil = ['a'.repeat(40) + '!'];
  const t0 = Date.now();
  await assert.rejects(grepMatches([evil], { pattern: '^(a+)+$', timeoutMs: 300 }), /timed out after 300 ms/);
  assert.ok(Date.now() - t0 < 3000, 'the timeout fired');
});
