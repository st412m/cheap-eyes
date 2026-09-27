// Both branches (path.win32 / path.posix) run on any OS: the platform is a parameter.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAbsoluteStrict, isInside, pathApi } from '../src/paths.js';
import path from 'node:path';

test('pathApi picks path.win32 or path.posix', () => {
  assert.equal(pathApi('win32'), path.win32);
  assert.equal(pathApi('linux'), path.posix);
  assert.equal(pathApi('darwin'), path.posix);
});

test('isAbsoluteStrict (win32): a drive with a separator or a UNC share', () => {
  assert.equal(isAbsoluteStrict('C:\\data', 'win32'), true);
  assert.equal(isAbsoluteStrict('c:/data', 'win32'), true);
  assert.equal(isAbsoluteStrict('\\\\host\\share\\x', 'win32'), true);
  assert.equal(isAbsoluteStrict('\\data', 'win32'), false, 'root of the current drive');
  assert.equal(isAbsoluteStrict('C:foo', 'win32'), false, 'relative to the current dir of drive C');
  assert.equal(isAbsoluteStrict('C:', 'win32'), false);
  assert.equal(isAbsoluteStrict('data\\x', 'win32'), false);
  assert.equal(isAbsoluteStrict('\\\\host', 'win32'), false);
});

test('isAbsoluteStrict (posix)', () => {
  assert.equal(isAbsoluteStrict('/data', 'linux'), true);
  assert.equal(isAbsoluteStrict('data', 'linux'), false);
  assert.equal(isAbsoluteStrict('./data', 'linux'), false);
  assert.equal(isAbsoluteStrict('C:\\data', 'linux'), false);
  assert.equal(isAbsoluteStrict('', 'linux'), false);
});

test('isInside (posix): whole segments', () => {
  assert.equal(isInside('/vault/a.md', '/vault', 'linux'), true);
  assert.equal(isInside('/vault', '/vault', 'linux'), true);
  assert.equal(isInside('/vault/', '/vault', 'linux'), true);
  assert.equal(isInside('/vault-evil', '/vault', 'linux'), false);
  assert.equal(isInside('/vault-evil/a.md', '/vault', 'linux'), false);
  assert.equal(isInside('/vault/../etc/passwd', '/vault', 'linux'), false);
  assert.equal(isInside('/', '/vault', 'linux'), false);
  assert.equal(isInside('/vault/a', '/', 'linux'), true);
});

test('isInside (posix): case matters', () => {
  assert.equal(isInside('/Vault/a.md', '/vault', 'linux'), false);
  assert.equal(isInside('/vault/A.md', '/vault/a.md', 'linux'), false);
});

test('isInside (win32): case-insensitive, separators either way', () => {
  assert.equal(isInside('C:\\Data\\Vault\\a.md', 'c:\\data\\vault', 'win32'), true);
  assert.equal(isInside('c:/data/vault/a.md', 'C:\\data\\vault\\', 'win32'), true);
  assert.equal(isInside('C:\\data\\vault-evil\\a.md', 'C:\\data\\vault', 'win32'), false);
  assert.equal(isInside('C:\\data\\vault\\..\\other\\a.md', 'C:\\data\\vault', 'win32'), false);
  assert.equal(isInside('D:\\data\\vault\\a.md', 'C:\\data\\vault', 'win32'), false);
});

test('isInside (win32): UNC share prefix spoof never matches', () => {
  assert.equal(isInside('\\\\host\\vault\\wiki\\a.md', '\\\\host\\vault', 'win32'), true);
  assert.equal(isInside('\\\\HOST\\Vault\\a.md', '\\\\host\\vault', 'win32'), true);
  assert.equal(isInside('\\\\host\\vault-evil\\a.md', '\\\\host\\vault', 'win32'), false);
  assert.equal(isInside('\\\\host-evil\\vault\\a.md', '\\\\host\\vault', 'win32'), false);
  assert.equal(isInside('C:\\vault\\a.md', '\\\\host\\vault', 'win32'), false);
});
