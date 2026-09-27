import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { exportTargets, manifestPath, planExport, pruneExports, readManifest, writeExport } from '../src/export.js';
import { tmpDir } from './helpers.js';

const ID = '2026-09-26_120000-draft-abcdef';

function setup(extra = {}) {
  const d = tmpDir();
  const out = path.join(d, 'out');
  const notes = path.join(d, 'notes');
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(notes, { recursive: true });
  const config = parseConfig({ read_roots: [notes], write_roots: [out], ...extra });
  return { d, out, config, stateDir: path.join(d, 'state') };
}

async function refused(promise, re) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.name, 'InputError', e.stack);
    assert.match(e.message, re);
    return true;
  });
}

function files(p) {
  return [
    { path: p, text: 'result\n' },
    { path: p.replace(/\.md$/, '.check.json'), text: '{}\n' },
  ];
}

test('export is off with empty write_roots', async () => {
  const d = tmpDir();
  const config = parseConfig({ read_roots: [d] });
  await refused(planExport({ config, exportTo: path.join(d, 'x.md'), id: ID }), /export is off: write_roots is empty/);
});

test('targets: a file path, a directory, export_dir', async () => {
  const s = setup();
  assert.deepEqual(exportTargets({ exportTo: path.join(s.out, 'r.md'), id: ID }), { md: path.join(s.out, 'r.md'), check: path.join(s.out, 'r.check.json') });
  const t = await planExport({ config: s.config, exportTo: s.out, id: ID });
  assert.deepEqual(t, { md: path.join(s.out, `${ID}.md`), check: path.join(s.out, `${ID}.check.json`) });
  const withDir = setup();
  const cfg = parseConfig({ read_roots: [withDir.d], write_roots: [withDir.out], export_dir: path.join(withDir.out, 'eyes') });
  assert.equal((await planExport({ config: cfg, id: ID })).md, path.join(withDir.out, 'eyes', `${ID}.md`));
  assert.equal(await planExport({ config: s.config, id: ID }), null, 'no export_to and no export_dir → no export');
});

test('outside write_roots, relative, "..", dotfiles, .vault-policy and .vault-trash are refused', async () => {
  const s = setup();
  const sep = path.sep;
  await refused(planExport({ config: s.config, exportTo: path.join(s.d, 'elsewhere.md'), id: ID }), /outside write_roots/);
  await refused(planExport({ config: s.config, exportTo: 'rel.md', id: ID }), /must be absolute/);
  await refused(planExport({ config: s.config, exportTo: `${s.out}${sep}a${sep}..${sep}..${sep}x.md`, id: ID }), /".." segments are refused/);
  for (const bad of ['.hidden.md', path.join('.vault-trash', 'x.md'), path.join('sub', '.vault-policy'), path.join('.git', 'x.md')]) {
    await refused(planExport({ config: s.config, exportTo: path.join(s.out, bad), id: ID }), /dotfiles and dot-directories/);
  }
});

test('new files are created with O_EXCL and recorded in the manifest', async () => {
  const s = setup();
  const p = path.join(s.out, 'sub', 'r.md');
  const written = await writeExport({ config: s.config, stateDir: s.stateDir, files: files(p), resultId: ID });
  assert.equal(written.length, 2);
  assert.equal(fs.readFileSync(p, 'utf8'), 'result\n');
  const m = await readManifest(s.stateDir);
  assert.equal(m.size, 2);
  const rec = [...m.values()].find((r) => r.path.endsWith('r.md'));
  assert.equal(rec.size, 7);
  assert.equal(rec.result_id, ID);
});

