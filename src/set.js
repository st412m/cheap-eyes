// `cheap-eyes set <key> [<value>...]`: one key into the settings file (created with
// its folder when missing); no value removes the key, so the default applies. The
// result is validated before anything is written. Secrets never go into the file:
// the OpenRouter key and the HTTP token are refused by name and by value.
import fs from 'node:fs';
import { ConfigError, envValue, parseConfig, readSettingsFile } from './config.js';
import { pathApi } from './paths.js';

const PATHS = new Set(['state_dir', 'export_dir']);
const PATH_LISTS = new Set(['read_roots', 'write_roots']);
const LISTS = new Set(['deny_globs']);
const NUMBERS = new Set([
  'results_retention_days',
  'results_max_mb',
  'export_retention_days',
  'max_context',
  'max_file_bytes',
  'max_doc_bytes',
  'extract_timeout_s',
  'url_timeout_s',
  'max_url_bytes',
  'max_job_bytes',
  'max_files',
  'concurrency',
  'timeout_s',
  'daily_budget_usd',
  'hook.max_bytes',
  'max_price_usd_per_mtok.in',
  'max_price_usd_per_mtok.out',
]);
const BOOLS = new Set(['allow_raw_model_ids', 'url_input']);
const STRINGS = new Set(['url_contact', 'time.default_tz', 'defaults.extract', 'defaults.draft', 'defaults.edits', 'defaults.schema']);

const CAP = 'max_price_usd_per_mtok';
const CAP_USAGE = `${CAP} takes two numbers, in then out (USD per 1M tokens): cheap-eyes set ${CAP} <in> <out>; no value removes the cap; ${CAP}.in or .out changes one half of an existing cap`;

export const SETTABLE = [...PATHS, ...PATH_LISTS, ...LISTS, ...NUMBERS, ...BOOLS, ...STRINGS, CAP, 'models.<alias>'];

// Keys that name a secret: refused with where the secret belongs instead.
const SECRET_KEY_RE = /(^|[._])(key|api_key|openrouter_key|openrouter|token|http_token|password|secret)$/i;

function keyKind(key) {
  if (/^models\.[^.]+$/.test(key)) return 'models';
  if (key === CAP) return 'cap';
  if (PATHS.has(key)) return 'path';
  if (PATH_LISTS.has(key)) return 'path-list';
  if (LISTS.has(key)) return 'list';
  if (NUMBERS.has(key)) return 'number';
  if (BOOLS.has(key)) return 'bool';
  if (STRINGS.has(key)) return 'string';
  return null;
}

function refuseSecrets(key, words, env) {
  if (SECRET_KEY_RE.test(key)) {
    throw new ConfigError(
      `"${key}" is not a setting: secrets never go into the settings file. The OpenRouter key is the environment variable CHEAP_EYES_OPENROUTER_KEY (or \`cheap-eyes init\`); the HTTP token is env CHEAP_EYES_HTTP_TOKEN or the token file in the state folder`,
    );
  }
  const secrets = [envValue(env, 'CHEAP_EYES_OPENROUTER_KEY'), envValue(env, 'CHEAP_EYES_HTTP_TOKEN')].filter((s) => typeof s === 'string' && s.length >= 8);
  // The value itself is never echoed.
  if (words.some((w) => /^sk-or-/i.test(w) || secrets.some((s) => w.includes(s)))) {
    throw new ConfigError(`the value for ${key} looks like the OpenRouter key or the HTTP token: secrets never go into the settings file`);
  }
}

function unknown(key) {
  return new ConfigError(`unknown setting "${key}"; settings: ${SETTABLE.join(', ')}`);
}

