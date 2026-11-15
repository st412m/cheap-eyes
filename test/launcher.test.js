// Values a launcher passes (a desktop extension, a container): an empty or unfilled
// key is no key; the proxy of the extension goes through CHEAP_EYES_HTTPS_PROXY, switched
// on in the same process or by a restart of the stdio server; the refusals name the
// launcher's own settings. No network.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CONTAINER_UI, configErrorAction, EXTENSION_UI, HA_APP_UI, noKeyText, proxyDescription, proxyFailText, proxyState, regionBlockedText, rootsAction, settingAction } from '../src/actions.js';
import { checkConfig } from '../src/check-config.js';
import { ConfigError, hasOpenRouterKey, openRouterKey, parseConfig } from '../src/config.js';
import { proxyFor } from '../src/input/url.js';
import { clearCatalogCache } from '../src/openrouter.js';
import { eyesRun } from '../src/run.js';
import { eyesStats } from '../src/stats.js';
import { launcherProxyPlan, restartStdio, switchOnInProcess } from '../src/stdio-proxy.js';
import { CLI_ARGS, isolatedEnv, tmpDir } from './helpers.js';

const PLACEHOLDER_KEY = '${user_config.openrouter_key}';

// ---- the key ----

test('openRouterKey: an empty value or an unfilled placeholder is no key', () => {
  assert.equal(openRouterKey({}), null);
  assert.equal(openRouterKey({ CHEAP_EYES_OPENROUTER_KEY: '' }), null);
  assert.equal(openRouterKey({ CHEAP_EYES_OPENROUTER_KEY: PLACEHOLDER_KEY }), null);
  assert.equal(openRouterKey({ CHEAP_EYES_OPENROUTER_KEY: 'FAKE-real-key' }), 'FAKE-real-key');
  assert.equal(hasOpenRouterKey({ CHEAP_EYES_OPENROUTER_KEY: PLACEHOLDER_KEY }), false);
});

test('eyes_run and eyes_stats never send a placeholder key to OpenRouter', async () => {
  const d = tmpDir();
  const f = path.join(d, 'a.md');
  fs.writeFileSync(f, 'alpha\n');
  const ctx = { config: parseConfig({ read_roots: [d] }), stateDir: { path: path.join(d, 'state') }, resultsDir: path.join(d, 'state', 'results') };
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.authorization ?? null });
    throw new TypeError('offline');
  };
  const saved = process.env.CHEAP_EYES_OPENROUTER_KEY;
  process.env.CHEAP_EYES_OPENROUTER_KEY = PLACEHOLDER_KEY;
  try {
    clearCatalogCache();
    await assert.rejects(eyesRun({ task: 't', mode: 'extract', files: [f] }, ctx, { fetch }), /OpenRouter key is not set/);
    const stats = await eyesStats({}, ctx, { fetch });
    assert.match(stats, /missing: OpenRouter key is not set/);
    assert.match(stats, /key: not set/);
  } finally {
    if (saved === undefined) delete process.env.CHEAP_EYES_OPENROUTER_KEY;
    else process.env.CHEAP_EYES_OPENROUTER_KEY = saved;
  }
  assert.ok(calls.every((c) => c.auth === null), JSON.stringify(calls));
});

// ---- the proxy of a stdio server ----

test('Node itself refuses to start with HTTPS_PROXY set to an unfilled placeholder; an empty value goes direct', { skip: !/^(2[3-9]|22\.(2[1-9]|[3-9]\d))/.test(process.versions.node) && 'needs Node with NODE_USE_ENV_PROXY' }, () => {
  const base = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_USE_ENV_PROXY: '1' };
  const bad = spawnSync(process.execPath, ['-e', 'console.log("started")'], { env: { ...base, HTTPS_PROXY: '${user_config.https_proxy}' }, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /ERR_INVALID_URL/);
  assert.doesNotMatch(bad.stdout, /started/);
  const empty = spawnSync(process.execPath, ['-e', 'console.log("started")'], { env: { ...base, HTTPS_PROXY: '' }, encoding: 'utf8' });
  assert.equal(empty.status, 0, empty.stderr);
});

