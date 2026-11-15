// `cheap-eyes hook install [--project]` / `hook remove`: the PreToolUse entry for
// Claude Code's Read tool that runs hooks/block-large-reads.js of this installation,
// in ~/.claude/settings.json (or .claude/settings.json of the current folder with
// --project). Every other key of the file is kept; a file that is not valid JSON is
// refused and left as it is; the file is written through a temporary file and a rename.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_FILE = 'block-large-reads.js';
const MATCHER = 'Read';

export class HookError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HookError';
  }
}

export function hookScriptPath() {
  return fileURLToPath(new URL(`../hooks/${HOOK_FILE}`, import.meta.url));
}

// An installation run by npx lives in the npm cache under a hash that changes.
export function inNpxCache(p) {
  return p.split(/[\\/]/).includes('_npx');
}

export function settingsPath({ project = false, cwd = process.cwd(), homedir = os.homedir() } = {}) {
  return path.join(project ? cwd : homedir, '.claude', 'settings.json');
}

// The hook command: forward slashes, so both the shells Claude Code may use (bash, cmd)
// read the quoted path the same way.
export function hookCommand(script = hookScriptPath()) {
  return `node "${script.replace(/\\/g, '/')}"`;
}

// True for a hook command of cheap-eyes (any installation path).
function isOurs(h) {
  return h && typeof h.command === 'string' && h.command.replace(/\\/g, '/').includes(`/hooks/${HOOK_FILE}`);
}

function readSettings(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new HookError(`${file}: cannot read (${e.code ?? e.message})`);
  }
  if (text.trim() === '') return {};
  let json;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new HookError(`${file} is not valid JSON; it was left as it is: fix it, then run the command again`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new HookError(`${file} is not a JSON object; it was left as it is`);
  return json;
}

function writeSettings(file, json) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n', 'utf8');
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
}

// Removes every hook command of cheap-eyes from the PreToolUse list; empty groups and
// an empty list go too. Returns how many commands were removed.
function strip(json) {
  const list = json.hooks?.PreToolUse;
  if (!Array.isArray(list)) return 0;
  let removed = 0;
  const kept = [];
  for (const group of list) {
    if (!group || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const hooks = group.hooks.filter((h) => {
      if (isOurs(h)) {
        removed++;
        return false;
      }
      return true;
    });
    if (hooks.length) kept.push({ ...group, hooks });
  }
  if (kept.length) json.hooks.PreToolUse = kept;
  else delete json.hooks.PreToolUse;
  if (json.hooks && Object.keys(json.hooks).length === 0) delete json.hooks;
  return removed;
}

/** Returns { file, changed, replaced, command }. */
export function installHook({ project = false, cwd, homedir, script = hookScriptPath() } = {}) {
  if (inNpxCache(script)) {
    throw new HookError(`cheap-eyes runs from the npx cache (${path.dirname(path.dirname(script))}), a path that changes: install it first with \`npm install -g cheap-eyes\`, then run \`cheap-eyes hook install\``);
  }
  const file = settingsPath({ project, cwd, homedir });
  const json = readSettings(file);
  const command = hookCommand(script);
  const present = (json.hooks?.PreToolUse ?? []).some((g) => g?.matcher === MATCHER && (g.hooks ?? []).some((h) => h?.type === 'command' && h.command === command));
  const others = JSON.parse(JSON.stringify(json));
  const ours = strip(others);
  if (present && ours === 1) return { file, changed: false, replaced: 0, command };
  others.hooks ??= {};
  others.hooks.PreToolUse ??= [];
  others.hooks.PreToolUse.push({ matcher: MATCHER, hooks: [{ type: 'command', command }] });
  writeSettings(file, others);
  return { file, changed: true, replaced: ours, command };
}

/** Returns { file, removed }. */
export function removeHook({ project = false, cwd, homedir } = {}) {
  const file = settingsPath({ project, cwd, homedir });
  if (!fs.existsSync(file)) return { file, removed: 0 };
  const json = readSettings(file);
  const removed = strip(json);
  if (removed) writeSettings(file, json);
  return { file, removed };
}
