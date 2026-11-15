// `cheap-eyes init` and `check-config --live` with scripted answers and a stubbed
// OpenRouter. No browser is opened, no fixed port is bound, nothing leaves the machine:
// the PKCE callback is a local request to the listener on 127.0.0.1. Fake keys and proxies only. scan-secrets:allow-file
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { checkConfig } from '../src/check-config.js';
import { displayArg, displayCommand, findCommand, runCommand, shimScript } from '../src/claude-cli.js';
import { findSettingsFile } from '../src/config.js';
import { claudeAddArgs, jsonBlock, parseInitArgs, RESTART_NODE_ARGS, restartArgv, runInit, withoutProxyArg } from '../src/init.js';
import { fmtPrice } from '../src/models.js';
import { clearCatalogCache } from '../src/openrouter.js';
import { pinPath, probeTable } from '../src/pick.js';
import { authUrl, challengeOf, keySettingsUrl, listenForCode } from '../src/pkce.js';
import { CLI_ARGS, isolatedEnv, tmpDir, writeJson } from './helpers.js';
import { openRouterStub, STUB_KEY } from './openrouter-stub.js';

const PROXY = 'http://FAKE-user:FAKE-pass@proxy.example.test:3128'; // fake, scan-secrets:allow

beforeEach(() => clearCatalogCache());

function place() {
  const base = tmpDir();
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  return { base, home, cwd, state: path.join(base, 'state') };
}

function baseEnv(s, extra = {}) {
  return isolatedEnv(s.home, { HOME: s.home, USERPROFILE: s.home, CHEAP_EYES_STATE_DIR: s.state, ...extra });
}

// A scripted terminal: answers in order; hidden answers are never shown.
function scriptedIo(s, o = {}) {
  const lines = [];
  const asked = [];
  const answers = [...(o.answers ?? [])];
  const hidden = [...(o.hidden ?? [])];
  const io = {
    out: (l = '') => lines.push(...String(l).split('\n')),
    isTTY: o.isTTY ?? true,
    ask: async (q) => {
      const a = answers.shift() ?? '';
      asked.push(q);
      lines.push(q + a);
      return a;
    },
    askHidden: async (q) => {
      asked.push(q);
      lines.push(q);
      return hidden.shift() ?? '';
    },
    env: o.env ?? baseEnv(s),
    cwd: s.cwd,
    homedir: s.home,
    fetch: o.fetch,
    now: () => Date.now(),
    platform: o.platform ?? 'win32',
    nodeVersion: o.nodeVersion ?? '24.11.0',
    openBrowser: o.openBrowser ?? (() => {}),
    listen: listenForCode,
    pkceTimeoutMs: o.pkceTimeoutMs ?? 5000,
    findClaude: () => (o.claude === undefined ? { kind: 'exe', file: 'C:\\claude.exe', command: 'C:\\claude.exe', prefix: [] } : o.claude),
    runCommand: o.runCommand ?? (async () => ({ code: 0 })),
    restart: o.restart ?? (async () => 0),
  };
  return { io, lines, asked, text: () => lines.join('\n') };
}

// A fresh connection per request, as a browser tab opening the link would make.
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

// The browser: follows the sign-in link back to the callback with a code. `wrongFirst`
// sends a callback with a wrong state before the right one.
function browser({ code = 'code-ok', wrongFirst = false, seen = [] } = {}) {
  return (url) => {
    const u = new URL(url);
    const cb = new URL(u.searchParams.get('callback_url'));
    cb.hostname = '127.0.0.1';
    const state = u.searchParams.get('state');
    setImmediate(async () => {
      if (wrongFirst) seen.push(await get(`${cb}?code=stolen&state=not-${state}`));
      seen.push(await get(`${cb}?code=${code}&state=${state}`));
    });
  };
}

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map((n) => path.join(dir, n)).filter((f) => fs.statSync(f).isFile());
}

function assertKeyNowhereOnDisk(s, key) {
  for (const f of [...filesUnder(s.state), ...filesUnder(s.home), ...filesUnder(s.cwd)]) assert.ok(!fs.readFileSync(f, 'utf8').includes(key), `key found in ${f}`);
}

// ---- a full run for Claude Code: proxy restart, browser sign-in, key without a limit ----