const NO_SET_GLOBAL = { nodeVersion: '22.22.0', setGlobal: null };

test('launcherProxyPlan: in this process when Node has setGlobalProxyFromEnv, a restart on Node 22.21+ without it, else an error', () => {
  const setGlobal = () => () => {};
  const inProcess = launcherProxyPlan({ CHEAP_EYES_HTTPS_PROXY: ' http://proxy.test:3128 ' }, { nodeVersion: '24.22.1', setGlobal });
  assert.equal(inProcess.mode, 'in-process');
  assert.equal(inProcess.setGlobal, setGlobal);
  assert.deepEqual(inProcess.vars, { HTTPS_PROXY: 'http://proxy.test:3128', https_proxy: 'http://proxy.test:3128', NODE_USE_ENV_PROXY: '1', CHEAP_EYES_PROXY_VIA: 'in-process' });
  const restart = launcherProxyPlan({ CHEAP_EYES_HTTPS_PROXY: 'http://proxy.test:3128', X: '1' }, NO_SET_GLOBAL);
  assert.equal(restart.mode, 'restart');
  assert.equal(restart.env.HTTPS_PROXY, 'http://proxy.test:3128');
  assert.equal(restart.env.https_proxy, 'http://proxy.test:3128');
  assert.equal(restart.env.NODE_USE_ENV_PROXY, '1');
  assert.equal(restart.env.X, '1');
  assert.equal(launcherProxyPlan(restart.env, NO_SET_GLOBAL), null, 'the restarted child does not restart again');
  assert.match(launcherProxyPlan({ CHEAP_EYES_HTTPS_PROXY: 'http://p.test:1' }, { nodeVersion: '22.17.0', setGlobal: null }).error, /Node 22\.17\.0 cannot use a proxy \(it needs Node 24\.14 or newer, or 22\.21 or newer\)/);
  for (const v of [undefined, '', '${user_config.https_proxy}']) assert.equal(launcherProxyPlan(v === undefined ? {} : { CHEAP_EYES_HTTPS_PROXY: v }, { setGlobal }), null, JSON.stringify(v));
  const bad = launcherProxyPlan({ CHEAP_EYES_HTTPS_PROXY: 'proxy.test:3128 with FAKE-secret' }, { setGlobal });
  assert.match(bad.error, /CHEAP_EYES_HTTPS_PROXY is not an http:\/\/ or https:\/\/ URL/);
  assert.ok(!bad.error.includes('FAKE-secret'));
});

test('both ways the readers of the proxy see the same: Node agents, proxyState, the URL fetch, the state line', () => {
  const proxy = 'http://proxy.test:3128';
  // An inherited proxy (as a desktop app passes its system proxy) is replaced by the launcher's.
  const inherited = { CHEAP_EYES_HTTPS_PROXY: proxy, HTTPS_PROXY: 'http://192.0.2.7:8080', https_proxy: 'http://192.0.2.7:8080', NO_PROXY: 'localhost' };
  const target = { ...inherited };
  const calls = [];
  const plan = launcherProxyPlan(target, { setGlobal: (env) => calls.push({ ...env }) });
  assert.equal(switchOnInProcess(plan, target), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].HTTPS_PROXY, proxy);
  assert.equal(calls[0].https_proxy, proxy);
  assert.equal(calls[0].NO_PROXY, 'localhost', 'the rest of the environment is passed as it is');
  const restart = launcherProxyPlan({ ...inherited }, NO_SET_GLOBAL).env;
  const u = new URL('https://example.com/');
  for (const [env, via] of [[target, 'switched on in this process'], [restart, 'in a restarted process']]) {
    assert.equal(proxyState(env, [], '24.22.1'), 'HTTPS_PROXY set');
    assert.deepEqual(proxyFor(u, env, '24.22.1', []), { host: 'proxy.test' });
    assert.equal(proxyDescription(env, [], '24.22.1'), `HTTPS_PROXY set (from CHEAP_EYES_HTTPS_PROXY, ${via})`);
  }
  assert.equal(launcherProxyPlan(target, { setGlobal: () => {} }), null, 'switched on once');
});

