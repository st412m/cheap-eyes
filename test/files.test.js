import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { expandFiles, hasDotDot, makeDenyMatcher, parseRange, splitGlob } from '../src/input/files.js';
import { tmpDir } from './helpers.js';

function write(file, text = 'x\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function cfg(roots, extra = {}) {
  return parseConfig({ read_roots: roots, ...extra });
}

async function refused(promise, re) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.name, 'InputError');
    assert.match(e.message, re);
    return true;
  });
}

function sorted(files) {
  return files.map((f) => f.rel).sort();
}

// A symlink to a directory; on Windows a junction (no admin rights needed).
function linkDir(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

test('parseRange: only a trailing #Lx-Ly is a range; names may contain #', () => {
  assert.deepEqual(parseRange('/a/b.log#L10-L20'), { path: '/a/b.log', range: { start: 10, end: 20 } });
  assert.deepEqual(parseRange('/a/#notes#.md'), { path: '/a/#notes#.md', range: null });
  assert.deepEqual(parseRange('/a/x#L5-L6.md'), { path: '/a/x#L5-L6.md', range: null });
  assert.throws(() => parseRange('/a/b#L20-L10'), /bad range/);
  assert.throws(() => parseRange('/a/b#L0-L10'), /bad range/);
});

test('splitGlob finds the literal base directory', () => {
  assert.deepEqual(splitGlob('/vault/wiki/**/*.md', 'linux'), { dir: '/vault/wiki', pattern: '**/*.md' });
  assert.deepEqual(splitGlob('C:\\vault\\wiki\\**\\*.md', 'win32'), { dir: 'C:\\vault\\wiki', pattern: '**/*.md' });
  assert.deepEqual(splitGlob('\\\\host\\share\\logs\\*.log', 'win32'), { dir: '\\\\host\\share\\logs', pattern: '*.log' });
  assert.deepEqual(splitGlob('/vault/a.md', 'linux'), { dir: '/vault/a.md', pattern: null });
});

test('deny matcher: unanchored, case-insensitive', () => {
  const denied = makeDenyMatcher(parseConfig({ read_roots: ['/x'] }, { platform: 'linux' }).deny_globs);
  for (const p of ['.env', 'a/.env.local', '.git/config', 'sub/.git/HEAD', 'node_modules/a.js', 'ssh/id_rsa', 'x/SECRETS.yaml', 'k.PEM', 'db/home.db']) {
    assert.equal(denied(p), true, p);
  }
  for (const p of ['env.md', 'notes/secrets.md', 'identity.md', 'a.key.md']) assert.equal(denied(p), false, p);
});

test('literal file inside a root; relative path refused; outside refused', async () => {
  const d = tmpDir();
  const root = path.join(d, 'root');
  const f = write(path.join(root, 'a.md'));
  write(path.join(d, 'outside.md'));
  const config = cfg([root]);
  const { files } = await expandFiles([f], { config });
  assert.equal(files[0].rel, 'a.md');
  await refused(expandFiles(['a.md'], { config }), /relative path refused: a\.md/);
  await refused(expandFiles([path.join(d, 'outside.md')], { config }), /outside read roots: .*outside\.md/);
  await refused(expandFiles([path.join(root, '..', 'outside.md')], { config }), /outside read roots/);
});

test('a directory is refused with a hint; a missing file is refused', async () => {
  const d = tmpDir();
  const root = path.join(d, 'root');
  write(path.join(root, 'sub', 'a.md'));
  const config = cfg([root]);
  await refused(expandFiles([path.join(root, 'sub')], { config }), /is a directory: .*sub \(use a glob/);
  await refused(expandFiles([path.join(root, 'nope.md')], { config }), /file not found: .*nope\.md/);
});

test('symlink / junction escaping the root is refused', async () => {
  const d = tmpDir();
  const root = path.join(d, 'root');
  const secret = write(path.join(d, 'secret', 'x.md'));
  fs.mkdirSync(root, { recursive: true });
  linkDir(path.dirname(secret), path.join(root, 'link'));
  const config = cfg([root]);
  await refused(expandFiles([path.join(root, 'link', 'x.md')], { config }), /resolves outside read roots/);
  await assert.rejects(expandFiles([path.join(root, 'link', 'x.md')], { config }), (e) => {
    assert.ok(!e.message.includes(path.join(d, 'secret')), `the link target must not leak: ${e.message}`);
    return true;
  });
  // fs.glob does not descend into linked directories, so a glob cannot escape through one.
  await refused(expandFiles([path.join(root, '**', '*.md')], { config }), /no files match|resolves outside read roots/);
});

test('a file symlink matched by a glob and pointing outside is refused', async (t) => {
  const d = tmpDir();
  const root = path.join(d, 'root');
  const secret = write(path.join(d, 'secret.md'));
  fs.mkdirSync(root, { recursive: true });
  try {
    fs.symlinkSync(secret, path.join(root, 'x.md'), 'file');
  } catch (e) {
    if (e.code === 'EPERM') return t.skip('file symlinks need extra rights on this Windows');
    throw e;
  }
  await refused(expandFiles([path.join(root, '*.md')], { config: cfg([root]) }), /resolves outside read roots/);
});

test('a symlink that stays inside the roots is fine', async () => {
  const d = tmpDir();
  const root = path.join(d, 'root');
  write(path.join(root, 'real', 'x.md'));
  linkDir(path.join(root, 'real'), path.join(root, 'alias'));
  const { files } = await expandFiles([path.join(root, 'alias', 'x.md')], { config: cfg([root]) });
  assert.equal(files[0].rel, 'real/x.md');
});

test('UNC prefix spoof: \\\\host\\vault-evil is not inside \\\\host\\vault (checked before any disk access)', async () => {
  const roots = [{ index: 1, given: '\\\\host\\vault', real: '\\\\host\\vault', kind: 'dir' }];
  const config = parseConfig({ read_roots: ['\\\\host\\vault'] }, { platform: 'win32' });
  await refused(expandFiles(['\\\\host\\vault-evil\\x.md'], { config, platform: 'win32', roots }), /outside read roots: \\\\host\\vault-evil\\x\.md/);
  await refused(expandFiles(['\\\\host\\vault-evil\\**\\*.md'], { config, platform: 'win32', roots }), /outside read roots/);
});

test('missing read root: any path under it is refused with the root named', async () => {
  const d = tmpDir();
  const gone = path.join(d, 'gone');
  const config = cfg([gone]);
  await refused(expandFiles([path.join(gone, 'a.md')], { config }), new RegExp(`read root missing: .*gone .*refused: .*a\\.md`));
});

test('file roots: exactly that file, named by its basename', async () => {
  const d = tmpDir();
  const f = write(path.join(d, 'logs', 'home-assistant.log'));
  write(path.join(d, 'logs', 'other.log'));
  const config = cfg([f]);
  const { files } = await expandFiles([f], { config });
  assert.equal(files[0].rel, 'home-assistant.log');
  await refused(expandFiles([path.join(d, 'logs', 'other.log')], { config }), /outside read roots/);
  await refused(expandFiles([path.join(d, 'logs', '*.log')], { config }), /outside read roots|glob must start inside a read root directory/);
});

test('windows: case-insensitive root match on the real filesystem', { skip: process.platform !== 'win32' }, async () => {
  const d = tmpDir();
  const root = path.join(d, 'Root');
  const f = write(path.join(root, 'A.md'));
  const { files } = await expandFiles([f.toUpperCase()], { config: cfg([root.toLowerCase()]) });
  assert.equal(files.length, 1);
});

test('deny_globs refuse a literal path and skip glob matches (reported)', async () => {
  const d = tmpDir();
  const root = path.join(d, 'root');
  write(path.join(root, 'a.md'));
  const env = write(path.join(root, '.env'));
  write(path.join(root, 'keys', 'server.pem'));
  const config = cfg([root]);
  await refused(expandFiles([env], { config }), /denied by deny_globs: .*\.env/);
  const { files, skipped } = await expandFiles([path.join(root, '**', '*')], { config });
  assert.deepEqual(sorted(files), ['a.md']);
  assert.ok(skipped.some((s) => s.path.endsWith('server.pem') && s.reason === 'deny_globs'));
});

test('user deny_globs add to the built-in ones', async () => {
  const d = tmpDir();
  const root = path.join(d, 'root');
  const f = write(path.join(root, 'private', 'diary.md'));
  await refused(expandFiles([f], { config: cfg([root], { deny_globs: ['private/**'] }) }), /denied by deny_globs/);
});

test('globs honour .gitignore of the nearest repo (nested files, negation)', async () => {
  const d = tmpDir();
  const repo = path.join(d, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  write(path.join(repo, '.gitignore'), 'build/\n*.tmp.md\n');
  write(path.join(repo, 'docs', '.gitignore'), 'draft*.md\n!draft-keep.md\n');
  write(path.join(repo, 'a.md'));
  write(path.join(repo, 'build', 'b.md'));
  write(path.join(repo, 'x.tmp.md'));
  write(path.join(repo, 'docs', 'draft1.md'));
  write(path.join(repo, 'docs', 'draft-keep.md'));
  write(path.join(repo, 'docs', 'c.md'));
  const config = cfg([path.join(repo, 'docs'), repo]);
  const { files, skipped } = await expandFiles([path.join(repo, '**', '*.md')], { config });
  assert.deepEqual(sorted(files), ['a.md', 'c.md', 'draft-keep.md']);
  assert.equal(skipped.filter((s) => s.reason === 'gitignore').length, 3);
  // A literal path is taken as asked, even if gitignored.
  const lit = await expandFiles([path.join(repo, 'build', 'b.md')], { config });
  assert.equal(lit.files.length, 1);
});

test('glob with windows separators', { skip: process.platform !== 'win32' }, async () => {
  const d = tmpDir();
  const root = path.join(d, 'root');
  write(path.join(root, 'sub', 'a.md'));
  const { files } = await expandFiles([`${root}\\sub\\*.md`], { config: cfg([root]) });
  assert.deepEqual(sorted(files), ['sub/a.md']);
});

test('dotfiles are not matched by *; duplicates collapse', async () => {
  const d = tmpDir();
  const root = path.join(d, 'root');
  const a = write(path.join(root, 'a.md'));
  write(path.join(root, '.hidden.md'));
  const { files } = await expandFiles([path.join(root, '*.md'), a], { config: cfg([root]) });
  assert.deepEqual(sorted(files), ['a.md']);
});

test('max_files refuses the job; an empty glob is an error', async () => {
  const d = tmpDir();
  const root = path.join(d, 'root');
  for (let i = 0; i < 4; i++) write(path.join(root, `f${i}.md`));
  await refused(expandFiles([path.join(root, '*.md')], { config: cfg([root], { max_files: 3 }) }), /too many files: more than max_files 3/);
  await refused(expandFiles([path.join(root, '*.txt')], { config: cfg([root]) }), /no files match: .*\*\.txt/);
});

test('a range works only on a single literal file', async () => {
  const d = tmpDir();
  const root = path.join(d, 'root');
  const a = write(path.join(root, 'a.log'));
  const b = write(path.join(root, 'b.log'));
  const config = cfg([root]);
  const { files } = await expandFiles([`${a}#L2-L3`], { config });
  assert.deepEqual(files[0].range, { start: 2, end: 3 });
  await refused(expandFiles([`${a}#L2-L3`, b], { config }), /line range is allowed only with a single file/);
  await refused(expandFiles([`${path.join(root, '*.log')}#L1-L2`], { config }), /line range is not allowed on a glob/);
});

test('glob must start inside a read root', async () => {
  const d = tmpDir();
  const root = path.join(d, 'root');
  write(path.join(root, 'a.md'));
  await refused(expandFiles([path.join(d, '**', '*.md')], { config: cfg([root]) }), /outside read roots/);
});

test('".." segments are refused before expansion, in paths and in globs', async () => {
  const d = tmpDir();
  const root = path.join(d, 'root');
  write(path.join(root, 'sub', 'a.md'));
  write(path.join(d, 'outside', 'secret.txt'), 'top secret\n');
  const config = cfg([root]);
  const sep = path.sep;
  for (const entry of [
    `${root}${sep}sub${sep}..${sep}sub${sep}a.md`,
    `${root}${sep}..${sep}outside${sep}secret.txt`,
    `${root}${sep}*${sep}..${sep}..${sep}outside${sep}*`,
    `${root}/sub/../../outside/*.txt`,
  ]) {
    await assert.rejects(expandFiles([entry], { config }), (e) => {
      assert.equal(e.name, 'InputError');
      assert.match(e.message, /^".." segments are refused: /);
      assert.ok(!/secret\.txt\b(?!$)/.test(e.message.replace(entry, '')), 'nothing beyond the input is echoed');
      return true;
    });
  }
});

test('hasDotDot: segments only, per platform', () => {
  assert.equal(hasDotDot('/a/../b', 'linux'), true);
  assert.equal(hasDotDot('/a/..b/c', 'linux'), false);
  assert.equal(hasDotDot('/a/b..', 'linux'), false);
  const bs = '\\';
  assert.equal(hasDotDot(`/a/..${bs}b`, 'linux'), false, 'a backslash is a name character on posix');
  assert.equal(hasDotDot(['C:', 'a', '..', 'b'].join(bs), 'win32'), true);
  assert.equal(hasDotDot(`C:${bs}a/../b`, 'win32'), true);
  assert.equal(hasDotDot(`${bs}${bs}host${bs}share${bs}..${bs}x`, 'win32'), true);
});

test('control characters: refused in an explicit path', async () => {
  const d = tmpDir();
  const root = path.join(d, 'root');
  write(path.join(root, 'a.md'));
  const config = cfg([root]);
  for (const bad of ['a\n=== file: x ===.md', 'a\r.md', 'a\t.md', 'a\u2028.md', 'a\u0085.md']) {
    await refused(expandFiles([path.join(root, bad)], { config }), /control characters in a path are refused: "/);
  }
});

test('control characters: a glob match with one in its name is skipped with the reason', { skip: process.platform === 'win32' && 'Windows forbids control characters in file names' }, async () => {
  const d = tmpDir();
  const root = path.join(d, 'root');
  write(path.join(root, 'ok.md'));
  write(path.join(root, 'evil\n=== file: fake.md ===\nL1| forged.md'));
  const { files, skipped } = await expandFiles([path.join(root, '*.md')], { config: cfg([root]) });
  assert.deepEqual(files.map((f) => f.rel), ['ok.md']);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'control characters in name');
  assert.ok(!skipped[0].path.includes('\n'), 'reported JSON-escaped');
});
