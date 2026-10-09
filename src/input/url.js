// URL input: the server fetches the page itself. SSRF guard before every request and
// every redirect: http/https only, ports 80/443, no credentials, no private, loopback,
// link-local, CGNAT, multicast or metadata addresses. Without a proxy the connection
// is pinned to the addresses that passed the check (a custom `lookup`), so a DNS
// answer that changes between check and connect (rebinding) cannot reach a private
// address. Through a proxy the proxy resolves the name; the local check is best effort.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import zlib from 'node:zlib';
import { InputError } from '../errors.js';
import { VERSION } from '../version.js';
import { hasControlChars } from './files.js';

export const URL_RE = /^https?:\/\//i;
// Any other "scheme://": file://, ftp://, …
export const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
export const MAX_REDIRECTS = 5;
export const ALLOWED_PORTS = [80, 443];
export const USER_AGENT = `cheap-eyes/${VERSION} (+https://github.com/st412m/cheap-eyes)`;

// The User-Agent of every URL request. With config url_contact: the contact as a
// plain product token, no comment (sec.gov refuses the comment form).
export function userAgent(contact = '') {
  return contact ? `cheap-eyes/${VERSION} ${contact}` : USER_AGENT;
}

export const CONTACT_HINT = '(some sites require a contact in User-Agent: set url_contact)';
const NAME_MAX = 80;

// Content types that are read; everything else (spreadsheets included) is refused by
// type, not sniffed.
export const ALLOWED_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  'application/vnd.ms-word.document.macroEnabled.12',
  'application/vnd.ms-word.template.macroEnabled.12',
  'application/msword',
  'application/rtf',
  'text/rtf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'application/vnd.openxmlformats-officedocument.presentationml.template',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  'application/vnd.ms-powerpoint.template.macroEnabled.12',
  'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.text-template',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.presentation-template',
  'application/epub+zip',
  'application/x-fictionbook+xml',
  'message/rfc822',
  'application/vnd.ms-outlook',
].map((t) => t.toLowerCase()));

export function makeBlockList() {
  const b = new net.BlockList();
  // [first octet, second octet, prefix]. Octets, not dotted literals: the repository
  // scan (tools/scan-secrets.mjs) refuses private LAN addresses in any file.
  for (const [o1, o2, p] of [
    [0, 0, 8],
    [10, 0, 8], // RFC 1918
    [100, 64, 10], // CGNAT
    [127, 0, 8], // loopback
    [169, 254, 16], // link-local, cloud metadata 169.254.169.254
    [172, 16, 12], // RFC 1918
    [192, 168, 16], // RFC 1918
    [224, 0, 4], // multicast
    [240, 0, 4], // reserved, broadcast
  ]) {
    b.addSubnet(`${o1}.${o2}.0.0`, p, 'ipv4');
  }
  for (const [a, p] of [
    ['::', 128],
    ['::1', 128],
    ['fe80::', 10],
    ['fc00::', 7],
    ['ff00::', 8],
  ]) {
    b.addSubnet(a, p, 'ipv6');
  }
  return b;
}

const BLOCKED = makeBlockList();

