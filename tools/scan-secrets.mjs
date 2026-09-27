#!/usr/bin/env node
// Repository hygiene: fail on anything the masker would mask and on private LAN
// addresses (10/8, 172.16/12, 192.168/16). Scans the files git knows about (tracked
// plus untracked, not ignored); test/fixtures/ is skipped. Reports file:line and the
// rule, never the matched text, so the CI log does not repeat a leaked secret.
//
// The masker is built to over-mask, so code and tests that talk about tokens trip it:
// - in code files the key-value and Authorization rules are not counted (there they
//   match identifiers like `token = opts.token`); every token-shape rule still is;
// - a line carrying the marker scan-secrets:allow is skipped by the masker check;
// - the marker scan-secrets:allow-file in the first 3 lines skips the masker check for
//   the whole file (tests full of fake keys) — only under test/, ignored elsewhere;
// - package-lock.json gets the LAN check only: sha512 integrity strings look like
//   mixed-case tokens.
// The LAN check has no opt-out.
//
//   node tools/scan-secrets.mjs [file ...]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Masker } from '../src/mask.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP = [/^test\/fixtures\//];
const LAN_ONLY = new Set(['package-lock.json']);
const ALLOW = 'scan-secrets:allow';
const ALLOW_FILE = 'scan-secrets:allow-file';
const CODE = /\.(?:[cm]?js|sh)$/;
const CONTEXT_RULES = new Set(['kv_secret', 'auth_header']);
const PROBE = 8192;

const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const PRIVATE_V4 = new RegExp(
  String.raw`(?<![\d.])(?:10\.${OCTET}\.${OCTET}\.${OCTET}|172\.(?:1[6-9]|2\d|3[01])\.${OCTET}\.${OCTET}|192\.168\.${OCTET}\.${OCTET})(?!\d|\.\d)`,
);

function gitFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, PROBE).includes(0)) return null; // binary
  const text = buf.toString('utf8');
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r/g, '');
}

// scanText options for a repo-relative POSIX path.
export function fileOptions(rel) {
  return { lanOnly: LAN_ONLY.has(rel), code: CODE.test(rel), allowFile: rel.startsWith('test/') };
}

// [{ line, rules[] }] for one text; lanOnly skips the masker check, code drops the
// context rules, allowFile honours the allow-file marker.
export function scanText(text, { lanOnly = false, code = false, allowFile = false } = {}) {
  const lines = text.split('\n');
  const skipMask = lanOnly || (allowFile && lines.slice(0, 3).some((l) => l.includes(ALLOW_FILE)));
  const masked = skipMask ? new Map() : new Masker().maskEach(lines);
  const found = [];
  for (const [i, line] of lines.entries()) {
    const rules = [];
    const e = masked.get(i);
    if (e && e.text !== line && !line.includes(ALLOW)) {
      const hits = e.block ? [e.block.startsWith('pem:') ? 'pem' : 'kv_secret'] : Object.keys(e.hits);
      rules.push(...hits.filter((r) => !(code && CONTEXT_RULES.has(r))));
    }
    if (PRIVATE_V4.test(line)) rules.push('private_ipv4');
    if (rules.length) found.push({ line: i + 1, rules: [...new Set(rules)] });
  }
  return found;
}

const toPosix = (p) => p.split(path.sep).join('/');

function realNative(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

// A file named on the command line → { abs, rel, name }. Root and file are both
// resolved with the native realpath, so 8.3 short names (C:\Users\RUNNER~1) and long
// names compare equal. `rel` is the repo-relative POSIX path, or null for a file
// outside the repo (another drive included: path.relative then returns an absolute
// path); such a file is reported by the path as given and never counts as under test/.
function argTarget(arg, rootReal) {
  const abs = realNative(path.resolve(arg));
  const r = path.relative(rootReal, abs);
  const inside = r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
  return { abs, rel: inside ? toPosix(r) : null, name: inside ? toPosix(r) : arg };
}

function main(args) {
  const rootReal = realNative(ROOT);
  const targets = args.length
    ? args.map((a) => argTarget(a, rootReal))
    : gitFiles().map((r) => ({ abs: path.join(ROOT, r), rel: toPosix(r), name: toPosix(r) }));
  let findings = 0;
  let scanned = 0;
  const flagged = new Set();
  for (const { abs, rel, name } of targets) {
    if (rel !== null && SKIP.some((re) => re.test(rel))) continue;
    let text;
    try {
      if (!fs.statSync(abs).isFile()) continue;
      text = readText(abs);
    } catch (e) {
      // An unreadable file is a finding of that file, reported like any other.
      scanned++;
      console.log(`${name}: cannot read (${e.code ?? e.message})`);
      findings++;
      flagged.add(name);
      continue;
    }
    if (text === null) continue;
    scanned++;
    const opts = rel === null ? { lanOnly: false, code: CODE.test(abs), allowFile: false } : fileOptions(rel);
    for (const f of scanText(text, opts)) {
      console.log(`${name}:${f.line}: ${f.rules.join(', ')}`);
      findings++;
      flagged.add(name);
    }
  }
  console.log(
    findings
      ? `scan-secrets: ${findings} finding(s) in ${flagged.size} of ${scanned} file(s)`
      : `scan-secrets: ${scanned} file(s) clean`,
  );
  return findings ? 1 : 0;
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

// Run only as a script, not when imported by tests.
if (isMain()) process.exitCode = main(process.argv.slice(2));