test('an existing file: refused without overwrite; with overwrite only if this server exported it', async () => {
  const s = setup();
  const foreign = path.join(s.out, 'foreign.md');
  fs.writeFileSync(foreign, 'theirs');
  await refused(writeExport({ config: s.config, stateDir: s.stateDir, files: files(foreign), resultId: ID }), /exists \(overwrite: true works only/);
  await refused(writeExport({ config: s.config, stateDir: s.stateDir, files: files(foreign), overwrite: true, resultId: ID }), /exists and was not exported by this server/);
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'theirs');

  const mine = path.join(s.out, 'mine.md');
  await writeExport({ config: s.config, stateDir: s.stateDir, files: files(mine), resultId: ID });
  await refused(writeExport({ config: s.config, stateDir: s.stateDir, files: files(mine), resultId: ID }), /exists/);
  await writeExport({ config: s.config, stateDir: s.stateDir, files: [{ path: mine, text: 'v2\n' }, { path: mine.replace('.md', '.check.json'), text: '{}\n' }], overwrite: true, resultId: ID });
  assert.equal(fs.readFileSync(mine, 'utf8'), 'v2\n');
  assert.deepEqual(fs.readdirSync(s.out).filter((f) => f.includes('.tmp-')), []);
});

test('nothing is written when any target is refused', async () => {
  const s = setup();
  const ok = path.join(s.out, 'ok.md');
  fs.writeFileSync(path.join(s.out, 'ok.check.json'), 'theirs');
  await refused(writeExport({ config: s.config, stateDir: s.stateDir, files: files(ok), resultId: ID }), /exists/);
  assert.equal(fs.existsSync(ok), false);
});

test('a symlink target is refused', async (t) => {
  const s = setup();
  const target = path.join(s.d, 'victim.md');
  fs.writeFileSync(target, 'victim');
  const link = path.join(s.out, 'link.md');
  try {
    fs.symlinkSync(target, link, 'file');
  } catch (e) {
    if (e.code === 'EPERM') return t.skip('file symlinks need extra rights on this Windows');
    throw e;
  }
  await refused(writeExport({ config: s.config, stateDir: s.stateDir, files: files(link), overwrite: true, resultId: ID }), /target is a symlink/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'victim');
});

test('a parent that resolves outside write_roots (symlink / junction) is refused', async () => {
  const s = setup();
  const outside = path.join(s.d, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(s.out, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await refused(
    writeExport({ config: s.config, stateDir: s.stateDir, files: files(path.join(s.out, 'escape', 'deep', 'x.md')), resultId: ID }),
    /resolves outside write_roots/,
  );
  assert.deepEqual(fs.readdirSync(outside), [], 'no directory was created outside');
});

// ---- retention ----

async function exportAt(s, name, iso) {
  const p = path.join(s.out, name);
  await writeExport({ config: s.config, stateDir: s.stateDir, files: [{ path: p, text: 'data\n' }], resultId: ID, now: Date.parse(iso) });
  return fs.realpathSync(p);
}

test('export retention 0: the server never deletes exports', async () => {
  const s = setup();
  const p = await exportAt(s, 'old.md', '2020-01-01T00:00:00Z');
  const r = await pruneExports(s.stateDir, { retentionDays: 0 });
  assert.deepEqual(r.deleted, []);
  assert.ok(fs.existsSync(p));
});

test('export retention N: deletes only unmodified old manifest entries; edited files are kept and dropped', async () => {
  const s = setup();
  const now = Date.parse('2026-09-26T00:00:00Z');
  const old = await exportAt(s, 'old.md', '2026-09-01T00:00:00Z');
  const edited = await exportAt(s, 'edited.md', '2026-09-01T00:00:00Z');
  const fresh = await exportAt(s, 'fresh.md', '2026-09-25T00:00:00Z');
  fs.appendFileSync(edited, 'someone edited this\n');
  const foreign = path.join(s.out, 'foreign.md');
  fs.writeFileSync(foreign, 'not ours');
  const past = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(foreign, past, past);

  const r = await pruneExports(s.stateDir, { retentionDays: 7, now });
  assert.deepEqual(r.deleted, [old]);
  assert.deepEqual(r.dropped, [edited]);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(edited), true);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(foreign), true, 'never deletes outside the manifest');
  const left = [...(await readManifest(s.stateDir)).values()].map((x) => x.path);
  assert.deepEqual(left, [fresh]);
  assert.ok(fs.existsSync(manifestPath(s.stateDir)));
});