test('switchOnInProcess: a failing setGlobalProxyFromEnv puts the variables back and says why', () => {
  const target = { CHEAP_EYES_HTTPS_PROXY: 'http://proxy.test:3128', HTTPS_PROXY: 'http://192.0.2.7:8080' };
  const plan = launcherProxyPlan(target, {
    setGlobal: () => {
      throw Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' });
    },
  });
  assert.equal(switchOnInProcess(plan, target), 'http.setGlobalProxyFromEnv failed (ERR_INVALID_URL)');
  assert.deepEqual(target, { CHEAP_EYES_HTTPS_PROXY: 'http://proxy.test:3128', HTTPS_PROXY: 'http://192.0.2.7:8080' });
  assert.match(proxyFailText('x', { CHEAP_EYES_SETTINGS_UI: EXTENSION_UI }), /could not be switched on: x\.\nto fix: empty the Proxy field in the extension settings in Claude Desktop to connect directly/);
});

// A child process for restartStdio: stdin and stdout streams, events by hand.
function fakeChild() {
  const c = new EventEmitter();
  c.stdin = new PassThrough();
  c.stdout = new PassThrough();
  c.kill = () => true;
  return c;
}

function relay(child, more = {}) {
  const stdin = new PassThrough();
  const out = [];
  const stdout = { write: (c) => out.push(String(c)) };
  const seen = { exit: null, fail: null, spawnArgs: null };
  restartStdio({ X: '1' }, ['/data'], {
    spawnFn: (file, args, o) => {
      seen.spawnArgs = { file, args, o };
      return child;
    },
    stdin,
    stdout,
    execPath: '/opt/app/app.exe',
    execArgv: [],
    versions: { node: '22.22.0', electron: '45.2.1' },
    exit: (code) => (seen.exit = code),
    signals: new EventEmitter(),
    onFail: (why, input) => (seen.fail = { why, input }),
    ...more,
  });
  return { stdin, out, seen };
}

const readAll = (s) => new Promise((resolve) => {
  let t = '';
  s.on('data', (d) => (t += d));
  s.on('end', () => resolve(t));
});

test('restartStdio relays stdin and stdout; once the child has answered, its exit code is ours', async () => {
  const child = fakeChild();
  const { stdin, out, seen } = relay(child);
  assert.deepEqual(seen.spawnArgs.o.stdio, ['pipe', 'pipe', 'inherit']);
  assert.equal(seen.spawnArgs.o.env.X, '1');
  assert.ok(seen.spawnArgs.args.includes('--disable-warning=UNDICI-EHPA'));
  const got = [];
  child.stdin.on('data', (d) => got.push(String(d)));
  stdin.write('{"id":1}\n');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, ['{"id":1}\n']);
  child.stdout.write('{"result":1}\n');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(out, ['{"result":1}\n']);
  child.emit('exit', 3, null);
  assert.equal(seen.exit, 3);
  assert.equal(seen.fail, null);
});

test('restartStdio: a child that cannot start, or ends before it answers, leaves the client to this process with what it sent', async () => {
  for (const end of [(c) => c.emit('error', Object.assign(new Error('spawn refused'), { code: 'ENOENT' })), (c) => c.emit('exit', 0, null)]) {
    const child = fakeChild();
    const { stdin, out, seen } = relay(child);
    stdin.write('{"method":"initialize"}\n');
    await new Promise((r) => setImmediate(r));
    end(child);
    assert.equal(seen.exit, null, 'this process does not exit');
    assert.ok(seen.fail);
    assert.match(seen.fail.why, /(the server could not be started again \(ENOENT\)|the restarted server ended \(exit code 0\) before it answered); this Node is app\.exe \(Electron 45\.2\.1, Node 22\.22\.0\)/);
    stdin.end('{"method":"tools/list"}\n');
    assert.equal(await readAll(seen.fail.input), '{"method":"initialize"}\n{"method":"tools/list"}\n');
    assert.deepEqual(out, []);
  }
});

