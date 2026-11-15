// Starting the `claude` command from Node without a shell. Arguments go to the process
// as an array, so a key or a proxy URL is never parsed by a shell (cmd and PowerShell
// both rewrite characters such as & % ^ " in a command string).
//
// On Windows `claude` is either an .exe (native install), run as it is, or an npm
// command shim (claude.cmd). Node refuses to start a .cmd without a shell, and cmd
// would parse the arguments, so for a shim the JavaScript entry point it names is run
// with node directly. A shim of any other shape is not run; the caller prints the
// command for the person instead.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// The script an npm cmd-shim runs: "%dp0%\node_modules\...\cli.js" (or %~dp0).
export function shimScript(text, shimDir) {
  const m = /"%~?dp0%?\\([^"%]+\.(?:c|m)?js)"/i.exec(text);
  return m ? path.win32.join(shimDir, m[1]) : null;
}

/**
 * Where `name` is on PATH and how to start it. Returns
 * { kind: 'exe' | 'script', file, command, prefix } — start it as
 * spawn(command, [...prefix, ...args]) — or { kind: 'shim-unknown', file } for a
 * Windows shim that cannot be run without a shell, or null when not found.
 */
export function findCommand(name, { env = process.env, platform = process.platform, execPath = process.execPath, readFile = (f) => fs.readFileSync(f, 'utf8'), exists = isFile } = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const pathVar = platform === 'win32' ? (env.Path ?? env.PATH ?? '') : (env.PATH ?? '');
  const dirs = pathVar.split(api.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = api.join(dir, name + ext);
      if (!exists(file)) continue;
      if (platform !== 'win32' || ext === '.exe' || ext === '.com') return { kind: 'exe', file, command: file, prefix: [] };
      if (ext === '.cmd' || ext === '.bat') {
        let script = null;
        try {
          script = shimScript(readFile(file), api.dirname(file));
        } catch {
          script = null;
        }
        if (script && exists(script)) return { kind: 'script', file, command: execPath, prefix: [script] };
        return { kind: 'shim-unknown', file };
      }
    }
  }
  return null;
}

/**
 * Run a found command with `args`, output shown to the person. Resolves to the exit
 * code (or 1 when it could not start, with `error`).
 */
export function runCommand(found, args, { spawnFn = spawn, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(found.command, [...found.prefix, ...args], { stdio: ['ignore', 'inherit', 'inherit'], env, shell: false, windowsHide: true });
    } catch (e) {
      resolve({ code: 1, error: e.code ?? e.message });
      return;
    }
    child.once('error', (e) => resolve({ code: 1, error: e.code ?? e.message }));
    child.once('exit', (code) => resolve({ code: code ?? 1 }));
  });
}

// One argument as a person would type it: plain when safe, else in single quotes
// (PowerShell and POSIX shells read them literally; a single quote is doubled for
// PowerShell, which is what the printed commands target on Windows).
export function displayArg(a, platform = process.platform) {
  if (/^[A-Za-z0-9_./:=@,+-]+$/.test(a)) return a;
  if (platform === 'win32') return `'${a.replace(/'/g, "''")}'`;
  return `'${a.replace(/'/g, `'\\''`)}'`;
}

export function displayCommand(cmd, args, platform = process.platform) {
  return [cmd, ...args].map((a) => displayArg(a, platform)).join(' ');
}
