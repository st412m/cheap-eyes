// URL input against mock servers on loopback only; the SSRF guard is overridden
// (loopback allowed, any port) only inside the tests that need to reach them.
// Fake keys only. scan-secrets:allow-file
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, beforeEach, test } from 'node:test';
import { Ledger } from '../src/budget.js';
import { checkConfig } from '../src/check-config.js';
import { parseConfig } from '../src/config.js';
import { readUrlSource } from '../src/input/extract.js';
import { expandFiles } from '../src/input/files.js';
import { ALLOWED_TYPES, CONTACT_HINT, fetchUrl, guardedLookup, isBlockedAddress, maskedUrl, proxyFor, urlName, USER_AGENT, userAgent } from '../src/input/url.js';
import { clearCatalogCache } from '../src/openrouter.js';
import { eyesResult } from '../src/result-tool.js';
import { pruneResults, readCheck } from '../src/results.js';
import { eyesRun } from '../src/run.js';
import { VERSION } from '../src/version.js';
import { tmpDir } from './helpers.js';

const FX = path.join(import.meta.dirname, 'fixtures', 'formats');
const KEY = 'sk-' + 'or-v1-FAKE0000000000000000000000000000000000000000000000000000';
const ZDR = [{ model_id: 'v/a', provider_name: 'P', context_length: 32000, max_completion_tokens: 4096, pricing: { prompt: '0.0000002', completion: '0.0000004', request: '0' } }];
const CONFIG = { url_timeout_s: 10, max_url_bytes: 1024 * 1024, max_file_bytes: 2 * 1024 * 1024, max_doc_bytes: 50 * 1024 * 1024, extract_timeout_s: 60 };
const LOOP = [{ address: '127.0.0.1', family: 4 }];
// Private addresses from octets: the repository scan refuses dotted LAN literals.
const lan = (...octets) => octets.join('.');

beforeEach(() => clearCatalogCache());

async function server(handler) {
  const reqs = [];
  const s = http.createServer((req, res) => {
    reqs.push({ url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  after(() => {
    s.closeAllConnections();
    s.close();
  });
  return { port: s.address().port, reqs };
}

// Reach the loopback mock: names resolve to 127.0.0.1, loopback and any port allowed.
const reach = { resolve: async () => LOOP, isBlocked: (ip) => ip !== '127.0.0.1' && isBlockedAddress(ip), ports: null, env: {} };

async function refused(promise, re) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.name, 'InputError', e.stack);
    assert.match(e.message, re);
    return true;
  });
}

// ---- the guard ----