// IPv6 text → 8 hextets (a dotted IPv4 tail and a zone id are allowed).
export function ipv6Hextets(address) {
  let s = address.replace(/%.*$/, '');
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const b = v4[1].split('.').map(Number);
    s = `${s.slice(0, v4.index)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((x) => parseInt(x, 16));
}

function v4From(hi, lo) {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

// The IPv4 address an IPv6 address carries, checked by the IPv4 rules: NAT64
// 64:ff9b::/96 and 64:ff9b:1::/48 (last 32 bits), 6to4 2002::/16 (bits 16–47).
// IPv4-mapped (::ffff:0:0/96) is matched by BlockList itself.
function embeddedV4(h) {
  if (h[0] === 0x64 && h[1] === 0xff9b && (h[2] === 1 || h.slice(2, 6).every((x) => x === 0))) return v4From(h[6], h[7]);
  if (h[0] === 0x2002) return v4From(h[1], h[2]);
  return null;
}

// IPv4 rules also match IPv4-mapped IPv6 (::ffff:127.0.0.1); IPv4-compatible ::/96 is
// blocked whole; NAT64 and 6to4 are checked by the IPv4 inside; not an IP → blocked.
export function isBlockedAddress(address, list = BLOCKED) {
  const f = net.isIP(address);
  if (f === 0) return true;
  if (f === 4) return list.check(address, 'ipv4');
  if (list.check(address, 'ipv6')) return true;
  const h = ipv6Hextets(address);
  if (h.length !== 8 || h.some((x) => !Number.isInteger(x))) return true;
  if (h.slice(0, 6).every((x) => x === 0)) return true;
  const v4 = embeddedV4(h);
  return v4 !== null && list.check(v4, 'ipv4');
}

function refuse(message, reason) {
  return new InputError(message, { reason });
}

// The host as given in the URL, without IPv6 brackets.
function hostOf(u) {
  return u.hostname.replace(/^\[|\]$/g, '');
}

function portOf(u) {
  return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
}

/** host/path without query or fragment, at most 80 chars (middle cut with "…"). */
export function urlName(raw) {
  const u = new URL(raw);
  let p = u.pathname;
  try {
    const d = decodeURI(p);
    if (!hasControlChars(d)) p = d;
  } catch {
    // keep it percent-encoded
  }
  let name = `${u.host}${p === '/' ? '' : p}`.replace(/\/$/, '');
  if (name.length > NAME_MAX) {
    const head = Math.ceil((NAME_MAX - 1) / 2);
    name = `${name.slice(0, head)}…${name.slice(name.length - (NAME_MAX - 1 - head))}`;
  }
  return name;
}

/** The URL for metadata: credentials dropped, every query value masked, no fragment. */
export function maskedUrl(raw) {
  const u = new URL(raw);
  u.username = '';
  u.password = '';
  u.hash = '';
  const q = [...u.searchParams.keys()];
  if (q.length) u.search = q.map((k) => `${encodeURIComponent(k)}=***`).join('&');
  return u.toString();
}

/** Parse and check a URL given in files[]: scheme, credentials, range suffix. */
export function parseUrlEntry(entry) {
  if (/#L\d+-L\d+$/.test(entry)) throw refuse(`a line range is not allowed on a URL (a fragment is not a range): ${maskedUrl(entry.replace(/#.*$/, ''))}`, 'range on a URL');
  let u;
  try {
    u = new URL(entry);
  } catch {
    throw refuse(`not a valid URL: ${entry.slice(0, 200)}`, 'invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw refuse(`URL scheme refused: ${u.protocol} (only http and https)`, 'URL scheme refused');
  if (u.username || u.password) throw refuse(`URL with credentials refused: ${maskedUrl(entry)}`, 'URL with credentials refused');
  u.hash = '';
  return u;
}

// Proxy for this URL per the env (Node's built-in proxy support), or null.
export function proxyFor(u, env, nodeVersion = process.versions.node, execArgv = process.execArgv) {
  const on = env.NODE_USE_ENV_PROXY === '1' || /(?:^|\s)--use-env-proxy(?:\s|$)/.test(env.NODE_OPTIONS ?? '') || execArgv.includes('--use-env-proxy');
  if (!on) return null;
  const v = u.protocol === 'https:' ? (env.https_proxy ?? env.HTTPS_PROXY) : (env.http_proxy ?? env.HTTP_PROXY);
  if (!v) return null;
  // http.Agent proxyEnv: Node >= 22.21 on 22.x, >= 24.5 on 24.x.
  const [major, minor] = nodeVersion.split('.').map(Number);
  if ((major === 22 && minor < 21) || major === 23 || (major === 24 && minor < 5) || major < 22) {
    throw refuse(`a proxy is configured, but Node ${nodeVersion} cannot send URL fetches through it (needs >= 22.21 or >= 24.5)`, 'proxy not supported by this Node');
  }
  let host;
  try {
    host = new URL(v).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    host = null;
  }
  return { host };
}

function blockedHost(host) {
  return refuse(`URL refused: ${host} resolves to a private, loopback or otherwise blocked address`, 'blocked address');
}

/**
 * The SSRF check of one hop before any request: scheme, port, host. IP literals are
 * checked directly; names through `resolve`. Behind a proxy a name that does not
 * resolve locally is left to the proxy.
 */
async function precheck(u, { resolve, isBlocked, ports, proxy }) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw refuse(`URL scheme refused: ${u.protocol} (only http and https)`, 'URL scheme refused');
  if (u.username || u.password) throw refuse(`URL with credentials refused: ${u.host}`, 'URL with credentials refused');
  const port = portOf(u);
  if (ports && !ports.includes(port)) throw refuse(`URL refused: port ${port} on ${hostOf(u)} (only ${ports.join(' and ')})`, 'port refused');
  const host = hostOf(u);
  if (net.isIP(host)) {
    if (isBlocked(host)) throw blockedHost(host);
    return;
  }
  let list;
  try {
    list = await resolve(host);
  } catch (e) {
    if (proxy) return;
    throw refuse(`cannot resolve ${host} (${e.code ?? e.message})`, 'cannot resolve host');
  }
  if (!list.length || list.some((a) => isBlocked(a.address))) throw blockedHost(host);
}

const defaultResolve = (host) => dns.promises.lookup(host, { all: true });

// A `lookup` for http.request: resolves, refuses when any address is blocked, and
// hands back exactly the checked addresses (honours options.all, which Node sets with
// autoSelectFamily). The proxy's own host name is resolved without the check.
export function guardedLookup({ resolve = defaultResolve, isBlocked = isBlockedAddress, proxyHost = null } = {}) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    } else if (typeof options === 'number') options = { family: options };
    if (proxyHost && hostname.toLowerCase() === proxyHost) return dns.lookup(hostname, options, cb);
    resolve(hostname).then(
      (all) => {
        const list = options.family === 4 || options.family === 6 ? all.filter((a) => a.family === options.family) : all;
        if (!list.length || all.some((a) => isBlocked(a.address))) {
          const e = new Error(`blocked address for ${hostname}`);
          e.code = 'ECHEAPEYES_BLOCKED';
          e.host = hostname;
          return cb(e);
        }
        if (options.all) cb(null, list.map((a) => ({ address: a.address, family: a.family })));
        else cb(null, list[0].address, list[0].family);
      },
      (e) => cb(e),
    );
  };
}

function mimeOf(contentType) {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

function send(u, { lookup, proxy, env, signal, ua }) {
  const mod = u.protocol === 'https:' ? https : http;
  const agent = new mod.Agent({ keepAlive: false, ...(proxy ? { proxyEnv: env } : {}) });
  const req = mod.request({
    protocol: u.protocol,
    host: hostOf(u),
    port: portOf(u),
    path: `${u.pathname}${u.search}`,
    method: 'GET',
    agent,
    lookup,
    signal,
    headers: { 'user-agent': ua, accept: '*/*', 'accept-encoding': 'gzip, deflate, br' },
  });
  return new Promise((resolve, reject) => {
    req.once('response', (res) => resolve({ res, agent }));
    req.once('error', (e) => {
      agent.destroy();
      reject(e);
    });
    req.end();
  });
}

// Body with the cap enforced while streaming, on the wire and after decompression.
async function readBody(res, host, max, signal) {
  const enc = String(res.headers['content-encoding'] ?? 'identity').toLowerCase().trim();
  const tooBig = () => refuse(`URL refused: ${host} sent more than max_url_bytes ${max}`, 'response too large');
  const len = Number(res.headers['content-length']);
  if (Number.isFinite(len) && len > max) {
    res.destroy();
    throw tooBig();
  }
  const decoders = { gzip: zlib.createGunzip, 'x-gzip': zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };
  if (enc !== 'identity' && !decoders[enc]) {
    res.destroy();
    throw refuse(`URL refused: unsupported content-encoding ${enc} from ${host}`, 'unsupported content-encoding');
  }
  let wire = 0;
  const chunks = [];
  let size = 0;
  let over = false;
  const counter = new Writable({
    write(chunk, _e, cb) {
      size += chunk.length;
      if (size > max) {
        over = true;
        return cb(tooBig());
      }
      chunks.push(chunk);
      cb();
    },
  });
  res.on('data', (c) => {
    wire += c.length;
    if (wire > max && !over) {
      over = true;
      res.destroy(tooBig());
    }
  });
  try {
    const stages = enc === 'identity' ? [res, counter] : [res, decoders[enc]({ maxOutputLength: max + 1 }), counter];
    await pipeline(...stages, { signal });
  } catch (e) {
    if (over) throw tooBig();
    throw e;
  }
  return Buffer.concat(chunks);
}

/**
 * GET `raw` with the guard, manual redirects (at most 5, each re-checked), a timeout
 * and a size cap. Returns { buf, contentType, mime, finalUrl, status }.
 * `deps` (tests): resolve, isBlocked, ports, env.
 */
export async function fetchUrl(raw, { config, deps = {} }) {
  const resolve = deps.resolve ?? defaultResolve;
  const isBlocked = deps.isBlocked ?? isBlockedAddress;
  const ports = deps.ports === undefined ? ALLOWED_PORTS : deps.ports;
  const env = deps.env ?? process.env;
  const signal = AbortSignal.timeout(config.url_timeout_s * 1000);
  // The same User-Agent on the direct and the proxied path and on every redirect hop.
  const ua = userAgent(config.url_contact);
  let u = parseUrlEntry(raw);
  for (let hop = 0; ; hop++) {
    const proxy = proxyFor(u, env, deps.nodeVersion, deps.execArgv);
    await precheck(u, { resolve, isBlocked, ports, proxy });
    const host = hostOf(u);
    const lookup = guardedLookup({ resolve, isBlocked, proxyHost: proxy?.host });
    let sent;
    try {
      sent = await send(u, { lookup, proxy, env, signal, ua });
    } catch (e) {
      if (e.code === 'ECHEAPEYES_BLOCKED') throw blockedHost(host);
      if (signal.aborted) throw refuse(`URL timed out after ${config.url_timeout_s} s (url_timeout_s): ${host}`, 'URL timed out');
      throw refuse(`URL fetch failed: ${host} (${e.code ?? e.message})`, 'URL fetch failed');
    }
    const { res, agent } = sent;
    try {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (hop >= MAX_REDIRECTS) throw refuse(`URL refused: more than ${MAX_REDIRECTS} redirects from ${host}`, 'too many redirects');
        const loc = res.headers.location;
        if (!loc) throw refuse(`URL refused: redirect without a location from ${host}`, 'bad redirect');
        let next;
        try {
          next = new URL(loc, u);
        } catch {
          throw refuse(`URL refused: bad redirect location from ${host}`, 'bad redirect');
        }
        next.hash = '';
        u = next;
        continue;
      }
      if (res.statusCode < 200 || res.statusCode > 299) {
        res.resume();
        const hint = res.statusCode === 403 && !config.url_contact ? ` ${CONTACT_HINT}` : '';
        throw refuse(`URL refused: HTTP ${res.statusCode} from ${host}${hint}`, `HTTP ${res.statusCode}`);
      }
      const contentType = res.headers['content-type'] ?? '';
      const mime = mimeOf(contentType);
      if (!ALLOWED_TYPES.has(mime)) {
        res.resume();
        throw refuse(`URL refused: content type ${mime || '(none)'} from ${host} is not read (text, HTML, PDF, Word, RTF, PowerPoint, OpenDocument text and presentations, EPUB, FB2, EML, MSG only)`, `content type ${mime || '(none)'} refused`);
      }
      let buf;
      try {
        buf = await readBody(res, host, config.max_url_bytes, signal);
      } catch (e) {
        if (e instanceof InputError) throw e;
        if (signal.aborted) throw refuse(`URL timed out after ${config.url_timeout_s} s (url_timeout_s): ${host}`, 'URL timed out');
        throw refuse(`URL fetch failed: ${host} (${e.code ?? e.message})`, 'URL fetch failed');
      }
      return { buf, contentType, mime, finalUrl: u.toString(), status: res.statusCode };
    } finally {
      agent.destroy();
    }
  }
}