function startCli(env, args = [], nodeArgs = []) {
  const child = spawn(process.execPath, [...nodeArgs, ...CLI_ARGS, ...args], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  const nonJson = [];
  const pending = new Map();
  child.stderr.on('data', (d) => (stderr += d));
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      nonJson.push(line);
      return;
    }
    pending.get(msg.id)?.(msg);
  });
  let id = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const t = setTimeout(() => reject(new Error(`timeout on ${method}; stderr: ${stderr}`)), 15000);
      pending.set(n, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    });
  const stop = () =>
    new Promise((resolve) => {
      child.once('exit', (code) => resolve(code));
      child.stdin.end();
    });
  return { request, stop, stderr: () => stderr, nonJson };
}

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } };

function launcherEnv(d, extra) {
  return isolatedEnv(path.join(d, 'home'), { HOME: path.join(d, 'home'), USERPROFILE: path.join(d, 'home'), CHEAP_EYES_STATE_DIR: path.join(d, 'state'), ...extra });
}

const PROXY_RUNTIME = ['--import', pathToFileURL(path.join(import.meta.dirname, 'fixtures', 'proxy-runtime.mjs')).href];
const FAKE_PROXY = 'http://FAKE-login:FAKE-pass@127.0.0.1:9'; // fake, scan-secrets:allow

const waitFor = async (srv, re) => {
  for (let i = 0; i < 100 && !re.test(srv.stderr()); i++) await new Promise((r) => setTimeout(r, 50));
};

