import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { eyesResult, MAX_BYTES } from '../src/result-tool.js';
import { allocateResult, idTime, newResultId, pruneResults, readCheck, running, writeCheck, writeResult } from '../src/results.js';
import { eyesResultInput, RESULT_ID_RE } from '../src/tools.js';
import { tmpDir } from './helpers.js';

function store() {
  const d = tmpDir();
  return { resultsDir: path.join(d, 'results') };
}

async function saved(ctx, text, check = {}) {
  return writeResult(ctx.resultsDir, 'extract', { md: text, check: (id) => ({ id, status: 'done', kind: 'run', header: `eyes_run result: ${id}`, ...check }) });
}

test('ids: UTC stamp, mode, 6 hex; the pattern refuses anything path-like', () => {
  const id = newResultId('draft', new Date('2026-09-26T12:57:03Z'));
  assert.match(id, /^2026-09-26_125703-draft-[0-9a-f]{6}$/);
  assert.equal(idTime(id), Date.parse('2026-09-26T12:57:03Z'));
  for (const bad of ['../x', '2026-09-26_125703-draft-abcdef/../x', '2026-09-26_125703-other-abcdef', '2026-09-26_125703-draft-ABCDEF', '..\\2026-09-26_125703-draft-abcdef']) {
    assert.equal(RESULT_ID_RE.test(bad), false, bad);
    assert.equal(eyesResultInput.safeParse({ id: bad }).success, false, bad);
  }
});

test('bare id → status and header; unknown id is an error', async () => {
  const ctx = store();
  const id = await saved(ctx, 'L1| a\n');
  const out = await eyesResult({ id }, ctx);
  assert.match(out, /^status: done\neyes_run result: /);
  await assert.rejects(eyesResult({ id: '2026-01-01_000000-extract-000000' }, ctx), /unknown result id/);
});

test('ids survive a restart: results are files; a running job cut by a restart is "interrupted"', async () => {
  const ctx = store();
  const id = await allocateResult(ctx.resultsDir, 'extract', { status: 'running', header: 'eyes_run running' });
  assert.equal(running.has(id), false, 'not in this process');
  const out = await eyesResult({ id }, ctx);
  assert.match(out, /^status: interrupted\n/);
  const lines = await eyesResult({ id, offset: 1 }, ctx);
  assert.match(lines, /^status: interrupted/);
});

test('paged lines: at most 200 lines per call, with total and next offset, framed', async () => {
  const ctx = store();
  const text = Array.from({ length: 450 }, (_, i) => `row ${i + 1}`).join('\n') + '\n';
  const id = await saved(ctx, text);
  const p1 = await eyesResult({ id, offset: 1 }, ctx);
  assert.match(p1, /^lines 1–200 of 450; more: next offset 201\n--- untrusted model output ---\nrow 1\n/);
  assert.ok(p1.endsWith('row 200\n--- end ---'));
  assert.equal(await eyesResult({ id, limit: 200 }, ctx), p1, 'offset defaults to 1');
  const p2 = await eyesResult({ id, offset: 201 }, ctx);
  assert.match(p2, /^lines 201–400 of 450; more: next offset 401\n--- untrusted model output ---\nrow 201\n/);
  const p3 = await eyesResult({ id, offset: 401, limit: 500 }, ctx);
  assert.match(p3, /^lines 401–450 of 450; end/);
  assert.ok(p3.endsWith('row 450\n--- end ---'));
  const small = await eyesResult({ id, offset: 10, limit: 3 }, ctx);
  assert.match(small, /^lines 10–12 of 450; more: next offset 13\n--- untrusted model output ---\nrow 10\nrow 11\nrow 12\n--- end ---$/);
});

test('offset is 1-based: 0 is refused by the schema', () => {
  assert.equal(eyesResultInput.safeParse({ id: '2026-09-26_101010-extract-abcdef', offset: 0 }).success, false);
  assert.equal(eyesResultInput.safeParse({ id: '2026-09-26_101010-extract-abcdef', offset: 1 }).success, true);
});

test('page numbers equal result_line in the check report', async () => {
  const ctx = store();
  const checks = {
    mode: 'extract',
    summary: { ok: 2, bad: 1 },
    items: [
      { status: 'ok', result_line: 1, text: 'L1| a' },
      { status: 'bad', result_line: 2, text: 'L9| invented' },
      { status: 'ok', result_line: 3, text: 'L3| c' },
    ],
  };
  const id = await saved(ctx, 'L1| a\nL9| invented\nL3| c\n', { checks });
  const bad = checks.items.find((it) => it.status === 'bad');
  const line = await eyesResult({ id, offset: bad.result_line, limit: 1 }, ctx);
  assert.match(line, /^lines 2–2 of 3; more: next offset 3\n--- untrusted model output ---\nL9\| invented\n--- end ---$/);
  const g = await eyesResult({ id, grep: 'invented' }, ctx);
  assert.match(g, new RegExp(`\\n#${bad.result_line}: L9\\| invented\\n`));
});

