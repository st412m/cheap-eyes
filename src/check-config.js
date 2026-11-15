// `cheap-eyes check-config`: validate the settings and print what the server would use. No network.
import fs from 'node:fs';
import { configErrorAction, nodeRuntime, PROXY_ENV, proxyDescription, proxyFailText, proxyState, rootsAction, settingsUi } from './actions.js';
import { launcherProxyPlan, switchOnInProcess } from './stdio-proxy.js';
import { DEFAULT_DENY_GLOBS, DEFAULT_ROOT_LABEL, envValue, hasOpenRouterKey, loadConfig, resolveReadRoots } from './config.js';
import { DEFAULT_HOST, validateToken } from './http.js';
import { liveChecks } from './check-live.js';
import { BUILTIN_CAP, capText, pinSummary } from './pick.js';
import { readStored, tokenPath } from './token.js';
import { VERSION } from './version.js';

export { proxyState };

function exists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// The source of the values on one line when not all came from the settings file:
// "  (default)", "  (env NAME)", or per key when they differ.
function sourceNote(sources, ...keys) {
  const other = keys.filter((k) => sources[k] !== 'file');
  if (!other.length) return '';
  const labels = [...new Set(other.map((k) => sources[k]))];
  if (other.length === keys.length && labels.length === 1) return `  (${labels[0]})`;
  return `  (${other.map((k) => `${k}: ${sources[k]}`).join(', ')})`;
}

// Where serve --http takes its token from (--token-file aside); never the token.
function tokenState(env, stateDir) {
  const file = tokenPath(stateDir);
  const fromEnv = envValue(env, 'CHEAP_EYES_HTTP_TOKEN');
  if (fromEnv !== undefined) {
    try {
      validateToken(fromEnv.trim());
      return 'set (env CHEAP_EYES_HTTP_TOKEN; overrides the saved token)';
    } catch (e) {
      return `set but invalid: ${e.message} (env CHEAP_EYES_HTTP_TOKEN)`;
    }
  }
  let stored;
  try {
    stored = readStored(stateDir);
  } catch (e) {
    return `cannot read ${file} (${e.code ?? e.message})`;
  }
  if (stored === null) return `NOT set yet: serve --http generates one into ${file} on its first start (or \`cheap-eyes token --new\`)`;
  try {
    validateToken(stored);
    return `saved in ${file} (\`cheap-eyes token\` prints it)`;
  } catch (e) {
    return `invalid in ${file}: ${e.message}; run \`cheap-eyes token --new\``;
  }
}

// The proxy line: what the stdio server started here would use. The proxy a launcher
// passes in CHEAP_EYES_HTTPS_PROXY is switched on in this process when Node can, so the
// live checks go through it too. `failed()` marks the check as failed.
function launcherProxyLine(env, opts, failed) {
  const plan = opts.proxyPlan !== undefined ? opts.proxyPlan : launcherProxyPlan(env);
  if (plan?.error) {
    failed();
    return `${plan.error}; to fix: ${configErrorAction({ envVar: PROXY_ENV }, settingsUi(env))}`;
  }
  if (plan?.mode === 'in-process') {
    const why = switchOnInProcess(plan, env);
    if (why) {
      failed();
      return proxyFailText(why, env).replace('\n', '; ');
    }
  }
  if (plan?.mode === 'restart') return `${proxyState(env)} in this process; ${PROXY_ENV} is set: the stdio server starts itself again through it (Node ${process.versions.node} has no http.setGlobalProxyFromEnv)`;
  return proxyDescription(env);
}

// The read roots line of the start message and of check-config.
export function rootsSummary(loaded) {
  const roots = loaded.config.read_roots;
  const src = loaded.sources.read_roots;
  if (!roots.length) {
    const d = loaded.defaultRoot;
    return d && d.path === null ? `none (the project folder ${d.candidate} is not used as a default: ${d.reason})` : 'none';
  }
  if (src === DEFAULT_ROOT_LABEL) return `${roots[0]} (${DEFAULT_ROOT_LABEL})`;
  return `${roots.join(', ')}${src === 'file' ? '' : ` (${src})`}`;
}

