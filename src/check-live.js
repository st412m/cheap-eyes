// `check-config --live`: the network checks on top of the offline check. OpenRouter
// reachable, key status and limit, the account's model count, the usability of the
// models in force (the pin, or the aliases of the settings), the proxy. The key is
// never printed; the link to its settings page carries only its SHA-256.
import { noKeyText, proxyDescription } from './actions.js';
import { envValue } from './config.js';
import { loadAccount, screenIds, summarizeZdr } from './models.js';
import { ApiError, OpenRouter } from './openrouter.js';
import { autoConfig, pinDate, readPin } from './pick.js';
import { keySettingsUrl } from './pkce.js';

const NO_LIMIT = 'set a limit on this key: it is the real spending ceiling';

/** Returns { lines, failed }. A failed check: no answer from OpenRouter, no key or a refused key, a named alias without a usable id. */
export async function liveChecks({ loaded, env = process.env, fetch = globalThis.fetch }) {
  const key = envValue(env, 'CHEAP_EYES_OPENROUTER_KEY') ?? null;
  const or = new OpenRouter({ key, fetch, env });
  const lines = ['live checks:'];
  let failed = false;
  const line = (label, text) => lines.push(`  ${`${label}:`.padEnd(14)}${text}`);
  const fail = (label, text) => {
    failed = true;
    line(label, `FAILED: ${text}`);
  };

  line('proxy', proxyDescription(env));

  let zdr = null;
  try {
    const list = await or.zdrEndpoints();
    zdr = summarizeZdr(list);
    line('openrouter', `reachable (${list.length} ZDR endpoints, ${zdr.size} models)`);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    fail('openrouter', e.message);
  }

  let account = { ids: null, error: 'no key' };
  if (!key) fail('key', noKeyText(env));
  else {
    try {
      const k = await or.keyInfo();
      if (k.limit === null) line('key', `valid; NO LIMIT: ${NO_LIMIT}: ${keySettingsUrl(key)}`);
      else line('key', `valid; limit $${k.limit}, remaining ${k.limit_remaining === null ? '-' : `$${k.limit_remaining}`}${k.limit_reset ? `, reset ${k.limit_reset}` : ''}`);
      account = await loadAccount(or);
      line('account', account.ids ? `${account.ids.size} models allowed` : `availability unknown (${account.error})`);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      fail('key', e.message);
    }
  }

  if (zdr) {
    const { config, stateDir } = loaded;
    const aliases = Object.entries(config.models);
    if (aliases.length === 0) {
      const read = readPin(stateDir.path);
      if (read.error) line('pin', `cannot be used (${read.error}); the next model job sets it aside and picks again`);
      else if (!read.pin) line('pin', 'not picked yet; the first model job picks, or run `cheap-eyes models --pick`');
      else {
        const screened = screenIds(read.pin.ids, zdr, autoConfig(config), account.ids);
        const usable = screened.some((s) => s.ok);
        line('pin', `pinned ${pinDate(read.pin)}: ${screened.map((s) => `${s.id} ${s.ok ? 'usable' : `not usable (${s.reason})`}`).join('; ')}${usable ? '' : '; the next model job picks again'}`);
      }
    } else {
      for (const [alias, m] of aliases) {
        const screened = screenIds(m.ids, zdr, config, account.ids);
        const text = screened.map((s) => `${s.id} ${s.ok ? 'usable' : `not usable (${s.reason})`}`).join('; ');
        if (screened.some((s) => s.ok)) line(`alias ${alias}`, text);
        else fail(`alias ${alias}`, `no usable id: ${text}`);
      }
    }
  }
  lines.push(failed ? 'LIVE: FAILED' : 'LIVE: OK');
  return { lines, failed };
}