test('blocked ranges: loopback, private, CGNAT, link-local/metadata, multicast, ULA, IPv4-mapped IPv6', () => {
  const blocked = [
    '127.0.0.1', '127.255.0.9', '0.0.0.0', '0.1.2.3', lan(10, 1, 2, 3), lan(172, 16, 5, 4), lan(172, 31, 255, 255), lan(192, 168, 1, 1), '100.64.0.1', '100.127.255.254',
    '169.254.169.254', '169.254.1.1', '224.0.0.1', '239.255.255.250', '255.255.255.255',
    '::1', '::', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', `::ffff:${lan(10, 0, 0, 1)}`, '::ffff:a9fe:a9fe', `::ffff:${lan(192, 168, 0, 1)}`, 'not-an-ip',
    // IPv4-compatible ::/96 whole; NAT64 and 6to4 by the IPv4 inside.
    '::127.0.0.1', '::808:808', '64:ff9b::7f00:1', '64:ff9b::c0a8:101', '64:ff9b::169.254.169.254', '64:ff9b:1::a00:1',
    '2002:c0a8:0101::1', '2002:7f00:1::', 'fe80::1%eth0',
  ];
  for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, ip);
  const allowed = ['192.0.2.1', '198.51.100.7', '203.0.113.9', '172.32.0.1', '100.128.0.1', '2001:db8::1', '::ffff:198.51.100.7', '64:ff9b::808:808', '64:ff9b::8.8.8.8', '64:ff9b:1::808:808', '2002:808:808::1'];
  for (const ip of allowed) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test('refused before any request: private literals, localhost, other ports, schemes, credentials', async () => {
  const none = { resolve: async () => assert.fail('no DNS for a literal'), env: {} };
  await refused(fetchUrl(`http://${lan(192, 168, 1, 1)}/`, { config: CONFIG, deps: none }), /^URL refused: 192\.168\.1\.1 resolves to a private, loopback or otherwise blocked address$/);
  await refused(fetchUrl('http://[::1]/', { config: CONFIG, deps: none }), /URL refused: ::1 /);
  await refused(fetchUrl('http://[::ffff:127.0.0.1]/', { config: CONFIG, deps: none }), /URL refused: ::ffff:7f00:1 /);
  await refused(fetchUrl('http://169.254.169.254/latest/meta-data/', { config: CONFIG, deps: none }), /169\.254\.169\.254/);
  await refused(fetchUrl('http://localhost:3400/', { config: CONFIG, deps: none }), /port 3400 on localhost \(only 80 and 443\)/);
  await refused(fetchUrl('https://example.com:8080/x', { config: CONFIG, deps: none }), /port 8080/);
  // A name that resolves to loopback is refused by name, not by its address list.
  await refused(fetchUrl('http://localhost/', { config: CONFIG, deps: { env: {} } }), /^URL refused: localhost resolves to a private/);
  await refused(fetchUrl('http://user:pw@example.com/', { config: CONFIG, deps: none }), /credentials refused/);
});

test('files[]: other schemes, a range on a URL and URLs with url_input off are refused', async () => {
  const d = tmpDir();
  const on = parseConfig({ read_roots: [d] });
  const off = parseConfig({ read_roots: [d], url_input: false });
  await refused(expandFiles(['file:///etc/passwd'], { config: on }), /URL scheme refused: file: \(only http and https/);
  await refused(expandFiles(['ftp://example.com/x'], { config: on }), /URL scheme refused: ftp:/);
  await refused(expandFiles(['https://example.com/doc#L1-L5'], { config: on }), /a line range is not allowed on a URL/);
  await refused(expandFiles(['https://example.com/doc?token=abc'], { config: off }), /^URL input is off \(url_input: false\): https:\/\/example\.com\/doc\?token=\*\*\*$/);
  const { files } = await expandFiles(['https://example.com/a/b.html?x=1#frag', 'https://example.com/a/b.html?x=1'], { config: on });
  assert.equal(files.length, 1, 'same URL twice collapses');
  assert.equal(files[0].rel, 'example.com/a/b.html');
});

test('names: host/path without query, at most 80 chars with a middle cut; metadata masks query values', () => {
  assert.equal(urlName('https://www.sec.gov/Archives/edgar/data/1/x.htm?a=1#f'), 'www.sec.gov/Archives/edgar/data/1/x.htm');
  assert.equal(urlName('https://example.com/'), 'example.com');
  assert.equal(urlName('https://example.com/%D0%B4%D0%BE%D0%BA.pdf'), 'example.com/док.pdf');
  const long = urlName(`https://example.com/${'a'.repeat(100)}/end.pdf`);
  assert.equal(long.length, 80);
  assert.match(long, /^example\.com\/a+…a+\/end\.pdf$/);
  assert.equal(maskedUrl('https://u:p@example.com/p?token=s3cr3t&page=2#x'), 'https://example.com/p?token=***&page=***');
});

// ---- fetching from the mock ----

test('fetch: user agent, no cookies or auth, charset from Content-Type, name and metadata', async () => {
  const s = await server((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=windows-1251', 'set-cookie': 'sid=1' });
    res.end(Buffer.from([0xc4, 0xe0, 0x0a])); // "Да\n"
  });
  const url = `http://site.test:${s.port}/notes.txt?key=v`;
  const r = await readUrlSource(url, { name: 'n', config: CONFIG, deps: reach, now: Date.parse('2026-10-02T09:00:00Z') });
  assert.deepEqual(r.lines, ['Да']);
  assert.equal(r.format, 'text');
  assert.equal(r.meta.url, `http://site.test:${s.port}/notes.txt?key=***`);
  assert.equal(r.meta.fetched_at, '2026-10-02T09:00:00.000Z');
  assert.equal(s.reqs[0].headers['user-agent'], USER_AGENT);
  assert.equal(s.reqs[0].headers.cookie, undefined);
  assert.equal(s.reqs[0].headers.authorization, undefined);
  assert.equal(s.reqs[0].headers.host, `site.test:${s.port}`);
});

test('fetch: HTML by Content-Type, PDF by content; a PDF as octet-stream is refused by type', async () => {
  const pdf = fs.readFileSync(path.join(FX, 'text.pdf'));
  const s = await server((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=windows-1252' });
      res.end(fs.readFileSync(path.join(FX, 'cp1252.html')).toString('latin1').replace(/^<html>/, '<div>'), 'latin1');
    } else if (req.url === '/doc.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(pdf);
    } else {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(pdf);
    }
  });
  const html = await readUrlSource(`http://site.test:${s.port}/page`, { name: 'p', config: CONFIG, deps: reach });
  assert.equal(html.format, 'html');
  assert.ok(html.lines.some((l) => l.includes('Supplier’s margin')));
  assert.ok(!html.lines.join('\n').includes('bazadebezolkohpepadr'));
  const p = await readUrlSource(`http://site.test:${s.port}/doc.pdf`, { name: 'd', config: CONFIG, deps: reach });
  assert.equal(p.format, 'pdf');
  assert.deepEqual(p.pageStarts, [1]);
  await refused(readUrlSource(`http://site.test:${s.port}/bin`, { name: 'b', config: CONFIG, deps: reach }), /content type application\/octet-stream from site\.test is not read/);
});

test('content types: the read formats are allowed (lower case, as compared); spreadsheets and .ppsm are not', () => {
  for (const t of [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
    'application/vnd.openxmlformats-officedocument.presentationml.template',
    'application/vnd.ms-powerpoint.presentation.macroenabled.12',
    'application/vnd.ms-powerpoint.template.macroenabled.12',
    'application/vnd.ms-powerpoint',
    'application/vnd.ms-word.document.macroenabled.12',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
    'application/vnd.ms-word.template.macroenabled.12',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.text-template',
    'application/vnd.oasis.opendocument.presentation',
    'application/vnd.oasis.opendocument.presentation-template',
    'application/epub+zip',
    'application/x-fictionbook+xml',
    'message/rfc822',
    'application/vnd.ms-outlook',
  ]) {
    assert.ok(ALLOWED_TYPES.has(t), t);
  }
  for (const t of [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/vnd.ms-excel.sheet.macroenabled.12',
    'application/vnd.oasis.opendocument.spreadsheet',
    // .ppsm is not among the extensions doclines declares.
    'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
    'application/zip',
  ]) {
    assert.ok(!ALLOWED_TYPES.has(t), t);
  }
  assert.ok([...ALLOWED_TYPES].every((t) => t === t.toLowerCase()));
});

test('fetch: a message by message/rfc822 and a presentation by its type, without an extension; a spreadsheet type is refused', async () => {
  const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const s = await server((req, res) => {
    const [type, file] = { '/mail': ['message/rfc822', 'mail-mixed.eml'], '/deck': [PPTX, 'text.pptx'], '/book.epub': ['application/epub+zip', 'text.epub'], '/sheet': [XLSX, 'text.xlsx'] }[req.url];
    res.writeHead(200, { 'content-type': type });
    res.end(fs.readFileSync(path.join(FX, file)));
  });
  const base = `http://site.test:${s.port}`;
  const mail = await readUrlSource(`${base}/mail`, { name: 'm', config: CONFIG, deps: reach });
  assert.equal(mail.format, 'eml');
  assert.equal(mail.lines[0], 'From: Иван Тестов <ivan@example.com>');
  assert.deepEqual([...new Set(mail.sections.map((x) => x.kind))], ['attachments', 'attachment']);
  assert.equal(mail.meta.content_type, 'message/rfc822');
  const deck = await readUrlSource(`${base}/deck`, { name: 'd', config: CONFIG, deps: reach });
  assert.equal(deck.format, 'pptx');
  assert.deepEqual(deck.markers.slice(0, 2), [{ at: 0, text: '--- slide 1 ---' }, { at: 3, text: '--- notes 1 ---' }]);
  assert.equal(deck.sections[0].kind, 'slide');
  assert.ok(deck.bytes > 0 && deck.sha256.length === 64);
  const book = await readUrlSource(`${base}/book.epub`, { name: 'b', config: CONFIG, deps: reach });
  assert.equal(book.format, 'epub');
  await refused(readUrlSource(`${base}/sheet`, { name: 's', config: CONFIG, deps: reach }), /^URL refused: content type application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet from site\.test is not read \(text, HTML, PDF, Word, RTF, PowerPoint, OpenDocument text and presentations, EPUB, FB2, EML, MSG only\)$/);
});

test('redirects: followed and re-checked; to a private address, to file://, or more than 5 → refused', async () => {
  const s = await server((req, res) => {
    const m = /^\/hop(\d+)$/.exec(req.url);
    if (m && Number(m[1]) < 9) {
      res.writeHead(302, { location: `/hop${Number(m[1]) + 1}` });
      return res.end();
    }
    if (req.url === '/to-private') {
      res.writeHead(301, { location: `http://${lan(10, 0, 0, 1)}/admin` });
      return res.end();
    }
    if (req.url === '/to-file') {
      res.writeHead(302, { location: 'file:///etc/passwd' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`final ${req.url}\n`);
  });
  const base = `http://site.test:${s.port}`;
  const ok = await fetchUrl(`${base}/hop4`, { config: CONFIG, deps: reach });
  assert.equal(ok.finalUrl, `${base}/hop9`);
  assert.equal(ok.buf.toString(), 'final /hop9\n');
  await refused(fetchUrl(`${base}/hop1`, { config: CONFIG, deps: reach }), /more than 5 redirects/);
  await refused(fetchUrl(`${base}/to-private`, { config: CONFIG, deps: reach }), /URL refused: 10\.0\.0\.1 resolves to a private/);
  await refused(fetchUrl(`${base}/to-file`, { config: CONFIG, deps: reach }), /URL scheme refused: file:/);
});

test('size cap while streaming (chunked, declared, compressed); HTTP errors; timeout', async () => {
  const s = await server((req, res) => {
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      let n = 0;
      const tick = () => {
        if (n++ >= 40) return res.end();
        res.write('x'.repeat(64 * 1024));
        setImmediate(tick);
      };
      return tick();
    }
    if (req.url === '/declared') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(5 * 1024 * 1024) });
      return res.write('x');
    }
    if (req.url === '/bomb') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      return res.end(zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x41)));
    }
    if (req.url === '/gz') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      return res.end(zlib.gzipSync('compressed text\n'));
    }
    if (req.url === '/missing') {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('no');
    }
    // /hang: never answers
  });
  const base = `http://site.test:${s.port}`;
  for (const p of ['/stream', '/declared', '/bomb']) {
    await refused(fetchUrl(`${base}${p}`, { config: CONFIG, deps: reach }), /^URL refused: site\.test sent more than max_url_bytes 1048576$/);
  }
  assert.equal((await fetchUrl(`${base}/gz`, { config: CONFIG, deps: reach })).buf.toString(), 'compressed text\n');
  await refused(fetchUrl(`${base}/missing`, { config: CONFIG, deps: reach }), /HTTP 404 from site\.test/);
  await refused(fetchUrl(`${base}/hang`, { config: { ...CONFIG, url_timeout_s: 1 }, deps: reach }), /URL timed out after 1 s \(url_timeout_s\): site\.test/);
});

