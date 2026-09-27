// Fake keys and tokens only. scan-secrets:allow-file
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { authorize, createHttpHandler, isLocalBind, sameSecret, validateToken } from '../src/http.js';
import { CLI_ARGS, isolatedEnv, tmpDir, writeJson } from './helpers.js';

const TOKEN = 'FAKE-test-token-0123456789abcdefghijklmnop';
const logs = [];
let base;
let server;
let d;
let ctx;

before(async () => {
  d = tmpDir();
  const root = path.join(d, 'notes');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.md'), 'hello\n');
  const config = parseConfig({ read_roots: [root] });
  const stateDir = path.join(d, 'state');
  ctx = { config, stateDir: { path: stateDir }, resultsDir: path.join(stateDir, 'results') };
  // A localhost bind: the Host/Origin guards are armed.
  server = http.createServer(createHttpHandler(ctx, { token: TOKEN, host: '127.0.0.1', log: (m) => logs.push(m) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

// A 2026-07-28 request: the _meta envelope in the body (protocolVersion and
// clientCapabilities are required) mirrored into MCP-Protocol-Version / Mcp-Method /
// Mcp-Name headers, per the spec's Streamable HTTP binding.
const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 't', version: '0' },
};
function modern(id, method, params = {}) {
  const headers = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': method };
  if (method === 'tools/call') headers['mcp-name'] = params.name;
  return { body: { jsonrpc: '2.0', id, method, params: { ...params, _meta: MODERN_META } }, headers };
}

// Raw request, so Host and Origin can be set.
function raw(port, p, { host, origin, body = INIT } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (host) headers.host = host;
    if (origin) headers.origin = origin;
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function rpc(p, body, headers = {}) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  const data = /^data: (.*)$/m.exec(text);
  try {
    json = JSON.parse(data ? data[1] : text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

test('token: required, at least 32 chars, URL-safe; errors never echo it', () => {
  assert.throws(() => validateToken(undefined), /no HTTP token/);
  assert.throws(() => validateToken('short-FAKE'), /too short: 10 chars/);
  assert.throws(() => validateToken('FAKE/with/slashes/0123456789abcdefghijkl'), /may contain only/);
  for (const bad of ['short-FAKE', 'FAKE/with/slashes/0123456789abcdefghijkl']) {
    try {
      validateToken(bad);
    } catch (e) {
      assert.ok(!e.message.includes(bad));
    }
  }
  assert.equal(validateToken(TOKEN), TOKEN);
  assert.equal(sameSecret(TOKEN, TOKEN), true);
  assert.equal(sameSecret('x', TOKEN), false, 'different lengths compare safely');
});

test('authorize: secret path, bearer on /mcp, everything else', () => {
  const req = (url, authorization) => ({ url, headers: authorization === undefined ? {} : { authorization } });
  assert.equal(authorize(req(`/private_${TOKEN}/mcp`), TOKEN), 'ok');
  assert.equal(authorize(req(`/private_${TOKEN}/mcp?x=1`), TOKEN), 'ok');
  assert.equal(authorize(req(`/private_${TOKEN}x/mcp`), TOKEN), 'not_found');
  assert.equal(authorize(req('/mcp', `Bearer ${TOKEN}`), TOKEN), 'ok');
  assert.equal(authorize(req('/mcp', `bearer ${TOKEN}`), TOKEN), 'ok');
  assert.equal(authorize(req('/mcp', 'Bearer wrong'), TOKEN), 'unauthorized');
  assert.equal(authorize(req('/mcp', `Basic ${TOKEN}`), TOKEN), 'unauthorized');
  assert.equal(authorize(req('/mcp'), TOKEN), 'not_found', 'no header on /mcp: not found, not 401');
  assert.equal(authorize(req('/'), TOKEN), 'not_found');
  assert.equal(authorize(req(`/private_${TOKEN}/other`), TOKEN), 'not_found');
});

test('wrong path → bare 404 without WWW-Authenticate', async () => {
  for (const p of ['/', '/mcp', '/private_nope/mcp', `/private_${TOKEN}/`, '/sse']) {
    const r = await rpc(p, INIT);
    assert.equal(r.status, 404, p);
    assert.equal(r.text, '', p);
    assert.equal(r.headers.get('www-authenticate'), null, p);
  }
});

test('/.well-known/oauth-* → 404, so clients never start OAuth', async () => {
  for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/openid-configuration']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, p);
    assert.equal(res.headers.get('www-authenticate'), null, p);
  }
});

test('wrong bearer → 401 (only when a header was sent), no WWW-Authenticate', async () => {
  const r = await rpc('/mcp', INIT, { authorization: 'Bearer FAKE-wrong-token-0123456789abcdefghijk' });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), null);
});

test('secret path and bearer both reach MCP; each request is a fresh stateless server', async () => {
  const viaPath = await rpc(`/private_${TOKEN}/mcp`, INIT);
  assert.equal(viaPath.status, 200, viaPath.text);
  assert.equal(viaPath.json.result.serverInfo.name, 'cheap-eyes');
  assert.equal(viaPath.headers.get('mcp-session-id'), null, 'stateless: no session id');
  const viaBearer = await rpc('/mcp', INIT, { authorization: `Bearer ${TOKEN}` });
  assert.equal(viaBearer.status, 200);
  const list = await rpc(`/private_${TOKEN}/mcp`, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2025-06-18' });
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.json.result.tools.map((t) => t.name).sort(), ['eyes_result', 'eyes_run', 'eyes_stats']);
  const stats = await rpc(`/private_${TOKEN}/mcp`, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'eyes_stats', arguments: {} } }, { 'mcp-protocol-version': '2025-06-18' });
  assert.match(stats.json.result.content[0].text, /^eyes_stats\n/);
});

test('2026-07-28 clients are served natively, through the secret path and through Bearer', async () => {
  for (const [p, auth] of [
    [`/private_${TOKEN}/mcp`, {}],
    ['/mcp', { authorization: `Bearer ${TOKEN}` }],
  ]) {
    const disc = modern(10, 'server/discover');
    const r = await rpc(p, disc.body, { ...disc.headers, ...auth });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.result, r.text);
    assert.match(JSON.stringify(r.json.result), /2026-07-28/, 'the discover result names the modern revision');

    const list = modern(11, 'tools/list');
    const l = await rpc(p, list.body, { ...list.headers, ...auth });
    assert.equal(l.status, 200, l.text);
    assert.deepEqual(l.json.result.tools.map((t) => t.name).sort(), ['eyes_result', 'eyes_run', 'eyes_stats']);

    const call = modern(12, 'tools/call', { name: 'eyes_stats', arguments: {} });
    const c = await rpc(p, call.body, { ...call.headers, ...auth });
    assert.equal(c.status, 200, c.text);
    assert.match(c.json.result.content[0].text, /^eyes_stats\n/);
  }
});

