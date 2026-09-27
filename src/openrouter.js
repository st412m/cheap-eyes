// OpenRouter HTTP client. Talks to no host but openrouter.ai. The API key is sent
// only in the Authorization header and never appears in logs or messages.
import { createHash } from 'node:crypto';
import { Masker } from './mask.js';

export const API_BASE = 'https://openrouter.ai/api/v1';
const API_HOST = 'openrouter.ai';
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 30_000;
const ERROR_CLIP = 500;

export class ApiError extends Error {
  // `status`: HTTP status or error.code from the body; 0 for network errors and timeouts.
  constructor(message, { status = 0, errorType = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errorType = errorType;
    this.retryAfter = retryAfter;
  }
}

// Error text that may be shown to the caller: clipped and masked.
export function safeErrorText(text) {
  const clipped = String(text ?? '').slice(0, ERROR_CLIP);
  return new Masker().maskText(clipped);
}

function url(path) {
  const u = new URL(API_BASE + path);
  if (u.protocol !== 'https:' || u.hostname !== API_HOST) throw new Error(`refusing to call ${u.hostname}`);
  return u;
}

// Retry-After in seconds, or null when absent or not a number (HTTP dates are ignored).
function retryAfterSeconds(headers) {
  const raw = headers?.get?.('retry-after');
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

// Module-level catalogue cache: survives across McpServer instances (HTTP mode).
const catalog = new Map(); // path → { at, data }

export function clearCatalogCache() {
  catalog.clear();
}

export class OpenRouter {
  constructor({ key = null, fetch = globalThis.fetch, now = () => Date.now() } = {}) {
    this.key = key;
    this.fetchImpl = fetch;
    this.now = now;
  }

  async request(path, { method = 'GET', body, auth = false, signal, timeoutMs }) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      if (!this.key) throw new ApiError('OpenRouter key is not set (env CHEAP_EYES_OPENROUTER_KEY)', { status: 401 });
      headers.authorization = `Bearer ${this.key}`;
    }
    const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean);
    let res;
    try {
      res = await this.fetchImpl(url(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signals.length ? AbortSignal.any(signals) : undefined,
        redirect: 'error',
      });
    } catch (e) {
      if (signal?.aborted) throw new ApiError('cancelled', { status: 0, errorType: 'cancelled' });
      const what = e?.name === 'TimeoutError' ? `timed out after ${Math.round(timeoutMs / 1000)} s` : safeErrorText(e?.message ?? e);
      throw new ApiError(`${method} ${path}: ${what}`, { status: 0, errorType: e?.name === 'TimeoutError' ? 'timeout' : 'network' });
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    // Errors may come with a 200 status and an `error` object in the body.
    const err = json && typeof json === 'object' && json.error ? json.error : null;
    if (!res.ok || err) {
      const status = Number(err?.code) || res.status;
      const message = err?.message ?? text;
      throw new ApiError(`${method} ${path}: HTTP ${status}: ${safeErrorText(message)}`, {
        status,
        errorType: err?.metadata?.error_type ?? null,
        retryAfter: retryAfterSeconds(res.headers),
      });
    }
    if (json === null) throw new ApiError(`${method} ${path}: response is not JSON`, { status: res.status });
    return json;
  }

  async cached(path, { auth = false } = {}) {
    // A per-key list is cached per key; the slot holds a hash, never the key.
    const slot = auth && this.key ? `${path}#${createHash('sha256').update(this.key).digest('hex').slice(0, 16)}` : path;
    const hit = catalog.get(slot);
    if (hit && this.now() - hit.at < CATALOG_TTL_MS) return hit.data;
    const json = await this.request(path, { auth, timeoutMs: CATALOG_TIMEOUT_MS });
    if (!Array.isArray(json?.data)) throw new ApiError(`GET ${path}: unexpected response shape (no data[])`);
    catalog.set(slot, { at: this.now(), data: json.data });
    return json.data;
  }

  // Public list of ZDR endpoints. No content leaves the machine.
  zdrEndpoints() {
    return this.cached('/endpoints/zdr');
  }

  // Text-output models (the API's default filter), for candidate suggestions.
  textModels() {
    return this.cached('/models');
  }

  // Models this account may use: "filtered by user provider preferences, privacy
  // settings, and guardrails"; text-output models by default, the full list when no
  // offset/limit is sent. Needs the key. Model id in `data[].id`.
  userModels() {
    return this.cached('/models/user', { auth: true });
  }

  // Only the budget fields; never `label`, which carries part of the key.
  async keyInfo() {
    const json = await this.request('/key', { auth: true, timeoutMs: CATALOG_TIMEOUT_MS });
    const d = json?.data ?? {};
    return {
      limit: d.limit ?? null,
      limit_remaining: d.limit_remaining ?? null,
      limit_reset: d.limit_reset ?? null,
      usage_daily: d.usage_daily ?? null,
    };
  }

  chat(body, { signal, timeoutMs }) {
    return this.request('/chat/completions', { method: 'POST', body, auth: true, signal, timeoutMs });
  }
}