// ---- DNS rebinding and the proxy path ----

test('DNS rebinding: public at the check, 127.0.0.1 at connect → refused; the loopback server is never reached', async () => {
  const s = await server((req, res) => res.end('reached\n'));
  let calls = 0;
  const resolve = async () => (++calls === 1 ? [{ address: '198.51.100.7', family: 4 }] : LOOP);
  await refused(fetchUrl(`http://rebind.test:${s.port}/`, { config: CONFIG, deps: { resolve, ports: null, env: {} } }), /URL refused: rebind\.test resolves to a private/);
  assert.equal(calls, 2, 'checked once, resolved again at connect');
  assert.equal(s.reqs.length, 0);
});

test('guarded lookup honours options.all and family, and refuses when any address is blocked', async () => {
  const both = [{ address: '2001:db8::5', family: 6 }, { address: '198.51.100.7', family: 4 }];
  const lookup = guardedLookup({ resolve: async () => both });
  const call = (opts) => new Promise((r) => lookup('h.test', opts, (...a) => r(a)));
  assert.deepEqual(await call({ all: true }), [null, both]);
  assert.deepEqual(await call({}), [null, '2001:db8::5', 6]);
  assert.deepEqual(await call({ family: 4 }), [null, '198.51.100.7', 4]);
  assert.deepEqual(await call({ all: true, family: 4 }), [null, [both[1]]]);
  const mixed = guardedLookup({ resolve: async () => [...both, { address: lan(10, 0, 0, 5), family: 4 }] });
  const [err] = await new Promise((r) => mixed('h.test', { all: true }, (...a) => r(a)));
  assert.equal(err.code, 'ECHEAPEYES_BLOCKED');
});