test('2025 clients keep working without sessions (legacy: stateless)', async () => {
  const r = await rpc('/mcp', INIT, { authorization: `Bearer ${TOKEN}` });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.protocolVersion, '2025-06-18');
  assert.equal(r.headers.get('mcp-session-id'), null);
});

test('a wrong path or token is refused before MCP, whatever the era', async () => {
  const disc = modern(20, 'server/discover');
  assert.equal((await rpc('/private_nope/mcp', disc.body, disc.headers)).status, 404);
  assert.equal((await rpc('/mcp', disc.body, disc.headers)).status, 404);
  assert.equal((await rpc('/mcp', disc.body, { ...disc.headers, authorization: 'Bearer FAKE-wrong-token-0123456789abcdefghijk' })).status, 401);
});

test('localhost bind: a foreign Host or Origin is refused with 403 by the SDK guards', async () => {
  const port = server.address().port;
  const p = `/private_${TOKEN}/mcp`;
  assert.equal((await raw(port, p)).status, 200, 'local Host passes');
  assert.equal((await raw(port, p, { host: 'evil.example.com' })).status, 403);
  assert.equal((await raw(port, p, { host: `localhost:${port}` })).status, 200);
  assert.equal((await raw(port, p, { origin: 'https://evil.example.com' })).status, 403);
  assert.equal((await raw(port, p, { origin: `http://localhost:${port}` })).status, 200);
  assert.equal((await raw(port, '/nope', { host: 'evil.example.com' })).status, 404, 'a wrong path is still a bare 404');
});

