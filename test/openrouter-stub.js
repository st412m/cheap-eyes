// A stub of the OpenRouter API for the set-up tests: the ZDR list, the model lists,
// GET /key, the PKCE exchange and chat calls (probe answers). No network.
import { PROBE_EXPECTED, PROBE_LINES } from '../src/probe.js';

export const STUB_KEY = 'sk-' + 'or-v1-FAKE-INIT-KEY-000000000000000000000000000000000000'; // fake, scan-secrets:allow
const BASE = 'https://openrouter.ai/api/v1';

const ep = (model_id, pin, pout, maxOut = 32000) => ({
  model_id,
  provider_name: 'P',
  context_length: 64000,
  max_completion_tokens: maxOut,
  pricing: { prompt: String(pin / 1e6), completion: String(pout / 1e6), request: '0' },
});

export const STUB_ZDR = [ep('vendor/small-a', 0.05, 0.1), ep('vendor/small-b', 0.1, 0.2), ep('vendor/small-c', 0.2, 0.4), ep('vendor/guarded', 0.01, 0.02)];
export const STUB_ACCOUNT = ['vendor/small-a', 'vendor/small-b', 'vendor/small-c'];
export const GOOD_PROBE = PROBE_EXPECTED.map((n) => `L${n}| ${PROBE_LINES[n - 1]}`).join('\n');

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * `region403`: GET /endpoints/zdr and /models answer 403 unless `proxied()` is true.
 * `limit`: the key's limit (null: none). `codes`: PKCE codes the exchange accepts.
 * Every call is recorded in `calls` (url, method, body, auth).
 */
export function openRouterStub({ region403 = false, proxied = () => false, limit = null, codes = ['code-ok'], key = STUB_KEY, keyStatus = 200, account = STUB_ACCOUNT } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const auth = init.headers?.authorization ?? null;
    calls.push({ url: u, method: init.method ?? 'GET', body, auth });
    if (!u.startsWith(BASE)) throw new Error(`foreign url ${u}`);
    const p = u.slice(BASE.length);
    if ((p === '/endpoints/zdr' || p === '/models') && region403 && !proxied()) return json({ error: { code: 403, message: 'Forbidden' } }, 403);
    if (p === '/endpoints/zdr') return json({ data: STUB_ZDR });
    if (p === '/models') return json({ data: [...account, 'vendor/guarded'].map((id) => ({ id })) });
    if (p === '/models/user') return json({ data: account.map((id) => ({ id })) });
    if (p === '/key') {
      if (keyStatus !== 200) return json({ error: { code: keyStatus, message: 'Invalid key' } }, keyStatus);
      return json({ data: { label: 'sk-or-v1-FAK...000', limit, limit_remaining: limit === null ? null : limit - 0.5, limit_reset: null, usage_daily: 0 } });
    }
    if (p === '/auth/keys' && init.method === 'POST') {
      if (!codes.includes(body.code)) return json({ error: { code: 403, message: 'Invalid code or code_verifier' } }, 403);
      return json({ key, user_id: 'user_fake' });
    }
    if (p === '/chat/completions') {
      return json({ id: 'g', model: body.model, provider: 'Prov', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: GOOD_PROBE } }], usage: { prompt_tokens: 900, completion_tokens: 60, cost: 0.000118 } });
    }
    throw new Error(`unexpected ${init.method ?? 'GET'} ${u}`);
  };
  return { fetch, calls };
}