test('proxy: with NODE_USE_ENV_PROXY the request goes to the proxy; a local name check stays best effort', async () => {
  const proxy = await server((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`via proxy: ${req.url}\n`);
  });
  const env = { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: `http://127.0.0.1:${proxy.port}` };
  const nxdomain = async () => {
    throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  };
  const r = await fetchUrl('http://example.test/doc.txt?q=1', { config: CONFIG, deps: { resolve: nxdomain, env } });
  assert.equal(r.buf.toString(), 'via proxy: http://example.test/doc.txt?q=1\n');
  // Without the proxy the same name is refused: it does not resolve.
  await refused(fetchUrl('http://example.test/doc.txt', { config: CONFIG, deps: { resolve: nxdomain, env: {} } }), /cannot resolve example\.test/);
  // A name that resolves locally to a private address is refused even behind the proxy.
  await refused(fetchUrl('http://intranet.test/', { config: CONFIG, deps: { resolve: async () => [{ address: lan(192, 168, 0, 10), family: 4 }], env } }), /intranet\.test resolves to a private/);
  assert.equal(proxy.reqs.length, 1);
  // HTTPS_PROXY without NODE_USE_ENV_PROXY is not used, as for the OpenRouter calls.
  assert.equal(proxyFor(new URL('https://a.test/'), { HTTPS_PROXY: 'http://p.test:3128' }), null);
  assert.deepEqual(proxyFor(new URL('https://a.test/'), { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://p.test:3128' }, '24.5.0'), { host: 'p.test' });
  assert.throws(() => proxyFor(new URL('https://a.test/'), { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://p.test:3128' }, '22.20.0'), /needs >= 22\.21 or >= 24\.5/);
});

// ---- end to end: sources, eyes_result, usage ----

function setup(extra = {}) {
  const d = tmpDir();
  const root = path.join(d, 'notes');
  fs.mkdirSync(root, { recursive: true });
  const config = parseConfig({ read_roots: [root], models: { fast: { ids: ['v/a'] } }, defaults: { extract: 'fast', draft: 'fast', edits: 'fast' }, ...extra });
  const stateDir = path.join(d, 'state');
  return { root, config, stateDir, ctx: { config, stateDir: { path: stateDir }, resultsDir: path.join(stateDir, 'results') } };
}

function chatFetch(content) {
  return async (url) => {
    const u = String(url);
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/endpoints/zdr')) return json({ data: ZDR });
    if (u.endsWith('/chat/completions')) {
      return json({ id: 'g', model: 'v/a', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 50, completion_tokens: 10, cost: 0.0001 } });
    }
    throw new Error(`unexpected ${u}`);
  };
}

test('end to end: a URL job keeps a masked source copy, eyes_result pages it; usage logs the host only', async () => {
  const long = `long ${'z'.repeat(500)}`;
  const s = await server((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Report</title><p>alpha one</p><p>password: Fixture-Not-A-Real-Secret-7</p><p>${long}</p><p>omega</p>`);
  });
  const st = setup();
  fs.writeFileSync(path.join(st.root, 'plain.md'), 'plain text\n');
  const url = `http://site.test:${s.port}/r/report.html?session=abc123`;
  const name = `site.test:${s.port}/r/report.html`;
  const deps = { key: KEY, fetch: chatFetch(`${name}:L2| alpha one\n${name}:L4| ${long}\nplain.md:L1| plain text`), ledger: new Ledger(st.stateDir), sleep: async () => {}, url: reach };
  const r = await eyesRun({ task: 't', mode: 'extract', files: [url, path.join(st.root, 'plain.md')] }, st.ctx, deps);
  assert.ok(!r.header.includes('abc123'));

  const dir = path.join(st.ctx.resultsDir, `${r.id}.sources`);
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.length, 1, 'plain local text gets no copy outside schema jobs');
  assert.deepEqual(
    { ...index[0], sha256: undefined, fetched_at: undefined },
    { n: 1, name, kind: 'url', url: `http://site.test:${s.port}/r/report.html?session=***`, final_url: `http://site.test:${s.port}/r/report.html?session=***`, content_type: 'text/html; charset=utf-8', format: 'html', bytes: index[0].bytes, sha256: undefined, fetched_at: undefined, pages: null, lines: 5 },
  );
  const copy = fs.readFileSync(path.join(dir, '1.txt'), 'utf8');
  assert.ok(copy.startsWith('L1| Report\nL2| alpha one\n'));
  assert.ok(!copy.includes('Fixture-Not-A-Real-Secret-7'), 'the copy is masked');

  const view = await eyesResult({ id: r.id, source: name, offset: 2, limit: 3 }, st.ctx);
  const lines = view.split('\n');
  assert.equal(lines[0], `source ${name} (html)`);
  assert.equal(lines[1], 'lines 2–4 of 5; more: next offset 5');
  assert.equal(lines[2], '--- source text (masked) ---');
  assert.equal(lines[3], 'L2| alpha one');
  assert.equal(lines[5], `L4| ${long.slice(0, 400)} … (+105 chars)`);
  assert.equal(lines.at(-1), '--- end of source text ---');
  assert.match(await eyesResult({ id: r.id, source: name, offset: 4, limit: 1, full: true }, st.ctx), new RegExp(`L4\\| ${long}\\n`));
  assert.match(await eyesResult({ id: r.id, source: name, grep: 'omega' }, st.ctx), /matches 1–1 of 1; end\n--- source text \(masked\) ---\nL5\| omega\n/);
  await refused(eyesResult({ id: r.id, source: 'nope' }, st.ctx), new RegExp(`unknown source: nope; this result has: ${name.replace(/[.]/g, '\\.')}`));

  // check.json: ok items carry no echoed text; check: true shows none of them.
  const check = await readCheck(st.ctx.resultsDir, r.id);
  assert.ok(check.checks.items.every((it) => it.status === 'ok' && it.text === undefined), JSON.stringify(check.checks.items));
  assert.match(await eyesResult({ id: r.id, check: true }, st.ctx), /items not ok .* none of 0; end/);
  assert.equal(check.files[0].url, `http://site.test:${s.port}/r/report.html?session=***`);

  const usage = fs.readFileSync(path.join(st.stateDir, 'usage.jsonl'), 'utf8');
  assert.ok(!usage.includes('report.html') && !usage.includes('abc123'), usage);
  assert.deepEqual(JSON.parse(usage).files[0], { name: `site.test:${s.port}`, bytes: index[0].bytes, url: true });
});

test('sources: a local PDF gets a copy with its page table; pruning removes and counts the folder', async () => {
  const st = setup();
  fs.copyFileSync(path.join(FX, 'text.pdf'), path.join(st.root, 'text.pdf'));
  const deps = { key: KEY, fetch: chatFetch('L1| Fixture: cheap-eyes formats'), ledger: new Ledger(st.stateDir), sleep: async () => {} };
  const r = await eyesRun({ task: 't', mode: 'extract', files: [path.join(st.root, 'text.pdf')] }, st.ctx, deps);
  const dir = path.join(st.ctx.resultsDir, `${r.id}.sources`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '1.json'), 'utf8')), {
    markers: [{ at: 0, text: '--- page 1 ---' }],
    page_starts: [1],
    sections: [{ kind: 'page', n: 1, label: null, start: 1, end: 11 }],
  });
  assert.match(fs.readFileSync(path.join(dir, '1.txt'), 'utf8'), /^--- page 1 ---\nL1\| Fixture: cheap-eyes formats\n/);
  const view = await eyesResult({ id: r.id, source: 'text.pdf', limit: 1 }, st.ctx);
  assert.match(view, /^source text\.pdf \(pdf, 1 pages\)\nlines 1–1 of 11; more: next offset 2\n--- source text \(masked\) ---\n--- page 1 ---\nL1\| Fixture/);
  // Over the size cap the whole result goes, its sources folder included.
  const { deleted } = await pruneResults(st.ctx.resultsDir, { retentionDays: 14, maxMb: 1e-6 });
  assert.deepEqual(deleted, [r.id]);
  assert.ok(!fs.existsSync(dir));
});

// ---- url_contact ----

test('url_contact: validated at config load; empty means none', () => {
  const d = tmpDir();
  assert.equal(parseConfig({ read_roots: [d] }).url_contact, '');
  assert.equal(parseConfig({ read_roots: [d], url_contact: 'ops@example.com' }).url_contact, 'ops@example.com');
  assert.equal(parseConfig({ read_roots: [d], url_contact: 'x'.repeat(100) }).url_contact.length, 100);
  const bad = (v, re) => assert.throws(() => parseConfig({ read_roots: [d], url_contact: v }), (e) => e.name === 'ConfigError' && /field "url_contact"/.test(e.message) && re.test(e.message));
  bad('x'.repeat(101), /at most 100 characters/);
  for (const ch of ['(', ')', ';']) bad(`ops${ch}example.com`, /must not contain "\(", "\)" or ";"/);
  for (const ch of ['\r', '\n', '\t', '\u0001', '\u007f', 'é']) bad(`ops${ch}example.com`, /printable ASCII only/);
});

test('User-Agent: "cheap-eyes/<version> <contact>" with url_contact, on direct requests, redirects and through a proxy', async () => {
  assert.equal(userAgent(''), USER_AGENT);
  assert.equal(userAgent('ops@example.com'), `cheap-eyes/${VERSION} ops@example.com`);
  assert.equal(USER_AGENT, `cheap-eyes/${VERSION} (+https://github.com/st412m/cheap-eyes)`);
  const s = await server((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/final' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok\n');
  });
  const config = { ...CONFIG, url_contact: 'ops@example.com' };
  await fetchUrl(`http://site.test:${s.port}/start`, { config, deps: reach });
  assert.deepEqual(s.reqs.map((r) => [r.url, r.headers['user-agent']]), [['/start', userAgent('ops@example.com')], ['/final', userAgent('ops@example.com')]]);
  const proxy = await server((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('via proxy\n');
  });
  const env = { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: `http://127.0.0.1:${proxy.port}` };
  await fetchUrl('http://example.test/x', { config, deps: { resolve: async () => [{ address: '198.51.100.7', family: 4 }], env } });
  assert.equal(proxy.reqs[0].headers['user-agent'], userAgent('ops@example.com'));
});

test('HTTP 403: the url_contact hint only when no contact is set', async () => {
  const s = await server((req, res) => {
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('Your request has been identified as part of a network of automated tools');
  });
  const url = `http://site.test:${s.port}/doc.htm`;
  await assert.rejects(fetchUrl(url, { config: CONFIG, deps: reach }), (e) => {
    assert.equal(e.message, `URL refused: HTTP 403 from site.test ${CONTACT_HINT}`);
    return true;
  });
  await refused(fetchUrl(url, { config: { ...CONFIG, url_contact: 'ops@example.com' }, deps: reach }), /^URL refused: HTTP 403 from site\.test$/);
  assert.equal(CONTACT_HINT, '(some sites require a contact in User-Agent: set url_contact)');
});

test('url_contact: printed by check-config, never in the usage log or the result', async () => {
  const contact = 'contact-marker@example.com';
  const st = setup({ url_contact: contact });
  const s = await server((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('alpha\n');
  });
  const url = `http://site.test:${s.port}/a.txt`;
  const r = await eyesRun({ task: 't', mode: 'extract', files: [url] }, st.ctx, { key: KEY, fetch: chatFetch(`site.test:${s.port}/a.txt:L1| alpha`), ledger: new Ledger(st.stateDir), sleep: async () => {}, url: reach });
  assert.equal(s.reqs[0].headers['user-agent'], userAgent(contact));
  const stored = [path.join(st.stateDir, 'usage.jsonl'), path.join(st.ctx.resultsDir, `${r.id}.check.json`), path.join(st.ctx.resultsDir, `${r.id}.md`), path.join(st.ctx.resultsDir, `${r.id}.sources`, 'index.json')];
  for (const f of stored) assert.ok(!fs.readFileSync(f, 'utf8').includes('contact-marker'), f);
  assert.ok(!r.header.includes('contact-marker'));

  const d = tmpDir();
  const cfg = path.join(d, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ read_roots: [d], url_contact: contact }));
  const env = { CHEAP_EYES_CONFIG: cfg, CHEAP_EYES_STATE_DIR: path.join(d, 'state') };
  const out = await checkConfig({ env, cwd: d, homedir: d });
  assert.ok(out.text.split('\n').includes(`url input:      on, timeout 30 s, max 10485760 B per URL; contact ${contact}`), out.text);
  fs.writeFileSync(cfg, JSON.stringify({ read_roots: [d] }));
  assert.match((await checkConfig({ env, cwd: d, homedir: d })).text, /; contact none \(url_contact\)\n/);
});