// Returns { code, text }. Never prints secrets: only whether the key env is set.
// The read roots are those of a stdio server started here (default root included).
// Offline unless opts.live: then the network checks follow (check-live.js).
export async function checkConfig(opts = {}) {
  const env = opts.env ?? process.env;
  const out = [`cheap-eyes ${VERSION} check-config`];
  let loaded;
  try {
    loaded = loadConfig({ defaultRoot: true, ...opts });
  } catch (e) {
    if (e.name !== 'ConfigError') throw e;
    out.push(`ERROR ${e.message}`);
    out.push(`to fix: ${configErrorAction(e, settingsUi(env))}`);
    return { code: 1, text: out.join('\n') };
  }
  const { config: c, file, source, stateDir, resultsDir, sources } = loaded;
  const note = (...keys) => sourceNote(sources, ...keys);
  let code = 0;

  out.push(file ? `settings file:  ${file}  (${source})` : `settings file:  none (cheap-eyes set writes ${loaded.writeTarget})`);
  if (loaded.settingsUi) out.push(`settings ui:    ${loaded.settingsUi}`);
  const resolved = await resolveReadRoots(c.read_roots);
  if (sources.read_roots === DEFAULT_ROOT_LABEL) {
    out.push(`read roots:     ${rootsSummary(loaded)}`);
  } else if (!resolved.length) {
    out.push(`read roots:     ${rootsSummary(loaded)}; file paths are refused, URLs work; to add one: ${rootsAction(loaded)}`);
  } else {
    out.push(`read roots:${sources.read_roots === 'file' ? '' : `  (${sources.read_roots})`}`);
    for (const [i, r] of resolved.entries()) {
      if (r.kind === 'missing') {
        code = 1;
        out.push(`  [${i + 1}] ${r.given}  MISSING (${r.error})`);
      } else {
        out.push(`  [${i + 1}] ${r.given}${r.real !== r.given ? `  -> ${r.real}` : ''}  (${r.kind})`);
      }
    }
  }
  const extraDeny = c.deny_globs.filter((g) => !DEFAULT_DENY_GLOBS.includes(g)).length;
  out.push(`deny globs:     ${c.deny_globs.join('  ')}  (built-in${extraDeny ? ` + ${extraDeny} from config` : ''})`);
  out.push(`state dir:      ${stateDir.path}  (${stateDir.source}; ${exists(stateDir.path) ? 'exists' : 'created on start'})`);
  out.push(`results dir:    ${resultsDir}`);
  if (c.write_roots.length === 0) {
    out.push(`export:         off (write_roots is empty)${note('write_roots')}`);
  } else {
    out.push('write roots:');
    for (const w of c.write_roots) out.push(`  ${w}${exists(w) ? '' : '  (does not exist)'}`);
    out.push(`export dir:     ${c.export_dir ?? '(none; per-call export_to only)'}`);
  }
  out.push(
    `retention:      results ${c.results_retention_days} d, max ${c.results_max_mb} MB; exports ${c.export_retention_days === 0 ? 'never deleted' : `${c.export_retention_days} d`}${note('results_retention_days', 'results_max_mb', 'export_retention_days')}`,
  );

  const aliases = Object.entries(c.models);
  const picked = aliases.length === 0;
  if (picked) {
    out.push(`models:         ${pinSummary(stateDir.path)}`);
    out.push('defaults:       auto for every mode (the settings name no models)');
  } else {
    out.push('models:');
    for (const [a, m] of aliases) {
      const params = Object.keys(m.params);
      out.push(`  ${a}: ${m.ids.join(', ')}${params.length ? `  params: ${JSON.stringify(m.params)}` : ''}`);
    }
    out.push(
      `defaults:       extract=${c.defaults.extract ?? '-'}  draft=${c.defaults.draft ?? '-'}  edits=${c.defaults.edits ?? '-'}  schema=${c.defaults.schema ?? `(extract: ${c.defaults.extract ?? '-'})`}${note('defaults')}`,
    );
  }
  out.push(`raw model ids:  ${c.allow_raw_model_ids ? 'allowed' : 'refused'}${note('allow_raw_model_ids')}`);
  if (c.max_price_usd_per_mtok) out.push(`price cap:      ${capText(c.max_price_usd_per_mtok)} tokens${note('max_price_usd_per_mtok')}`);
  else if (picked) out.push(`price cap:      ${capText(BUILTIN_CAP)} tokens (built-in, for picked models)`);
  else out.push(`price cap:      none${note('max_price_usd_per_mtok')}`);
  out.push(`max context:    ${c.max_context ?? 'live (from OpenRouter)'}${note('max_context')}`);
  out.push(`daily budget:   ${c.daily_budget_usd === null ? 'off (null)' : `$${c.daily_budget_usd}`}${note('daily_budget_usd')}`);
  out.push(
    `limits:         file ${c.max_file_bytes} B, job ${c.max_job_bytes} B, ${c.max_files} files, concurrency ${c.concurrency}, timeout ${c.timeout_s} s${note('max_file_bytes', 'max_job_bytes', 'max_files', 'concurrency', 'timeout_s')}`,
  );
  out.push(`documents:      raw ${c.max_doc_bytes} B (max_doc_bytes), extraction timeout ${c.extract_timeout_s} s${note('max_doc_bytes', 'extract_timeout_s')}`);
  out.push(
    `url input:      ${c.url_input ? `on, timeout ${c.url_timeout_s} s, max ${c.max_url_bytes} B per URL; contact ${c.url_contact || 'none (url_contact)'}` : 'off (url_input: false)'}${note('url_input', 'url_timeout_s', 'max_url_bytes', 'url_contact')}`,
  );
  out.push(`mask extra:     ${c.mask.extra_patterns.length} pattern(s)${note('mask')}`);
  out.push(`hook max bytes: ${c.hook.max_bytes}${note('hook')}`);
  out.push(`default tz:     ${c.time.default_tz}${note('time')}`);
  out.push(`openrouter key: ${hasOpenRouterKey(env) ? 'set' : 'NOT set'} (env CHEAP_EYES_OPENROUTER_KEY)`);
  let proxyFailed = false;
  out.push(`proxy:          ${launcherProxyLine(env, opts, () => (proxyFailed = true))}`);
  out.push(`runtime:        ${nodeRuntime()}`);
  out.push(`http serve:     default bind ${DEFAULT_HOST} with localhost Host/Origin checks; any other --host has none (token only); no default read root`);
  out.push(`http token:     ${tokenState(env, stateDir.path)}`);
  const problems = [...(code ? ['some read roots are missing'] : []), ...(proxyFailed ? ['the proxy cannot be used'] : [])];
  if (proxyFailed) code = 1;
  out.push(problems.length ? `ERROR: ${problems.join('; ')}` : 'OK');
  if (opts.live) {
    const live = await liveChecks({ loaded, env, fetch: opts.fetch ?? globalThis.fetch });
    out.push(...live.lines);
    if (live.failed) code = 1;
  }
  return { code, text: out.join('\n') };
}