test('init for Claude Code: 403 → proxy → restart with the answers; browser sign-in; no-limit warning; pick; claude mcp add', async () => {
  const s = place();
  let proxied = false;
  const stub = openRouterStub({ region403: true, proxied: () => proxied, limit: null });
  const ran = [];
  const restarts = [];
  const seen = [];
  const child = { lines: [] };
  const first = scriptedIo(s, {
    fetch: stub.fetch,
    answers: [PROXY],
    restart: async (env, args) => {
      restarts.push({ env, args });
      proxied = env.HTTPS_PROXY === PROXY && env.NODE_USE_ENV_PROXY === '1';
      const c = scriptedIo(s, {
        env,
        fetch: stub.fetch,
        answers: ['1', '', '', ''],
        openBrowser: browser({ seen }),
        runCommand: async (found, a) => (ran.push(a), { code: 0 }),
      });
      const code = await runInit(args.slice(1), c.io);
      child.lines = c.lines;
      return code;
    },
  });
  const code = await runInit(['--client', 'claude-code'], first.io);
  assert.equal(code, 0, [...first.lines, ...child.lines].join('\n'));
  const all = [...first.lines, ...child.lines].join('\n');

  assert.equal(restarts.length, 1);
  assert.deepEqual(restarts[0].args, ['init', '--client', 'claude-code'], 'the answers given as flags are kept');
  assert.equal(restarts[0].env.CHEAP_EYES_INIT_PROXIED, '1');
  assert.match(first.text(), /OpenRouter refuses requests from this network \(some regions are blocked\)\. A proxy is needed\./);
  assert.match(child.lines.join('\n'), /continued through the proxy/);
  assert.match(child.lines.join('\n'), /sign-in runs in your browser, which does not use this proxy/);
  assert.deepEqual(seen, [200]);
  assert.match(all, /Signed in: OpenRouter created a key labelled "cheap-eyes"\./);
  assert.match(all, /WARNING: this key has no spending limit\. Set a limit on this key: it is the real spending ceiling\./);
  assert.ok(all.includes(keySettingsUrl(STUB_KEY)));
  assert.match(all, /account: 3 models allowed/);
  assert.match(all, /not available to this account: vendor\/guarded \(blocked by the account's guardrails or privacy settings — allow it at openrouter\.ai → Guardrails\)/);
  assert.match(all, /pinned: vendor\/small-a, vendor\/small-b; cap in \$1 \/ out \$4 per 1M/);
  assert.ok(fs.existsSync(pinPath(s.state)));

  assert.equal(ran.length, 1);
  assert.deepEqual(ran[0], [
    'mcp', 'add', '--scope', 'user',
    '--env', `CHEAP_EYES_OPENROUTER_KEY=${STUB_KEY}`,
    '--env', `HTTPS_PROXY=${PROXY}`,
    '--env', 'NODE_USE_ENV_PROXY=1',
    '--transport', 'stdio', 'cheap-eyes', '--', 'npx', '-y', 'cheap-eyes',
  ]);
  assert.match(all, /Claude Code keeps the key in its own settings file/);
  assert.match(all, /LIVE: OK/);

  assert.ok(!all.includes(STUB_KEY), 'the key is never printed when claude mcp add ran');
  assert.equal(first.lines.filter((l) => l.includes('FAKE-pass')).length, 1, 'only where the person typed it');
  assert.ok(!child.lines.join('\n').includes('FAKE-pass'), 'never printed back');
  assertKeyNowhereOnDisk(s, STUB_KEY);
  const exchange = stub.calls.find((c) => c.url.endsWith('/auth/keys'));
  assert.deepEqual(Object.keys(exchange.body).sort(), ['code', 'code_challenge_method', 'code_verifier']);
});

test('PKCE: a callback with a wrong state is refused and the right one is still accepted', async () => {
  const s = place();
  const seen = [];
  const stub = openRouterStub({ limit: 5 });
  const t = scriptedIo(s, { fetch: stub.fetch, answers: ['1', 'other', ''], openBrowser: browser({ wrongFirst: true, seen }) });
  assert.equal(await runInit([], t.io), 0, t.text());
  assert.deepEqual(seen, [400, 200]);
  assert.deepEqual(stub.calls.filter((c) => c.url.endsWith('/auth/keys')).map((c) => c.body.code), ['code-ok'], 'the stolen code is never exchanged');
  assert.doesNotMatch(t.text(), /WARNING: this key has no spending limit/);
});

test('PKCE: the sign-in link and the exchange carry the documented parameters; the verifier matches the challenge', async () => {
  const s = place();
  const stub = openRouterStub({ limit: 5 });
  let link = null;
  const t = scriptedIo(s, {
    fetch: stub.fetch,
    answers: ['1', 'other', ''],
    openBrowser: (url) => {
      link = new URL(url);
      browser()(url);
    },
  });
  assert.equal(await runInit([], t.io), 0, t.text());
  assert.equal(link.origin + link.pathname, 'https://openrouter.ai/auth');
  assert.match(link.searchParams.get('callback_url'), /^http:\/\/localhost:\d+\/callback$/);
  assert.equal(link.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(link.searchParams.get('key_label'), 'cheap-eyes');
  assert.match(link.searchParams.get('state'), /^[0-9a-f]{32}$/);
  const ex = stub.calls.find((c) => c.url === 'https://openrouter.ai/api/v1/auth/keys');
  assert.equal(ex.method, 'POST');
  assert.equal(ex.body.code_challenge_method, 'S256');
  assert.equal(challengeOf(ex.body.code_verifier), link.searchParams.get('code_challenge'));
  assert.ok(t.text().includes(link.toString()), 'the link is always printed');
});

test('PKCE: no answer within the limit ends the sign-in; the listener is closed', async () => {
  const s = place();
  const stub = openRouterStub();
  let cb = null;
  const t = scriptedIo(s, { fetch: stub.fetch, answers: ['1'], pkceTimeoutMs: 100, openBrowser: (url) => (cb = new URL(new URL(url).searchParams.get('callback_url'))) });
  assert.equal(await runInit([], t.io), 1);
  assert.match(t.text(), /Sign-in not finished: no answer from the browser within 0 s/);
  cb.hostname = '127.0.0.1';
  await assert.rejects(get(cb.toString()), /ECONNREFUSED/);
});

test('PKCE --no-browser: the headless link (no callback_url, no state) and a pasted code', async () => {
  const s = place();
  const stub = openRouterStub({ limit: 5 });
  let opened = false;
  const t = scriptedIo(s, { fetch: stub.fetch, answers: ['1', 'code-ok', 'other', ''], openBrowser: () => (opened = true) });
  assert.equal(await runInit(['--no-browser'], t.io), 0, t.text());
  assert.equal(opened, false);
  const line = t.lines.find((l) => l.includes('https://openrouter.ai/auth?'));
  const u = new URL(line.trim());
  assert.equal(u.searchParams.get('callback_url'), null);
  assert.equal(u.searchParams.get('state'), null);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.match(t.text(), /Signed in/);
});

test('paste: the key is read hidden, checked with GET /key and never printed', async () => {
  const s = place();
  const stub = openRouterStub({ limit: 10 });
  const t = scriptedIo(s, { fetch: stub.fetch, answers: ['2', 'other', ''], hidden: [STUB_KEY] });
  assert.equal(await runInit([], t.io), 0, t.text());
  assert.ok(t.asked.some((q) => /input hidden/.test(q)));
  assert.match(t.text(), /Key accepted; limit \$10, remaining \$9\.5\./);
  const keyLines = t.lines.filter((l) => l.includes(STUB_KEY));
  assert.ok(keyLines.length > 0 && keyLines.every((l) => /"CHEAP_EYES_OPENROUTER_KEY": /.test(l)), 'only inside the JSON block');
  const auth = stub.calls.find((c) => c.url.endsWith('/key')).auth;
  assert.equal(auth, `Bearer ${STUB_KEY}`);
  assertKeyNowhereOnDisk(s, STUB_KEY);
});

test('a refused key stops init without printing it', async () => {
  const s = place();
  const stub = openRouterStub({ keyStatus: 401 });
  const t = scriptedIo(s, { fetch: stub.fetch, answers: ['2'], hidden: [STUB_KEY] });
  assert.equal(await runInit([], t.io), 1);
  assert.match(t.text(), /The key was not accepted: GET \/key: HTTP 401/);
  assert.ok(!t.text().includes(STUB_KEY));
});

// ---- --yes and no terminal ----

test('--yes --client other: no question, the JSON block with the key, roots written, nothing run', async () => {
  const s = place();
  const stub = openRouterStub({ limit: 2 });
  const ran = [];
  const roots = path.join(s.base, 'notes');
  fs.mkdirSync(roots);
  const t = scriptedIo(s, { fetch: stub.fetch, env: baseEnv(s, { CHEAP_EYES_OPENROUTER_KEY: STUB_KEY }), isTTY: false, runCommand: async (f, a) => (ran.push(a), { code: 0 }) });
  assert.equal(await runInit(['--yes', '--client', 'other', '--roots', roots], t.io), 0, t.text());
  assert.deepEqual(t.asked, []);
  assert.deepEqual(ran, []);
  assert.ok(t.text().includes(jsonBlock(STUB_KEY, null).split('\n').map((l) => `  ${l}`).join('\n')));
  const { target } = findSettingsFile({ env: t.io.env, cwd: s.cwd, homedir: s.home });
  assert.ok(t.text().includes(`read_roots written to ${target.path}`), t.text());
  assert.deepEqual(JSON.parse(fs.readFileSync(target.path, 'utf8')), { read_roots: [roots] });
});

test('--client http: the serve command and the claude mcp add line for HTTP, in user scope', async () => {
  const s = place();
  const stub = openRouterStub({ limit: 2 });
  const t = scriptedIo(s, { fetch: stub.fetch, env: baseEnv(s, { CHEAP_EYES_OPENROUTER_KEY: STUB_KEY }), isTTY: false });
  assert.equal(await runInit(['--yes', '--client', 'http'], t.io), 0, t.text());
  assert.match(t.text(), /cheap-eyes serve --http/);
  assert.ok(t.lines.includes('  Claude Code: claude mcp add --scope user --transport http cheap-eyes http://127.0.0.1:3400/private_<token>/mcp'), t.text());
  assert.ok(t.lines.includes('  Without --scope user, Claude Code adds the server for the current folder only.'));
});

test('--yes never runs claude mcp add: the command is printed for the person', async () => {
  const s = place();
  const ran = [];
  const t = scriptedIo(s, { fetch: openRouterStub({ limit: 2 }).fetch, env: baseEnv(s, { CHEAP_EYES_OPENROUTER_KEY: STUB_KEY }), runCommand: async (f, a) => (ran.push(a), { code: 0 }) });
  assert.equal(await runInit(['--yes', '--client', 'claude-code'], t.io), 0, t.text());
  assert.deepEqual(ran, []);
  assert.match(t.text(), /--yes never runs claude mcp add\. Run this yourself:/);
  assert.ok(t.text().includes(`claude mcp add --scope user --env CHEAP_EYES_OPENROUTER_KEY=${STUB_KEY} --transport stdio cheap-eyes -- npx -y cheap-eyes`));
});

test('no terminal and no --yes: a refusal that lists the flags; nothing is asked or fetched', async () => {
  const s = place();
  const stub = openRouterStub();
  const t = scriptedIo(s, { fetch: stub.fetch, isTTY: false });
  assert.equal(await runInit([], t.io), 2);
  assert.match(t.text(), /needs a terminal\. Without one, pass --yes and the answers as flags:/);
  for (const f of ['--client', '--roots', '--proxy', '--no-browser', '--yes']) assert.ok(t.text().includes(f), f);
  assert.equal(stub.calls.length, 0);
});

// ---- the proxy ----

test('--proxy restarts init through the proxy before any request; the URL is never printed', async () => {
  const s = place();
  const stub = openRouterStub();
  const restarts = [];
  const t = scriptedIo(s, { fetch: stub.fetch, restart: async (env, args) => (restarts.push({ env, args }), 7) });
  assert.equal(await runInit(['--proxy', PROXY, '--client', 'http'], t.io), 7);
  assert.deepEqual(restarts[0].args, ['init', '--client', 'http']);
  assert.equal(restarts[0].env.HTTPS_PROXY, PROXY);
  assert.equal(restarts[0].env.NODE_USE_ENV_PROXY, '1');
  assert.equal(stub.calls.length, 0);
  assert.ok(!t.text().includes('FAKE-pass'));
  assert.deepEqual(withoutProxyArg(['--yes', `--proxy=${PROXY}`, '--roots', 'a']), ['--yes', '--roots', 'a']);
});

test('a 403 through the proxy in use stops with the reason; an old Node cannot use a proxy', async () => {
  const s = place();
  const t = scriptedIo(s, { fetch: openRouterStub({ region403: true }).fetch, env: baseEnv(s, { HTTPS_PROXY: PROXY, NODE_USE_ENV_PROXY: '1', CHEAP_EYES_INIT_PROXIED: '1' }) });
  assert.equal(await runInit([], t.io), 1);
  assert.match(t.text(), /The proxy in use is refused too/);
  assert.ok(!t.text().includes('FAKE-pass'));
  const old = scriptedIo(s, { fetch: openRouterStub({ region403: true }).fetch, answers: [PROXY], nodeVersion: '22.17.0' });
  assert.equal(await runInit([], old.io), 1);
  assert.match(old.text(), /Node 22\.17\.0 cannot use a proxy for its own requests/);
});

// ---- the client step ----

test('claude not on PATH, an unknown shim, or a failed add: the command is printed with the reason', async () => {
  const run = async (claude, runCommand) => {
    const s = place();
    const t = scriptedIo(s, { fetch: openRouterStub({ limit: 2 }).fetch, env: baseEnv(s, { CHEAP_EYES_OPENROUTER_KEY: STUB_KEY }), claude, runCommand, answers: ['', '', ''] });
    await runInit(['--client', 'claude-code'], t.io);
    return t.text();
  };
  assert.match(await run(null), /`claude` is not on PATH\. When Claude Code is installed, run:\n  claude mcp add /);
  assert.match(await run({ kind: 'shim-unknown', file: 'C:\\npm\\claude.cmd' }), /claude\.cmd is a command shim that cannot be started without a shell, and the key must not pass through shell quoting/);
  assert.match(await run(undefined, async () => ({ code: 1 })), /claude mcp add did not succeed \(exit 1\)\. If a server named cheap-eyes exists already/);
});

test('settings that name models: nothing is picked; an existing pin is kept with --yes', async () => {
  const s = place();
  writeJson(path.join(s.cwd, 'cheap-eyes.json'), { models: { fast: { ids: ['vendor/small-b'] } }, defaults: { extract: 'fast' } });
  const stub = openRouterStub({ limit: 2 });
  const t = scriptedIo(s, { fetch: stub.fetch, env: baseEnv(s, { CHEAP_EYES_OPENROUTER_KEY: STUB_KEY }) });
  assert.equal(await runInit(['--yes', '--client', 'other'], t.io), 0, t.text());
  assert.match(t.text(), /The settings name models \(fast\): nothing to pick\./);
  assert.equal(stub.calls.filter((c) => c.url.endsWith('/chat/completions')).length, 0);
  const p = place();
  fs.mkdirSync(p.state, { recursive: true });
  fs.writeFileSync(pinPath(p.state), JSON.stringify({ picked_at: '2026-11-01T00:00:00.000Z', ids: ['vendor/small-c'], cap: { in: 1, out: 4 }, probe: [] }));
  const stub2 = openRouterStub({ limit: 2 });
  const k = scriptedIo(p, { fetch: stub2.fetch, env: baseEnv(p, { CHEAP_EYES_OPENROUTER_KEY: STUB_KEY }) });
  assert.equal(await runInit(['--yes', '--client', 'other'], k.io), 0, k.text());
  assert.match(k.text(), /Models pinned 2026-11-01: vendor\/small-c/);
  assert.equal(stub2.calls.filter((c) => c.url.endsWith('/chat/completions')).length, 0);
});

test('parseInitArgs: flags, roots, bad client', () => {
  assert.deepEqual(parseInitArgs(['--roots', 'a', 'b', '--yes']), { proxy: undefined, noBrowser: false, client: undefined, roots: ['a', 'b'], yes: true });
  assert.throws(() => parseInitArgs(['--client', 'vim']), /--client: one of claude-code, claude-desktop, other, http/);
  assert.throws(() => parseInitArgs(['stray']), /unexpected argument: stray/);
  assert.deepEqual(claudeAddArgs('K', null).slice(-7), ['--transport', 'stdio', 'cheap-eyes', '--', 'npx', '-y', 'cheap-eyes']);
});

test('the proxy restart starts node without the UNDICI-EHPA warning; other warnings still show', () => {
  const argv = restartArgv(['init', '--yes']);
  assert.deepEqual(argv.slice(0, 1), ['--disable-warning=UNDICI-EHPA']);
  assert.match(argv[1], /[\\/]src[\\/]cli\.js$/);
  assert.deepEqual(argv.slice(2), ['init', '--yes']);
  // A request through a proxy on a closed local port: the request fails, the warning
  // would be printed on it; nothing leaves the machine.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HTTPS_PROXY: 'http://127.0.0.1:9', NODE_USE_ENV_PROXY: '1' };
  const script = "fetch('https://example.invalid/').catch(() => {}).finally(() => process.emitWarning('still shown', 'Warning', 'CE-TEST'))";
  const r = spawnSync(process.execPath, [...RESTART_NODE_ARGS, '-e', script], { env, encoding: 'utf8', timeout: 20000 });
  assert.doesNotMatch(r.stderr, /UNDICI-EHPA/);
  assert.match(r.stderr, /\[CE-TEST\] Warning: still shown/);
});

// ---- PKCE parts ----

test('PKCE: S256 challenge (RFC 7636 example), headless link, key settings link', () => {
  assert.equal(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const h = new URL(authUrl({ challenge: 'c', state: 'ignored' }));
  assert.deepEqual([...h.searchParams.keys()], ['code_challenge', 'code_challenge_method', 'key_label']);
  assert.equal(keySettingsUrl('abc'), `https://openrouter.ai/keys/${createHash('sha256').update('abc').digest('hex')}`);
});

// Whether this machine has an IPv6 loopback to listen on.
function hasIpv6Loopback() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(0, '::1', () => s.close(() => resolve(true)));
  });
}

test('the callback listener: 127.0.0.1 and ::1 on the same free port; other paths 404', async () => {
  const v6 = await hasIpv6Loopback();
  const l = await listenForCode({ state: 's1', timeoutMs: 2000 });
  const port = new URL(l.url).port;
  assert.notEqual(port, '0');
  assert.deepEqual(l.hosts, v6 ? ['127.0.0.1', '::1'] : ['127.0.0.1']);
  assert.equal(await get(`http://127.0.0.1:${port}/other`), 404);
  if (v6) assert.equal(await get(`http://[::1]:${port}/other`), 404, 'the IPv6 loopback answers on the same port');
  assert.equal(await get(`http://${v6 ? '[::1]' : '127.0.0.1'}:${port}/callback?code=x&state=s1`), 200);
  assert.equal(await l.done, 'x');
  await assert.rejects(get(`http://127.0.0.1:${port}/other`), /ECONNREFUSED/);
  if (v6) await assert.rejects(get(`http://[::1]:${port}/other`), /ECONNREFUSED/, 'both are closed afterwards');
});

// http.createServer whose listen on ::1 fails with `code` the first `times` times.
function ipv6Failing(code, times = Infinity) {
  let left = times;
  return (handler) => {
    const s = http.createServer(handler);
    const listen = s.listen.bind(s);
    s.listen = (port, host, cb) => {
      if (host === '::1' && left-- > 0) {
        setImmediate(() => s.emit('error', Object.assign(new Error(code), { code })));
        return s;
      }
      return listen(port, host, cb);
    };
    return s;
  };
}

test('the callback listener without an IPv6 loopback listens on 127.0.0.1 alone, without an error', async () => {
  for (const code of ['EADDRNOTAVAIL', 'EAFNOSUPPORT']) {
    const l = await listenForCode({ state: 's2', timeoutMs: 2000, createServer: ipv6Failing(code) });
    assert.deepEqual(l.hosts, ['127.0.0.1'], code);
    assert.equal(await get(`http://127.0.0.1:${l.port}/callback?code=y&state=s2`), 200);
    assert.equal(await l.done, 'y');
  }
});

test('the callback listener tries another port when ::1 has the port taken', async () => {
  const l = await listenForCode({ state: 's3', timeoutMs: 2000, createServer: ipv6Failing('EADDRINUSE', 1) });
  assert.ok(l.hosts.includes('127.0.0.1'));
  assert.equal(await get(`http://127.0.0.1:${l.port}/callback?code=z&state=s3`), 200);
  assert.equal(await l.done, 'z');
});

test('PKCE: a callback without a code (access denied, no state) ends the sign-in at once', async () => {
  const s = place();
  let page = null;
  const t = scriptedIo(s, {
    fetch: openRouterStub().fetch,
    answers: ['1'],
    pkceTimeoutMs: 60_000,
    openBrowser: (url) => {
      const cb = new URL(new URL(url).searchParams.get('callback_url'));
      cb.hostname = '127.0.0.1';
      page = get(`${cb}`);
    },
  });
  const t0 = Date.now();
  assert.equal(await runInit([], t.io), 1);
  assert.ok(Date.now() - t0 < 5000, `no waiting for the time limit: ${Date.now() - t0} ms`);
  assert.equal(await page, 200, 'the page reached the browser');
  assert.match(t.text(), /Sign-in not finished: access was not granted \(OpenRouter returned no code\)\./);
});

test('PKCE: a callback with a code but a missing or wrong state is refused and not accepted', async () => {
  const l = await listenForCode({ state: 'right', timeoutMs: 2000 });
  const base = `http://127.0.0.1:${l.port}/callback`;
  assert.equal(await get(`${base}?code=c1`), 400);
  assert.equal(await get(`${base}?code=c2&state=wrong`), 400);
  assert.equal(await get(`${base}?code=c3&state=right`), 200);
  assert.equal(await l.done, 'c3');
});

// ---- claude without a shell ----

test('findCommand: an .exe is run as it is; an npm shim through node and its script; an unknown shim is not run', () => {
  const files = new Set(['C:\\bin\\claude.exe']);
  const exe = findCommand('claude', { env: { Path: 'C:\\bin', PATHEXT: '.COM;.EXE;.CMD' }, platform: 'win32', exists: (f) => files.has(f) });
  assert.deepEqual(exe, { kind: 'exe', file: 'C:\\bin\\claude.exe', command: 'C:\\bin\\claude.exe', prefix: [] });
  const shim = '@ECHO off\r\n...\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
  assert.equal(shimScript(shim, 'C:\\npm'), 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js');
  const npm = new Set(['C:\\npm\\claude.cmd', 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js']);
  const viaNode = findCommand('claude', { env: { Path: 'C:\\npm' }, platform: 'win32', exists: (f) => npm.has(f), readFile: () => shim, execPath: 'C:\\node\\node.exe' });
  assert.deepEqual(viaNode, { kind: 'script', file: 'C:\\npm\\claude.cmd', command: 'C:\\node\\node.exe', prefix: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'] });
  const odd = findCommand('claude', { env: { Path: 'C:\\x' }, platform: 'win32', exists: (f) => f === 'C:\\x\\claude.cmd', readFile: () => '@echo off\r\nsomething %*' });
  assert.deepEqual(odd, { kind: 'shim-unknown', file: 'C:\\x\\claude.cmd' });
  assert.equal(findCommand('claude', { env: { PATH: '/nowhere' }, platform: 'linux', exists: () => false }), null);
});

test('runCommand passes every argument unchanged, shell characters included (a script run through node)', async () => {
  const d = tmpDir();
  const script = path.join(d, 'echo-args.js');
  const outFile = path.join(d, 'args.json');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(process.argv.slice(2)));`);
  const args = ['mcp', 'add', '--env', 'HTTPS_PROXY=http://u:p&a%b^c"d\'e@h:1', '--env', 'K=a b|c<d>e', 'name', '--', 'npx', '-y', 'cheap-eyes'];
  const r = await runCommand({ kind: 'script', command: process.execPath, prefix: [script] }, args);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(outFile, 'utf8')), args);
  assert.equal(displayArg('HTTPS_PROXY=http://u:p&a@h:1', 'win32'), "'HTTPS_PROXY=http://u:p&a@h:1'");
  assert.equal(displayArg("it's", 'win32'), "'it''s'");
  assert.equal(displayCommand('claude', ['mcp', 'add', 'x'], 'win32'), 'claude mcp add x');
});

// ---- prices shown to a person ----

test('prices are formatted: no floating-point tails in the pick table or elsewhere', () => {
  assert.equal(fmtPrice(0.5670000000000001), '$0.567');
  const line = probeTable([{ id: 'v/a', ok: true, reason: null, cost: 0.0001 }], [{ id: 'v/a', fitIn: 0.5670000000000001, fitOut: 1.2000000000000002 }])[0];
  assert.equal(line, '  ok     v/a  in $0.567 / out $1.2 per 1M  probe $0.000100');
});

// ---- check-config --live ----

function liveSetup(extra = {}) {
  const s = place();
  return { s, env: baseEnv(s, { CHEAP_EYES_OPENROUTER_KEY: STUB_KEY, ...extra }) };
}

test('check-config --live: reachable, key without limit with its settings link, account, pin usable; exit 0', async () => {
  const { s, env } = liveSetup();
  fs.mkdirSync(s.state, { recursive: true });
  fs.writeFileSync(pinPath(s.state), JSON.stringify({ picked_at: '2026-11-15T06:00:00.000Z', ids: ['vendor/small-b', 'vendor/gone'], cap: { in: 1, out: 4 }, probe: [] }));
  const r = await checkConfig({ env, cwd: s.cwd, homedir: s.home, live: true, fetch: openRouterStub({ limit: null }).fetch });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /\nlive checks:\n  proxy: +direct\n  openrouter: +reachable \(4 ZDR endpoints, 4 models\)\n/);
  assert.ok(r.text.includes(`  key:          valid; NO LIMIT: set a limit on this key: it is the real spending ceiling: ${keySettingsUrl(STUB_KEY)}`), r.text);
  assert.match(r.text, /  account: +3 models allowed/);
  assert.match(r.text, /  pin: +pinned 2026-11-15: vendor\/small-b usable; vendor\/gone not usable \(no ZDR endpoint\)/);
  assert.match(r.text, /LIVE: OK$/);
  assert.ok(!r.text.includes(STUB_KEY));
});

test('check-config --live fails without a key, with a refused key, and for an alias without a usable id', async () => {
  const nokey = liveSetup({ CHEAP_EYES_OPENROUTER_KEY: '' });
  const a = await checkConfig({ env: nokey.env, cwd: nokey.s.cwd, homedir: nokey.s.home, live: true, fetch: openRouterStub().fetch });
  assert.equal(a.code, 1);
  assert.match(a.text, /  key: +FAILED: OpenRouter key is not set/);
  const bad = liveSetup();
  const b = await checkConfig({ env: bad.env, cwd: bad.s.cwd, homedir: bad.s.home, live: true, fetch: openRouterStub({ keyStatus: 401 }).fetch });
  assert.equal(b.code, 1);
  assert.match(b.text, /  key: +FAILED: GET \/key: HTTP 401/);
  const named = liveSetup();
  writeJson(path.join(named.s.cwd, 'cheap-eyes.json'), { models: { old: { ids: ['vendor/retired'] } } });
  const c = await checkConfig({ env: named.env, cwd: named.s.cwd, homedir: named.s.home, live: true, fetch: openRouterStub({ limit: 3 }).fetch });
  assert.equal(c.code, 1);
  assert.match(c.text, /  alias old: +FAILED: no usable id: vendor\/retired not usable \(no ZDR endpoint\)/);
  assert.match(c.text, /LIVE: FAILED$/);
});

test('plain check-config stays offline; check-config --live and init from the command line', () => {
  const s = place();
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...baseEnv(s, { CHEAP_EYES_OPENROUTER_KEY: STUB_KEY }) };
  const run = (args) => spawnSync(process.execPath, [...CLI_ARGS, ...args], { env, cwd: s.cwd, encoding: 'utf8' });
  const plain = run(['check-config']);
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.doesNotMatch(plain.stdout, /live checks/);
  const live = run(['check-config', '--live']);
  assert.equal(live.status, 1);
  assert.match(live.stdout, /  openrouter: +FAILED: GET \/endpoints\/zdr: .*network is disabled in tests/);
  assert.ok(!(live.stdout + live.stderr).includes(STUB_KEY));
  const init = run(['init']);
  assert.equal(init.status, 2);
  assert.match(init.stdout, /needs a terminal/);
});