test('stdio on a Node without setGlobalProxyFromEnv starts again through the proxy; stdin and stdout pass through this process', async () => {
  const d = tmpDir();
  const srv = startCli(launcherEnv(d, { CHEAP_EYES_HTTPS_PROXY: FAKE_PROXY, FIXTURE_PROXY_RUNTIME: 'no-global-proxy' }), [d], PROXY_RUNTIME);
  try {
    const init = await srv.request('initialize', INIT);
    assert.equal(init.result.serverInfo.name, 'cheap-eyes');
    const list = await srv.request('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['eyes_result', 'eyes_run', 'eyes_stats']);
    await waitFor(srv, /on stdio/);
    assert.match(srv.stderr(), /cheap-eyes: Node \S+ has no http\.setGlobalProxyFromEnv: starting again through the proxy in CHEAP_EYES_HTTPS_PROXY/);
    assert.match(srv.stderr(), /on stdio; .*; Node \S+; proxy: HTTPS_PROXY set \(from CHEAP_EYES_HTTPS_PROXY, in a restarted process\)/);
    assert.doesNotMatch(srv.stderr(), /UNDICI-EHPA/);
    assert.ok(!srv.stderr().includes('FAKE-pass'), 'the proxy URL is never printed');
  } finally {
    assert.equal(await srv.stop(), 0);
  }
  assert.deepEqual(srv.nonJson, [], 'nothing but JSON-RPC on stdout');
});

test('stdio on a Node with setGlobalProxyFromEnv switches the proxy on in the same process', async () => {
  const d = tmpDir();
  const srv = startCli(launcherEnv(d, { CHEAP_EYES_HTTPS_PROXY: FAKE_PROXY, FIXTURE_PROXY_RUNTIME: 'fake-global-proxy' }), [d], PROXY_RUNTIME);
  try {
    await srv.request('initialize', INIT);
    const r = await srv.request('tools/call', { name: 'eyes_stats', arguments: {} });
    assert.match(r.result.content[0].text, /^runtime: Node \S+; proxy: HTTPS_PROXY set \(from CHEAP_EYES_HTTPS_PROXY, switched on in this process\)$/m);
    await waitFor(srv, /on stdio/);
    assert.match(srv.stderr(), /fixture: setGlobalProxyFromEnv called; NODE_USE_ENV_PROXY=1/);
    assert.doesNotMatch(srv.stderr(), /starting again/);
    assert.match(srv.stderr(), /on stdio; .*; proxy: HTTPS_PROXY set \(from CHEAP_EYES_HTTPS_PROXY, switched on in this process\)/);
    assert.ok(!srv.stderr().includes('FAKE-pass') && !r.result.content[0].text.includes('FAKE-pass'));
  } finally {
    assert.equal(await srv.stop(), 0);
  }
});

test('stdio whose restart through the proxy ends at once stays up in the setup state and says why', async () => {
  const d = tmpDir();
  const srv = startCli(launcherEnv(d, { CHEAP_EYES_HTTPS_PROXY: FAKE_PROXY, FIXTURE_PROXY_RUNTIME: 'restart-child-exits', CHEAP_EYES_SETTINGS_UI: EXTENSION_UI }), [d], PROXY_RUNTIME);
  try {
    const init = await srv.request('initialize', INIT);
    assert.equal(init.result.serverInfo.name, 'cheap-eyes');
    const list = await srv.request('tools/list', {});
    assert.equal(list.result.tools.length, 3);
    const r = await srv.request('tools/call', { name: 'eyes_stats', arguments: {} });
    assert.equal(r.result.isError, true);
    const text = r.result.content[0].text;
    assert.match(text, /the proxy in CHEAP_EYES_HTTPS_PROXY could not be switched on: the restarted server ended \(exit code 0\) before it answered; this Node is \S+ \(Node [\d.]+\)\. Node [\d.]+ has no http\.setGlobalProxyFromEnv/);
    assert.match(text, /to fix: run cheap-eyes on Node 24\.14 or newer, or empty the Proxy field in the extension settings in Claude Desktop to connect directly, and restart the server/);
    assert.match(text, /\nNode [\d.]+; proxy: /);
    assert.match(srv.stderr(), /the restart through the proxy failed/);
    assert.ok(!text.includes('FAKE-pass') && !srv.stderr().includes('FAKE-pass'));
  } finally {
    assert.equal(await srv.stop(), 0);
  }
  assert.deepEqual(srv.nonJson, []);
});

test('stdio with an empty or unfilled CHEAP_EYES_HTTPS_PROXY serves directly; a bad value puts it in the setup state', async () => {
  for (const v of ['', '${user_config.https_proxy}']) {
    const d = tmpDir();
    const srv = startCli(launcherEnv(d, { CHEAP_EYES_HTTPS_PROXY: v }), [d]);
    try {
      await srv.request('initialize', INIT);
      await waitFor(srv, /on stdio/);
      assert.doesNotMatch(srv.stderr(), /starting again through the proxy/, JSON.stringify(v));
      assert.match(srv.stderr(), /; proxy: direct$/m);
    } finally {
      assert.equal(await srv.stop(), 0);
    }
  }
  const d = tmpDir();
  const srv = startCli(launcherEnv(d, { CHEAP_EYES_HTTPS_PROXY: 'not a url FAKE-pass', CHEAP_EYES_SETTINGS_UI: 'the extension settings in Claude Desktop' }), [d]);
  try {
    await srv.request('initialize', INIT);
    const r = await srv.request('tools/call', { name: 'eyes_stats', arguments: {} });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /CHEAP_EYES_HTTPS_PROXY is not an http:\/\/ or https:\/\/ URL\nto fix: fix the value in the extension settings in Claude Desktop \(environment variable CHEAP_EYES_HTTPS_PROXY\)/);
    assert.ok(!r.result.content[0].text.includes('FAKE-pass'));
  } finally {
    assert.equal(await srv.stop(), 0);
  }
});

