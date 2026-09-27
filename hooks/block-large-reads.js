#!/usr/bin/env node
// Claude Code PreToolUse hook: deny a whole-file Read of a large text file and point
// to eyes_run, Grep or a ranged Read. Register it for the "Read" matcher.
//
// It never answers "allow" (that would skip the user's permission prompt): when it
// lets a call through it prints nothing and exits 0, and the normal permission flow
// applies. Any error — bad input, unreadable config or file — lets the call through.
// Shell commands are not intercepted.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_BYTES = 30720;
const PROBE = 8192;
const STDIN_TIMEOUT_MS = 5000;
// Read renders these itself (images, PDFs, notebooks): not plain text.
const NON_TEXT = /\.(?:png|jpe?g|gif|webp|bmp|ico|tiff?|pdf|ipynb)$/i;

function looksBinary(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false; // UTF-16 text
  return buf.includes(0);
}

// hook.max_bytes from the cheap-eyes config (same lookup as the server), else the default.
export async function maxBytesFromConfig() {
  try {
    const { loadConfig } = await import('../src/config.js');
    return loadConfig().config.hook.max_bytes;
  } catch {
    return DEFAULT_MAX_BYTES;
  }
}

// null = let it through; otherwise the reason shown to Claude.
export function decide(input, maxBytes) {
  if (!input || input.tool_name !== 'Read') return null;
  const ti = input.tool_input ?? {};
  if (ti.offset !== undefined || ti.limit !== undefined) return null;
  const file = ti.file_path;
  if (typeof file !== 'string' || file === '' || NON_TEXT.test(file)) return null;
  const st = fs.statSync(file);
  if (!st.isFile() || st.size <= maxBytes) return null;
  const fd = fs.openSync(file, 'r');
  let probe;
  try {
    const buf = Buffer.alloc(Math.min(PROBE, st.size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    probe = buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
  if (looksBinary(probe)) return null;
  return (
    `${file} is ${st.size} bytes (over hook.max_bytes ${maxBytes}); reading it whole would flood the context. ` +
    'Instead: eyes_run (cheap-eyes MCP) to have a cheap model extract or summarise it with checked line refs; ' +
    'Grep for the lines you need; or Read with offset/limit for a slice.'
  );
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const timer = setTimeout(() => process.exit(0), STDIN_TIMEOUT_MS);
  try {
    const input = JSON.parse(await readStdin());
    const reason = decide(input, await maxBytesFromConfig());
    if (reason) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n',
      );
    }
  } catch {
    // any hook error → allow (no output)
  }
  clearTimeout(timer);
  process.exitCode = 0;
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

// Run only as a script, not when imported by tests.
if (isMain()) await main();