test('non-local bind: no Host/Origin checks, the token alone protects', async () => {
  const open = http.createServer(createHttpHandler(ctx, { token: TOKEN, host: '0.0.0.0' }));
  await new Promise((r) => open.listen(0, '127.0.0.1', r));
  try {
    const port = open.address().port;
    assert.equal((await raw(port, `/private_${TOKEN}/mcp`, { host: 'mcp.example.com', origin: 'https://claude.ai' })).status, 200);
    assert.equal((await raw(port, '/private_nope/mcp', { host: 'mcp.example.com' })).status, 404);
  } finally {
    await new Promise((r) => open.close(r));
  }
  assert.equal(isLocalBind('127.0.0.1'), true);
  assert.equal(isLocalBind('localhost'), true);
  assert.equal(isLocalBind('::1'), true);
  assert.equal(isLocalBind('0.0.0.0'), false);
  assert.equal(isLocalBind('192.0.2.10'), false);
});

test('neither the token nor the request path is ever logged', async () => {
  await rpc('/mcp', INIT, { authorization: 'Bearer FAKE-wrong-token-0123456789abcdefghijk' });
  await rpc(`/private_${TOKEN}/mcp`, INIT);
  assert.ok(logs.length > 0, 'something was logged (the 401)');
  for (const l of logs) {
    assert.ok(!l.includes(TOKEN), l);
    assert.ok(!l.includes('private_'), l);
    assert.ok(!l.includes('FAKE-wrong'), l);
  }
});

// ---- CLI ----

function runCli(args, env) {
  const r = spawnSync(process.execPath, [...CLI_ARGS, ...args], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    encoding: 'utf8',
    timeout: 20000,
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('serve refuses to start without a token or with a short one, never printing it', () => {
  const dir = tmpDir();
  const cfg = writeJson(path.join(dir, 'cfg.json'), { read_roots: [dir] });
  const env = isolatedEnv(path.join(dir, 'home'), { CHEAP_EYES_CONFIG: cfg, CHEAP_EYES_STATE_DIR: path.join(dir, 'state') });
  const none = runCli(['serve', '--http', '--port', '0'], env);
  assert.equal(none.code, 1);
  assert.match(none.out, /no HTTP token/);
  const short = runCli(['serve', '--http', '--port', '0'], { ...env, CHEAP_EYES_HTTP_TOKEN: 'FAKE-short-token' });
  assert.equal(short.code, 1);
  assert.match(short.out, /too short/);
  assert.ok(!short.out.includes('FAKE-short-token'));
  const tf = path.join(dir, 'token.txt');
  fs.writeFileSync(tf, 'FAKE-short-2\n');
  const fromFile = runCli(['serve', '--http', '--port', '0', '--token-file', tf], env);
  assert.equal(fromFile.code, 1);
  assert.ok(!fromFile.out.includes('FAKE-short-2'));
  const noHttp = runCli(['serve'], env);
  assert.equal(noHttp.code, 2);
  assert.match(noHttp.out, /serve needs --http/);
});

test('serve --http starts, answers on the secret path, and logs neither token nor path', async () => {
  const { spawn } = await import('node:child_process');
  const dir = tmpDir();
  const cfg = writeJson(path.join(dir, 'cfg.json'), { read_roots: [dir] });
  const env = isolatedEnv(path.join(dir, 'home'), { CHEAP_EYES_CONFIG: cfg, CHEAP_EYES_STATE_DIR: path.join(dir, 'state'), CHEAP_EYES_HTTP_TOKEN: TOKEN });
  const child = spawn(process.execPath, [...CLI_ARGS, 'serve', '--http', '--port', '0'], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
  });
  let stderr = '';
  child.stderr.on('data', (b) => (stderr += b));
  try {
    const port = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no start line: ${stderr}`)), 15000);
      child.stderr.on('data', () => {
        const m = /on http 127\.0\.0\.1:(\d+)/.exec(stderr);
        if (m) {
          clearTimeout(t);
          resolve(Number(m[1]));
        }
      });
    });
    const res = await fetch(`http://127.0.0.1:${port}/private_${TOKEN}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(INIT),
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /"serverInfo":\{"name":"cheap-eyes"/);
    await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { authorization: 'Bearer FAKE-wrong-token-0123456789abcdefghijk' }, body: '{}' });
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  assert.ok(!stderr.includes(TOKEN), stderr);
  assert.ok(!stderr.includes('private_'), stderr);
  assert.match(stderr, /http POST 401/);
  assert.ok(/on http 127\.0\.0\.1:\d+ \(localhost Host\/Origin checks on\)/.test(stderr), `default bind is local, guards on: ${stderr}`);
});