test('a 403 with a settings UI points to its proxy setting, whatever HTTPS_PROXY the process inherited', () => {
  // A desktop app passes its own system proxy; without NODE_USE_ENV_PROXY Node ignores it.
  const inherited = { HTTPS_PROXY: 'http://192.0.2.7:8080', HTTP_PROXY: 'http://192.0.2.7:8080', NO_PROXY: 'localhost' };
  const ext = regionBlockedText({ ...inherited, CHEAP_EYES_SETTINGS_UI: EXTENSION_UI });
  assert.equal(ext, 'OpenRouter refuses requests from this network (some regions are blocked). A proxy is needed: fill the Proxy field in the extension settings in Claude Desktop (http://host:port) and restart the server');
  assert.doesNotMatch(ext, /NODE_USE_ENV_PROXY|192\.0\.2/);
  assert.match(regionBlockedText({ CHEAP_EYES_SETTINGS_UI: HA_APP_UI }), /: fill the https_proxy option in the app options in Home Assistant \(http:\/\/host:port\) and restart the server$/);
  const inUse = regionBlockedText({ CHEAP_EYES_SETTINGS_UI: EXTENSION_UI, CHEAP_EYES_HTTPS_PROXY: 'http://proxy.test:3128', HTTPS_PROXY: 'http://proxy.test:3128', NODE_USE_ENV_PROXY: '1', CHEAP_EYES_PROXY_VIA: 'in-process' });
  assert.match(inUse, /the proxy in use is refused too: put a proxy in another region into the Proxy field in the extension settings in Claude Desktop/);
  assert.match(regionBlockedText({ CHEAP_EYES_SETTINGS_UI: 'the settings page' }), /fill the proxy setting in the settings page/);
  assert.match(regionBlockedText(inherited), /the proxy is not in use: HTTPS_PROXY is set, but without NODE_USE_ENV_PROXY=1 Node ignores it/, 'without a settings UI the inherited variable is still named');
});

test('eyes_stats names the runtime and the proxy path, never the proxy URL', async () => {
  const d = tmpDir();
  const ctx = { config: parseConfig({ read_roots: [d] }), stateDir: { path: path.join(d, 'state') }, resultsDir: path.join(d, 'state', 'results') };
  const env = { CHEAP_EYES_HTTPS_PROXY: FAKE_PROXY, HTTPS_PROXY: FAKE_PROXY, https_proxy: FAKE_PROXY, NODE_USE_ENV_PROXY: '1', CHEAP_EYES_PROXY_VIA: 'in-process' };
  const text = await eyesStats({}, ctx, { key: null, env, versions: { node: '24.22.1', electron: '45.2.1' } });
  assert.match(text, /^runtime: Node 24\.22\.1 \(built into an application: Electron 45\.2\.1\); proxy: HTTPS_PROXY set \(from CHEAP_EYES_HTTPS_PROXY, switched on in this process\)$/m);
  assert.ok(!text.includes('FAKE-pass'));
  const plain = await eyesStats({}, ctx, { key: null, env: {}, versions: { node: '22.22.0' } });
  assert.match(plain, /^runtime: Node 22\.22\.0; proxy: direct$/m);
});