test('paged lines: at most 16 KB per call; a single huge line is clipped', async () => {
  const ctx = store();
  const text = Array.from({ length: 50 }, (_, i) => `${i} ${'x'.repeat(1000)}`).join('\n') + '\n' + 'y'.repeat(40000) + '\n';
  const id = await saved(ctx, text);
  const p = await eyesResult({ id, offset: 1 }, ctx);
  assert.ok(Buffer.byteLength(p) <= MAX_BYTES + 200, `${Buffer.byteLength(p)}`);
  assert.match(p, /^lines 1–16 of 51; more: next offset 17/);
  const huge = await eyesResult({ id, offset: 51 }, ctx);
  assert.match(huge, /\(line clipped\)/);
  assert.ok(Buffer.byteLength(huge) <= MAX_BYTES + 200);
});

test('frame markers inside stored text are neutralised', async () => {
  const ctx = store();
  const id = await saved(ctx, 'a\n\t--- end ---\nb\n');
  const out = await eyesResult({ id, offset: 1 }, ctx);
  assert.equal(out.split('\n').filter((l) => l.trim() === '--- end ---').length, 1);
});

test('grep: matching lines with their numbers, same caps', async () => {
  const ctx = store();
  const id = await saved(ctx, 'alpha\nbeta\nalphabet\ngamma\n');
  const out = await eyesResult({ id, grep: '^alpha' }, ctx);
  assert.match(out, /^matches 1–2 of 2; end\n--- untrusted model output ---\n#1: alpha\n#3: alphabet\n--- end ---$/);
  await assert.rejects(eyesResult({ id, grep: '(' }, ctx), /invalid regular expression/);
});

test('check: the report with bad items first, paged', async () => {
  const ctx = store();
  const checks = {
    mode: 'extract',
    summary: { ok: 2, bad: 1 },
    items: [
      { status: 'ok', ref: 'L1' },
      { status: 'bad', ref: 'L9', reason: 'text differs' },
      { status: 'ok', ref: 'L2' },
    ],
  };
  const id = await saved(ctx, 'x\n', { checks });
  const out = await eyesResult({ id, check: true }, ctx);
  const lines = out.split('\n');
  assert.equal(lines[0], 'check summary: {"ok":2,"bad":1}');
  assert.match(lines[1], /^items \(bad first\) 1–3 of 3; end/);
  assert.equal(JSON.parse(lines[3]).ref, 'L9');
  const dry = await writeResult(ctx.resultsDir, 'extract', { md: '[]\n', check: (i) => ({ id: i, status: 'done', kind: 'dry_run' }) });
  assert.match(await eyesResult({ id: dry, check: true }, ctx), /no check report/);
});

test('cancel on a finished job reports that it is not running', async () => {
  const ctx = store();
  const id = await saved(ctx, 'x\n');
  assert.equal(await eyesResult({ id, cancel: true }, ctx), 'not running (status: done)');
});

// ---- pruning ----

async function aged(ctx, iso, bytes = 10) {
  const id = await allocateResult(ctx.resultsDir, 'draft', { status: 'done' }, new Date(iso));
  fs.writeFileSync(path.join(ctx.resultsDir, `${id}.md`), 'z'.repeat(bytes));
  return id;
}

test('pruning: by age, then oldest first above the size cap; running jobs are kept', async () => {
  const ctx = store();
  const now = Date.parse('2026-09-26T12:00:00Z');
  const old = await aged(ctx, '2026-09-01T00:00:00Z');
  const a = await aged(ctx, '2026-09-20T00:00:00Z', 600 * 1024);
  const b = await aged(ctx, '2026-09-21T00:00:00Z', 600 * 1024);
  const c = await aged(ctx, '2026-09-22T00:00:00Z', 10);
  const busy = await aged(ctx, '2026-08-01T00:00:00Z');
  running.set(busy, { controller: new AbortController(), promise: Promise.resolve() });
  try {
    const r = await pruneResults(ctx.resultsDir, { retentionDays: 14, maxMb: 1, now });
    assert.deepEqual(r.deleted.sort(), [old, a].sort());
    const left = fs.readdirSync(ctx.resultsDir).map((f) => f.split('.')[0]);
    for (const id of [b, c, busy]) assert.ok(left.includes(id), id);
  } finally {
    running.delete(busy);
  }
});

test('pruning removes stale temp files and ignores foreign files', async () => {
  const ctx = store();
  fs.mkdirSync(ctx.resultsDir, { recursive: true });
  const tmp = path.join(ctx.resultsDir, '2026-09-01_000000-draft-abcdef.check.json.tmp-0123abcd');
  fs.writeFileSync(tmp, '{}');
  const past = new Date(Date.now() - 2 * 3600e3);
  fs.utimesSync(tmp, past, past);
  const foreign = path.join(ctx.resultsDir, 'notes.txt');
  fs.writeFileSync(foreign, 'keep');
  await pruneResults(ctx.resultsDir, { retentionDays: 14, maxMb: 500 });
  assert.equal(fs.existsSync(tmp), false);
  assert.equal(fs.existsSync(foreign), true);
});

test('writeCheck replaces the file atomically', async () => {
  const ctx = store();
  const id = await allocateResult(ctx.resultsDir, 'edits', { status: 'running' });
  await writeCheck(ctx.resultsDir, id, { id, status: 'done' });
  assert.equal((await readCheck(ctx.resultsDir, id)).status, 'done');
  assert.deepEqual(fs.readdirSync(ctx.resultsDir).filter((f) => f.includes('.tmp-')), []);
});
