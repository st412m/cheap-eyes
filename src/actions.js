// What a person does about a refusal, built from the environment the server runs in:
// the settings UI of the launcher when there is one (named by CHEAP_EYES_SETTINGS_UI),
// else the environment variable the value came from, else `cheap-eyes set`. Every refusal text that names
// a setting ends with one of these. Never a secret: no key, token or proxy URL.
import path from 'node:path';
import { envValue } from './config.js';

const ENV_OF = {
  read_roots: 'CHEAP_EYES_READ_ROOTS',
  daily_budget_usd: 'CHEAP_EYES_DAILY_BUDGET_USD',
};

// The proxy a stdio launcher passes (src/stdio-proxy.js), and how it was switched on:
// 'in-process' or 'restart'.
export const PROXY_ENV = 'CHEAP_EYES_HTTPS_PROXY';
export const VIA_ENV = 'CHEAP_EYES_PROXY_VIA';

// Node's fetch honours HTTPS_PROXY only with NODE_USE_ENV_PROXY=1 or --use-env-proxy
// (Node >= 22.21 / 24). The proxy URL is never printed: it may carry credentials.
export function proxyState(env = process.env, execArgv = process.execArgv, nodeVersion = process.versions.node) {
  if (!env.HTTPS_PROXY && !env.https_proxy) return 'direct';
  const on =
    env.NODE_USE_ENV_PROXY === '1' || /(?:^|\s)--use-env-proxy(?:\s|$)/.test(env.NODE_OPTIONS ?? '') || execArgv.includes('--use-env-proxy');
  if (!on) return 'direct (HTTPS_PROXY is set, but without NODE_USE_ENV_PROXY=1 Node ignores it)';
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (major === 22 && minor < 21) return `direct (HTTPS_PROXY is set, but Node ${nodeVersion} < 22.21 ignores it)`;
  return 'HTTPS_PROXY set';
}

// proxyState, plus where the proxy came from when the launcher passed it.
export function proxyDescription(env = process.env, execArgv = process.execArgv, nodeVersion = process.versions.node) {
  const state = proxyState(env, execArgv, nodeVersion);
  if (state !== 'HTTPS_PROXY set') return state;
  if (env[VIA_ENV] === 'in-process') return `HTTPS_PROXY set (from ${PROXY_ENV}, switched on in this process)`;
  if (env[VIA_ENV] === 'restart') return `HTTPS_PROXY set (from ${PROXY_ENV}, in a restarted process)`;
  return state;
}

// The runtime and the proxy path, for eyes_stats and the start lines: a Node built into
// an application (Electron) is named as such. Never the proxy URL.
export function nodeRuntime(versions = process.versions) {
  return versions.electron ? `Node ${versions.node} (built into an application: Electron ${versions.electron})` : `Node ${versions.node}`;
}

export function runtimeLine(env = process.env, versions = process.versions, execArgv = process.execArgv) {
  return `${nodeRuntime(versions)}; proxy: ${proxyDescription(env, execArgv, versions.node)}`;
}

// The settings UI of the Docker image: settings are variables of the container and
// folders are mounts, so the texts below name the variable or the mount.
export const CONTAINER_UI = 'the environment of the container';
const RECREATE = 'then recreate the container (docker compose up -d, or docker run again)';
const CONTAINER_ENV = (name, value) => `set ${name}=${value} in the environment of the container (docker run -e, or environment: in compose.yaml), ${RECREATE}`;

export function settingsUi(env = process.env) {
  return envValue(env, 'CHEAP_EYES_SETTINGS_UI') ?? null;
}

// The settings UIs of the Claude Desktop extension and the Home Assistant app, which
// have a proxy setting of their own.
export const EXTENSION_UI = 'the extension settings in Claude Desktop';
export const HA_APP_UI = 'the app options in Home Assistant';

// Where the proxy is set in a settings UI.
export function proxySetting(ui) {
  if (ui === EXTENSION_UI) return `the Proxy field in ${ui}`;
  if (ui === HA_APP_UI) return `the https_proxy option in ${ui}`;
  return `the proxy setting in ${ui}`;
}

/**
 * The action for one setting. `loaded`: the result of loadConfig (or any object with
 * `settingsUi` and `sources`); a bare ctx without them gets the `cheap-eyes set` form.
 */
export function settingAction(field, loaded = {}, example = '<value>') {
  const ui = loaded.settingsUi;
  if (ui === CONTAINER_UI) {
    if (ENV_OF[field]) return CONTAINER_ENV(ENV_OF[field], field === 'daily_budget_usd' ? '<usd> (or off)' : example);
    return `mount a settings file into the container, set CHEAP_EYES_CONFIG to its path inside the container and set ${field} in it, ${RECREATE}`;
  }
  if (ui) return `set ${field} in ${ui}`;
  const src = loaded.sources?.[field];
  if (typeof src === 'string' && src.startsWith('env ')) return `change the environment variable ${src.slice(4)} where the server is started, and restart it`;
  if (src === 'arguments') return `change the arguments the client starts cheap-eyes with, and restart it`;
  return `run \`cheap-eyes set ${field} ${example}\` and restart the server`;
}

