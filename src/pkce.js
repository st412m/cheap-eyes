// OpenRouter OAuth PKCE: a key for this person without copying it by hand.
//   https://openrouter.ai/auth?callback_url=…&code_challenge=…&code_challenge_method=S256&key_label=…&state=…
//   → the browser returns to callback_url with ?code=…&state=…
//   → POST https://openrouter.ai/api/v1/auth/keys { code, code_verifier, code_challenge_method } → { key }
// Headless form: no callback_url (and no state); the page shows the code to paste.
// The callback listener binds the loopback addresses only (127.0.0.1 and ::1), on a
// free port, accepts the one callback whose state matches, then closes; it gives up
// after five minutes. The code is single use and the key is never logged or put into
// a message.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

export const AUTH_URL = 'https://openrouter.ai/auth';
export const KEY_LABEL = 'cheap-eyes';
export const CALLBACK_PATH = '/callback';
export const PKCE_TIMEOUT_MS = 5 * 60e3;

export function newVerifier() {
  return randomBytes(32).toString('base64url');
}

export function challengeOf(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function newState() {
  return randomBytes(16).toString('hex');
}

/** The sign-in URL; without callbackUrl the headless form (no state either). */
export function authUrl({ challenge, callbackUrl = null, state = null, label = KEY_LABEL }) {
  const u = new URL(AUTH_URL);
  if (callbackUrl) u.searchParams.set('callback_url', callbackUrl);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('key_label', label);
  if (callbackUrl && state) u.searchParams.set('state', state);
  return u.toString();
}

// The settings page of a key, which only its signed-in owner can open: the lowercase
// hex SHA-256 of the key. The hash is not the key.
export function keySettingsUrl(key) {
  return `https://openrouter.ai/keys/${createHash('sha256').update(key).digest('hex')}`;
}

const PAGE = (title, text) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;max-width:36em;margin:4em auto"><h1>${title}</h1><p>${text}</p></body></html>`;

// Bind `server` to host:port; resolves the server, rejects with the listen error.
function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(server);
    });
  });
}

// The IPv6 loopback is missing or switched off on this machine: listen on 127.0.0.1 only.
const NO_IPV6 = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL']);
const PORT_TRIES = 5;

/**
 * Listen for the callback. Resolves { url, port, hosts, done } once listening: `url` is
 * the callback URL to put into the sign-in link; `done` resolves to the code, or
 * rejects with an Error on timeout or when access was not granted.
 * The URL names localhost, the host the OpenRouter docs list for local callbacks; a
 * browser may resolve it to ::1 or to 127.0.0.1, so both loopbacks listen on the same
 * port (127.0.0.1 alone where there is no IPv6 loopback).
 * A callback without a code ends the sign-in at once: OpenRouter sends no code, and no
 * state, when the person denies access. A callback with a code and a wrong or missing
 * state is answered 400 and not accepted.
 */
export async function listenForCode({ state, timeoutMs = PKCE_TIMEOUT_MS, createServer = http.createServer } = {}) {
  let finish;
  const done = new Promise((resolve, reject) => {
    finish = { resolve, reject };
  });
  done.catch(() => {});
  let settled = false;
  let timer = null;
  const servers = [];
  const handler = (req, res) => {
    // One request per connection, so the listener closes as soon as the answers are sent.
    res.setHeader('connection', 'close');
    let u;
    try {
      u = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      u = null;
    }
    if (!u || u.pathname !== CALLBACK_PATH || req.method !== 'GET') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    if (settled) {
      res.writeHead(410, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Already done', 'This sign-in is finished. You can close this tab.'));
      return;
    }
    const code = u.searchParams.get('code');
    if (!code) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Not signed in', 'Access was not granted, so cheap-eyes got no key. Go back to the terminal.'));
      end(new Error('access was not granted (OpenRouter returned no code)'));
      return;
    }
    if (u.searchParams.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Not accepted', 'This answer does not belong to the sign-in that cheap-eyes started.'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Signed in', 'cheap-eyes received the answer. You can close this tab and go back to the terminal.'));
    end(null, code);
  };
  // No new connections; idle ones go now, a page still being sent is finished first.
  function closeAll() {
    for (const s of servers) {
      s.close();
      s.closeIdleConnections?.();
    }
  }
  function end(err, code) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    closeAll();
    if (err) finish.reject(err);
    else finish.resolve(code);
  }

  let port = null;
  const hosts = [];
  for (let attempt = 0; attempt < PORT_TRIES && port === null; attempt++) {
    const v4 = await listenOn(createServer(handler), 0, '127.0.0.1');
    const p = v4.address().port;
    const v6 = createServer(handler);
    try {
      await listenOn(v6, p, '::1');
      servers.push(v4, v6);
      hosts.push('127.0.0.1', '::1');
      port = p;
    } catch (e) {
      if (NO_IPV6.has(e.code)) {
        servers.push(v4);
        hosts.push('127.0.0.1');
        port = p;
      } else {
        // The port is taken on ::1 by another process: try another one.
        v4.close();
        if (attempt === PORT_TRIES - 1) throw e;
      }
    }
  }
  const limit = timeoutMs >= 60e3 ? `${Math.round(timeoutMs / 60e3)} minutes` : `${Math.round(timeoutMs / 1000)} s`;
  if (!settled) timer = setTimeout(() => end(new Error(`no answer from the browser within ${limit}`)), timeoutMs);
  return { url: `http://localhost:${port}${CALLBACK_PATH}`, port, hosts, done };
}

/** POST /api/v1/auth/keys through the OpenRouter client; returns the key. */
export async function exchangeCode(or, { code, verifier }) {
  const json = await or.request('/auth/keys', { method: 'POST', body: { code, code_verifier: verifier, code_challenge_method: 'S256' }, timeoutMs: 30_000 });
  if (typeof json?.key !== 'string' || json.key === '') throw new Error('OpenRouter answered without a key');
  return json.key;
}
