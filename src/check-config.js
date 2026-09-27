// `cheap-eyes check-config`: validate the config and print what the server would use. No network.
import fs from 'node:fs';
import { DEFAULT_DENY_GLOBS, hasOpenRouterKey, loadConfig, resolveReadRoots } from './config.js';
import { DEFAULT_HOST, validateToken } from './http.js';
import { VERSION } from './version.js';

// Node's fetch honours HTTPS_PROXY only with NODE_USE_ENV_PROXY=1 or --use-env-proxy
// (Node >= 22.21 / 24). The proxy URL is never printed: it may carry credentials.
export function proxyState(env = process.env, execArgv = process.execArgv, nodeVersion = process.versions.node) {
  if (!env.HTTPS_PROXY) return 'direct';
  const on =
    env.NODE_USE_ENV_PROXY === '1' || /(?:^|\s)--use-env-proxy(?:\s|$)/.test(env.NODE_OPTIONS ?? '') || execArgv.includes('--use-env-proxy');
  if (!on) return 'direct (HTTPS_PROXY is set, but without NODE_USE_ENV_PROXY=1 Node ignores it)';
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (major === 22 && minor < 21) return `direct (HTTPS_PROXY is set, but Node ${nodeVersion} < 22.21 ignores it)`;
  return 'HTTPS_PROXY set';
}

function exists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Returns { code, text }. Never prints secrets: only whether the key env is set.
export async function checkConfig(opts = {}) {
  const env = opts.env ?? process.env;
  const out = [`cheap-eyes ${VERSION} check-config`];
  let loaded;
  try {
    loaded = loadConfig(opts);
  } catch (e) {
    if (e.name !== 'ConfigError') throw e;
    out.push(`ERROR ${e.message}`);
    return { code: 1, text: out.join('\n') };
  }
  const { config: c, file, source, stateDir, resultsDir } = loaded;
  let code = 0;

  out.push(`config file:    ${file}  (${source})`);
  out.push('read roots:');
  for (const [i, r] of (await resolveReadRoots(c.read_roots)).entries()) {
    if (r.kind === 'missing') {
      code = 1;
      out.push(`  [${i + 1}] ${r.given}  MISSING (${r.error})`);
    } else {
      out.push(`  [${i + 1}] ${r.given}${r.real !== r.given ? `  -> ${r.real}` : ''}  (${r.kind})`);
    }
  }
  const extraDeny = c.deny_globs.filter((g) => !DEFAULT_DENY_GLOBS.includes(g)).length;
  out.push(`deny globs:     ${c.deny_globs.join('  ')}  (built-in${extraDeny ? ` + ${extraDeny} from config` : ''})`);
  out.push(`state dir:      ${stateDir.path}  (${stateDir.source}; ${exists(stateDir.path) ? 'exists' : 'created on start'})`);
  out.push(`results dir:    ${resultsDir}`);
  if (c.write_roots.length === 0) {
    out.push('export:         off (write_roots is empty)');
  } else {
    out.push('write roots:');
    for (const w of c.write_roots) out.push(`  ${w}${exists(w) ? '' : '  (does not exist)'}`);
    out.push(`export dir:     ${c.export_dir ?? '(none; per-call export_to only)'}`);
  }
  out.push(`retention:      results ${c.results_retention_days} d, max ${c.results_max_mb} MB; exports ${c.export_retention_days === 0 ? 'never deleted' : `${c.export_retention_days} d`}`);

  const aliases = Object.entries(c.models);
  if (aliases.length === 0) out.push('models:         (none)');
  else {
    out.push('models:');
    for (const [a, m] of aliases) {
      const params = Object.keys(m.params);
      out.push(`  ${a}: ${m.ids.join(', ')}${params.length ? `  params: ${JSON.stringify(m.params)}` : ''}`);
    }
  }
  out.push(`defaults:       extract=${c.defaults.extract ?? '-'}  draft=${c.defaults.draft ?? '-'}  edits=${c.defaults.edits ?? '-'}`);
  out.push(`raw model ids:  ${c.allow_raw_model_ids ? 'allowed' : 'refused'}`);
  out.push(`price cap:      ${c.max_price_usd_per_mtok ? `in $${c.max_price_usd_per_mtok.in} / out $${c.max_price_usd_per_mtok.out} per 1M tokens` : 'none'}`);
  out.push(`max context:    ${c.max_context ?? 'live (from OpenRouter)'}`);
  out.push(`daily budget:   ${c.daily_budget_usd === null ? 'off (null)' : `$${c.daily_budget_usd}`}`);
  out.push(`limits:         file ${c.max_file_bytes} B, job ${c.max_job_bytes} B, ${c.max_files} files, concurrency ${c.concurrency}, timeout ${c.timeout_s} s`);
  out.push(`mask extra:     ${c.mask.extra_patterns.length} pattern(s)`);
  out.push(`hook max bytes: ${c.hook.max_bytes}`);
  out.push(`default tz:     ${c.time.default_tz}`);
  out.push(`openrouter key: ${hasOpenRouterKey(env) ? 'set' : 'NOT set'} (env CHEAP_EYES_OPENROUTER_KEY)`);
  out.push(`proxy:          ${proxyState(env)}`);
  out.push(`http serve:     default bind ${DEFAULT_HOST} with localhost Host/Origin checks; any other --host has none (token only)`);
  let tokenState = 'NOT set';
  if (env.CHEAP_EYES_HTTP_TOKEN) {
    try {
      validateToken(env.CHEAP_EYES_HTTP_TOKEN);
      tokenState = 'set';
    } catch (e) {
      tokenState = `set but invalid: ${e.message}`;
    }
  }
  out.push(`http token:     ${tokenState} (env CHEAP_EYES_HTTP_TOKEN; or --token-file)`);
  out.push(code === 0 ? 'OK' : 'ERROR: some read roots are missing');
  return { code, text: out.join('\n') };
}