// read_roots: the same order, worded for adding a folder; when the default project
// folder was refused, why, and the other way to get one.
export function rootsAction(loaded = {}, delimiter = path.delimiter) {
  const ui = loaded.settingsUi;
  if (ui === CONTAINER_UI) {
    const base = loaded.config?.read_roots?.[0] ?? '/input';
    return `mount a folder of the host under ${base} (docker run -v /folder/on/host:${base}/name:ro, or a volumes: line in compose.yaml), ${RECREATE}`;
  }
  if (ui) return `add a folder to read_roots in ${ui}`;
  const src = loaded.sources?.read_roots;
  if (src === `env ${ENV_OF.read_roots}`) {
    return `add a folder to the environment variable ${ENV_OF.read_roots} (separator "${delimiter}") where the server is started, and restart it`;
  }
  if (src === 'arguments') return 'add a folder to the arguments the client starts cheap-eyes with, and restart it';
  const d = loaded.defaultRoot;
  const refused = d && d.path === null ? `the project folder ${d.candidate} is not used as a default (${d.reason}): open the client in a project folder, or ` : '';
  return `${refused}run \`cheap-eyes set read_roots <dir>...\` (the whole list, one folder per argument) and restart the server`;
}

// The read roots in force, for refusals: "none" or the list.
export function rootsInForce(roots) {
  return roots.length ? roots.join(', ') : 'none';
}

// The daily budget refusal: where the value comes from and how to change it.
export function budgetAction(loaded = {}) {
  const src = loaded.sources?.daily_budget_usd;
  let where = '';
  if (src === 'file') where = `daily_budget_usd is set in ${loaded.file}; `;
  else if (src === 'default') where = 'daily_budget_usd is the default; ';
  else if (typeof src === 'string') where = `daily_budget_usd comes from ${src}; `;
  return `${where}to change it: ${settingAction('daily_budget_usd', loaded, '<usd>')}`;
}

export function noKeyText(env = process.env) {
  const ui = settingsUi(env);
  if (ui === CONTAINER_UI) return `OpenRouter key is not set: ${CONTAINER_ENV('CHEAP_EYES_OPENROUTER_KEY', '<key>')}; with compose, the .env file next to compose.yaml is the place`;
  if (ui) return `OpenRouter key is not set (env CHEAP_EYES_OPENROUTER_KEY): set the OpenRouter key in ${ui} and restart the server`;
  return 'OpenRouter key is not set: set the environment variable CHEAP_EYES_OPENROUTER_KEY where the server is started, or run `cheap-eyes init`, then restart the server';
}

export const REGION_TEXT = 'OpenRouter refuses requests from this network (some regions are blocked). A proxy is needed';

// HTTP 403 on a public catalogue call: the region text and how to set a proxy here.
// With a settings UI the proxy is set there, whatever HTTPS_PROXY the process inherited
// from the launcher.
export function regionBlockedText(env = process.env) {
  const ui = settingsUi(env);
  const state = proxyState(env);
  let action;
  if (ui === CONTAINER_UI) {
    action = state === 'HTTPS_PROXY set' ? `the proxy in HTTPS_PROXY is refused too: point HTTPS_PROXY of the container at a proxy in another region, ${RECREATE}` : `set HTTPS_PROXY=<proxy URL> and NODE_USE_ENV_PROXY=1 in the environment of the container, ${RECREATE}`;
  } else if (ui) {
    action = state === 'HTTPS_PROXY set' ? `the proxy in use is refused too: put a proxy in another region into ${proxySetting(ui)} and restart the server` : `fill ${proxySetting(ui)} (http://host:port) and restart the server`;
  } else if (state === 'HTTPS_PROXY set') {
    action = 'the proxy in HTTPS_PROXY is refused too: point it at a proxy in another region and restart the server';
  } else if (state !== 'direct') {
    action = `the proxy is not in use: ${state.replace(/^direct \(|\)$/g, '')}; fix that and restart the server`;
  } else {
    action = 'set HTTPS_PROXY=<proxy URL> and NODE_USE_ENV_PROXY=1 in the environment of the server and restart it';
  }
  return `${REGION_TEXT}: ${action}`;
}

// A proxy of the launcher that could not be switched on (stdio setup state): why, and
// what to do. `why` never carries the proxy URL.
export function proxyFailText(why, env = process.env, { restarted = false, nodeVersion = process.versions.node } = {}) {
  const ui = settingsUi(env);
  const where = ui && ui !== CONTAINER_UI ? proxySetting(ui) : `the environment variable ${PROXY_ENV}`;
  const how = restarted ? ` Node ${nodeVersion} has no http.setGlobalProxyFromEnv (Node 24.14 or newer has it), so the server started itself again with the proxy, and that failed.` : '';
  const fix = restarted ? `run cheap-eyes on Node 24.14 or newer, or empty ${where} to connect directly` : `empty ${where} to connect directly`;
  return `the proxy in ${PROXY_ENV} could not be switched on: ${why}.${how}\nto fix: ${fix}, and restart the server`;
}

// A settings file or variable that cannot be used (stdio setup state, check-config,
// serve): what to fix. `e`: a ConfigError.
export function configErrorAction(e, ui = null) {
  if (e.kind === 'config-missing') return 'create that file or unset CHEAP_EYES_CONFIG, then restart the server';
  if (ui === CONTAINER_UI) {
    if (e.envVar) return `fix the environment variable ${e.envVar} of the container, ${RECREATE}`;
    return `fix the settings file ${e.file ?? '(CHEAP_EYES_CONFIG)'} mounted into the container, ${RECREATE}`;
  }
  if (e.envVar) {
    return ui ? `fix the value in ${ui} (environment variable ${e.envVar}) and restart the server` : `fix the environment variable ${e.envVar} where the server is started, and restart it`;
  }
  if (ui) return `fix the settings in ${ui} and restart the server`;
  if (e.kind === 'json') return `fix the JSON in ${e.file}, then restart the server`;
  if (e.kind === 'unreadable') return `make ${e.file} readable, then restart the server`;
  return `fix the fields named above in ${e.file}, or run \`cheap-eyes set <key> <value>\` (no value removes the key), then restart the server; \`cheap-eyes check-config\` lists every problem`;
}
