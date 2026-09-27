// `cheap-eyes serve --http`: Streamable HTTP through the SDK's createMcpHandler, which
// builds a fresh McpServer per request and serves both protocol eras: 2026-07-28
// natively and 2025 clients statelessly (legacy: 'stateless', the default). The async
// job registry lives at module level, so it outlives requests.
//
// On a localhost bind (127.0.0.1, localhost, ::1) the SDK's localhost Host/Origin
// guards stand in front of MCP against DNS rebinding; on any other address there are
// no Host/Origin checks and the token alone protects the server.
//
// Auth, in front of MCP:
// - secret path  /private_<token>/mcp  (works as a claude.ai custom connector), or
// - /mcp with    Authorization: Bearer <token>.
// A wrong path is a bare 404 without WWW-Authenticate, /.well-known/* is 404 (so
// clients treat the server as authless and never start OAuth), and 401 is returned
// only when an Authorization header was sent and is wrong. Neither the token nor the
// request path is ever logged.
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createServer } from './server.js';

export const DEFAULT_HOST = '127.0.0.1';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLocalBind(host) {
  return LOCAL_HOSTS.has(String(host).toLowerCase());
}

export const MIN_TOKEN_LENGTH = 32;
// The token is also a path segment: only characters that need no URL encoding.
const TOKEN_CHARS = /^[A-Za-z0-9._~-]+$/;

export class TokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenError';
  }
}

// Never echoes the token.
export function validateToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TokenError('no HTTP token: set env CHEAP_EYES_HTTP_TOKEN or pass --token-file');
  }
  if (token.length < MIN_TOKEN_LENGTH) throw new TokenError(`HTTP token too short: ${token.length} chars, at least ${MIN_TOKEN_LENGTH} required`);
  if (!TOKEN_CHARS.test(token)) throw new TokenError('HTTP token may contain only A-Z a-z 0-9 . _ ~ - (it is also a URL path segment)');
  return token;
}

// Constant time for any lengths: compare SHA-256 digests (equal-length buffers).
export function sameSecret(given, token) {
  const a = createHash('sha256').update(String(given)).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

const PRIVATE_PREFIX = '/private_';
const MCP_SUFFIX = '/mcp';

// 'ok' | 'not_found' | 'unauthorized'
export function authorize(req, token) {
  let pathname;
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return 'not_found';
  }
  if (pathname.startsWith('/.well-known/')) return 'not_found';
  if (pathname.startsWith(PRIVATE_PREFIX) && pathname.endsWith(MCP_SUFFIX)) {
    const candidate = pathname.slice(PRIVATE_PREFIX.length, -MCP_SUFFIX.length);
    return sameSecret(candidate, token) ? 'ok' : 'not_found';
  }
  if (pathname === MCP_SUFFIX) {
    const header = req.headers.authorization;
    if (header === undefined) return 'not_found';
    const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
    return m && sameSecret(m[1], token) ? 'ok' : 'unauthorized';
  }
  return 'not_found';
}

function bare(res, status) {
  res.writeHead(status, { 'content-length': '0', 'cache-control': 'no-store' });
  res.end();
}

/**
 * The request listener: auth front → (localhost bind only) Host/Origin guards → MCP.
 * `log` receives lines without paths or tokens. Returns the listener with `close()`
 * for shutdown and `localGuards` telling whether the guards are armed.
 */
export function createHttpHandler(ctx, { token, host = DEFAULT_HOST, log = () => {} }) {
  validateToken(token);
  const mcp = createMcpHandler(() => createServer(ctx));
  const nodeHandler = toNodeHandler(mcp);
  const localGuards = isLocalBind(host);
  const validateHost = localGuards ? localhostHostValidation() : null;
  const validateOrigin = localGuards ? localhostOriginValidation() : null;

  const listener = async (req, res) => {
    const verdict = authorize(req, token);
    if (verdict === 'not_found') return bare(res, 404);
    if (verdict === 'unauthorized') {
      log(`cheap-eyes: http ${req.method} 401 (wrong bearer token)`);
      return bare(res, 401);
    }
    // The guards answer a rejected request with 403 themselves and return false.
    if (validateHost && !validateHost(req, res)) return log(`cheap-eyes: http ${req.method} 403 (Host not local)`);
    if (validateOrigin && !validateOrigin(req, res)) return log(`cheap-eyes: http ${req.method} 403 (Origin not local)`);
    try {
      await nodeHandler(req, res);
    } catch (e) {
      log(`cheap-eyes: http ${req.method} failed: ${e?.name ?? 'Error'}`);
      if (!res.headersSent) bare(res, 500);
      else res.end();
    }
  };
  listener.close = () => mcp.close();
  listener.localGuards = localGuards;
  return listener;
}

export function bindDescription(host, localGuards) {
  return localGuards
    ? `${host} (localhost Host/Origin checks on)`
    : `${host} (no Host/Origin checks: non-local bind, the token protects the server)`;
}

export function startHttp(ctx, { port, host = DEFAULT_HOST, token, log = (m) => console.error(m) }) {
  const listener = createHttpHandler(ctx, { token, host, log });
  const server = http.createServer(listener);
  server.on('close', () => void listener.close());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({ server, localGuards: listener.localGuards });
    });
  });
}
