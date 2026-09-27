import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';

// A fresh temp dir per call, removed when the test file finishes.
export function tmpDir(prefix = 'cheap-eyes-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

// An env that cannot pick up the developer's real config or state dir.
export function isolatedEnv(home, extra = {}) {
  return {
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    ...extra,
  };
}

export const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.js');

// Arguments for spawning the CLI with the network disabled (fetch throws).
const NO_NETWORK = pathToFileURL(path.join(import.meta.dirname, 'fixtures', 'no-network.mjs')).href;
export const CLI_ARGS = ['--import', NO_NETWORK, CLI];