/** The JSON value of `set <key> <words...>`; throws ConfigError with a hint. */
export function settingValue(key, words, { cwd = process.cwd(), platform = process.platform } = {}) {
  const kind = keyKind(key);
  if (!kind) throw unknown(key);
  const api = pathApi(platform);
  if (kind === 'path-list') return words.map((w) => api.resolve(cwd, w));
  if (kind === 'list') return [...words];
  if (kind === 'models') {
    const ids = words
      .flatMap((w) => w.split(','))
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) throw new ConfigError(`${key} takes model ids separated by commas`);
    return ids;
  }
  if (kind === 'cap') {
    if (words.length !== 2 || !words.every((w) => /^\d+(?:\.\d+)?$/.test(w))) throw new ConfigError(CAP_USAGE);
    return { in: Number(words[0]), out: Number(words[1]) };
  }
  if (words.length !== 1) throw new ConfigError(`${key} takes one value${kind === 'string' ? ' (quote it when it has spaces)' : ''}`);
  const w = words[0];
  if (kind === 'path') return api.resolve(cwd, w);
  if (kind === 'bool') {
    const l = w.toLowerCase();
    if (l === 'on' || l === 'true') return true;
    if (l === 'off' || l === 'false') return false;
    throw new ConfigError(`${key} takes on or off, got "${w}"`);
  }
  if (kind === 'number') {
    if (key === 'daily_budget_usd' && w.toLowerCase() === 'off') return null;
    if (!/^-?\d+(?:\.\d+)?$/.test(w)) throw new ConfigError(`${key} takes a number${key === 'daily_budget_usd' ? ' of USD or "off"' : ''}, got "${w}"`);
    return Number(w);
  }
  return w;
}

/**
 * Apply `set <key> [<words...>]` to the raw settings object; returns a new object.
 * models.<alias>: the ids are replaced; the params of an existing alias are kept,
 * a new alias gets reasoning effort "none" (cheap models spend the output cap on
 * reasoning otherwise). A nested object left empty by a removal is removed too.
 */
export function applySetting(current, key, words, opts = {}) {
  const next = structuredClone(current);
  const [top, sub] = key.split(/\.(.*)/s);
  if (!words.length) {
    if (!keyKind(key)) throw unknown(key);
    if (sub === undefined) delete next[top];
    else if (next[top] && typeof next[top] === 'object') {
      delete next[top][sub];
      if (Object.keys(next[top]).length === 0) delete next[top];
    }
    return { next, value: undefined };
  }
  const value = settingValue(key, words, opts);
  if (sub === undefined) next[top] = value;
  else {
    const parent = next[top] && typeof next[top] === 'object' && !Array.isArray(next[top]) ? next[top] : {};
    if (top === 'models') {
      const prev = parent[sub];
      parent[sub] = prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...prev, ids: value } : { ids: value, params: { reasoning: { effort: 'none' } } };
    } else parent[sub] = value;
    next[top] = parent;
  }
  return { next, value: sub !== undefined && top === 'models' ? next.models[sub] : value };
}

/**
 * Write one key into `file`. Nothing is written when the result does not validate.
 * Returns { file, value, removed }.
 */
export function writeSetting(file, key, words, { cwd = process.cwd(), platform = process.platform, env = process.env, rename = fs.renameSync } = {}) {
  refuseSecrets(key, words, env);
  let current = {};
  if (fs.existsSync(file)) current = readSettingsFile(file);
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new ConfigError(`${file}: must be a JSON object`, { file });
  const { next, value } = applySetting(current, key, words, { cwd, platform });
  parseConfig(next, { platform, file });
  fs.mkdirSync(pathApi(platform).dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  try {
    rename(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Already gone.
    }
    throw e;
  }
  return { file, value, removed: !words.length };
}

// Folders named by a written value that do not exist: the value is kept (the folder
// may be created later, or appear when a drive is mounted) and a warning names them.
const FOLDER_KEYS = new Set(['read_roots', 'write_roots', 'export_dir', 'state_dir']);

export function missingFolders(key, value) {
  if (!FOLDER_KEYS.has(key) || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((p) => !fs.existsSync(p));
}

// The value of a dotted key in a loaded config, for the "now" line.
export function valueAt(config, key) {
  const [top, sub] = key.split(/\.(.*)/s);
  return sub === undefined ? config[top] : config[top]?.[sub];
}