test('check-config shows the proxy the stdio server would use and fails on one it cannot', async () => {
  const d = tmpDir();
  const base = launcherEnv(d, { CHEAP_EYES_READ_ROOTS: d });
  const env = { ...base, CHEAP_EYES_HTTPS_PROXY: FAKE_PROXY };
  const calls = [];
  const on = await checkConfig({ env, proxyPlan: launcherProxyPlan(env, { setGlobal: (e) => calls.push(e.HTTPS_PROXY) }) });
  assert.equal(on.code, 0, on.text);
  assert.match(on.text, /^proxy: {10}HTTPS_PROXY set \(from CHEAP_EYES_HTTPS_PROXY, switched on in this process\)$/m);
  assert.match(on.text, /^runtime: {8}Node /m);
  assert.deepEqual(calls, [FAKE_PROXY]);
  const env2 = { ...base, CHEAP_EYES_HTTPS_PROXY: FAKE_PROXY };
  const restart = await checkConfig({ env: env2, proxyPlan: launcherProxyPlan(env2, NO_SET_GLOBAL) });
  assert.match(restart.text, /^proxy: {10}direct in this process; CHEAP_EYES_HTTPS_PROXY is set: the stdio server starts itself again through it/m);
  const env3 = { ...base, CHEAP_EYES_HTTPS_PROXY: 'not a url' };
  const bad = await checkConfig({ env: env3, proxyPlan: launcherProxyPlan(env3) });
  assert.equal(bad.code, 1);
  assert.match(bad.text, /^ERROR: the proxy cannot be used$/m);
  for (const r of [on, restart, bad]) assert.ok(!r.text.includes('FAKE-pass'));
});

// ---- refusals inside the Docker image ----

test('inside the Docker image the refusals name the variable or the mount', () => {
  const loaded = { settingsUi: CONTAINER_UI, sources: { read_roots: 'env CHEAP_EYES_READ_ROOTS', daily_budget_usd: 'default' }, config: { read_roots: ['/input'] } };
  const env = { CHEAP_EYES_SETTINGS_UI: CONTAINER_UI };
  assert.equal(
    rootsAction(loaded),
    'mount a folder of the host under /input (docker run -v /folder/on/host:/input/name:ro, or a volumes: line in compose.yaml), then recreate the container (docker compose up -d, or docker run again)',
  );
  assert.equal(
    settingAction('daily_budget_usd', loaded, '<usd>'),
    'set CHEAP_EYES_DAILY_BUDGET_USD=<usd> (or off) in the environment of the container (docker run -e, or environment: in compose.yaml), then recreate the container (docker compose up -d, or docker run again)',
  );
  assert.match(settingAction('max_files', loaded), /^mount a settings file into the container, set CHEAP_EYES_CONFIG to its path inside the container and set max_files in it/);
  assert.equal(
    noKeyText(env),
    'OpenRouter key is not set: set CHEAP_EYES_OPENROUTER_KEY=<key> in the environment of the container (docker run -e, or environment: in compose.yaml), then recreate the container (docker compose up -d, or docker run again); with compose, the .env file next to compose.yaml is the place',
  );
  assert.match(regionBlockedText(env), /A proxy is needed: set HTTPS_PROXY=<proxy URL> and NODE_USE_ENV_PROXY=1 in the environment of the container, then recreate the container/);
  assert.match(configErrorAction(new ConfigError('x', { kind: 'env', envVar: 'CHEAP_EYES_DAILY_BUDGET_USD' }), CONTAINER_UI), /^fix the environment variable CHEAP_EYES_DAILY_BUDGET_USD of the container, then recreate/);
});

test('inside the Docker image a path outside /input is refused with the mount to add', async () => {
  const d = tmpDir();
  const env = launcherEnv(d, { CHEAP_EYES_READ_ROOTS: path.join(d, 'input'), CHEAP_EYES_SETTINGS_UI: CONTAINER_UI });
  fs.mkdirSync(path.join(d, 'input'));
  fs.writeFileSync(path.join(d, 'x.md'), 'x\n');
  const srv = startCli(env);
  try {
    await srv.request('initialize', INIT);
    const r = await srv.request('tools/call', { name: 'eyes_run', arguments: { mode: 'grep', files: [path.join(d, 'x.md')], grep: { pattern: 'x' } } });
    assert.match(r.result.content[0].text, /outside read roots: .*x\.md; read roots: .*input\. To add one: mount a folder of the host under .*input \(docker run -v \/folder\/on\/host:.*input\/name:ro, or a volumes: line in compose\.yaml\)/);
  } finally {
    await srv.stop();
  }
});
