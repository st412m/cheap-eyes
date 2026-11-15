// Settings: lookup, validation and path resolution. Sources in order: arguments >
// environment > settings file > defaults; no file is not an error. No network, no writes.
import fs from 'node:fs';
import os from 'node:os';
import { z } from 'zod';
import { refusedSuffix, refusedSuffixMessage } from './model-ids.js';
import { isAbsoluteStrict, isInside, pathApi, pathSegments } from './paths.js';

export const DEFAULT_DENY_GLOBS = ['.env*', '*.key', '*.pem', 'id_*', 'secrets.yaml', '*.db', '.git/**', 'node_modules/**'];

// The only keys `models.<alias>.params` may carry: sampling and reasoning knobs.
// Everything else in the request body (routing, provider, plugins, tools, output
// cap, streaming, format) is owned by the server.
export const ALLOWED_PARAMS = [
  'reasoning',
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'top_a',
  'seed',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'stop',
];

const MB = 1024 * 1024;

// `kind`: config-missing | unreadable | json | invalid | env; `envVar`: the variable
// whose value was refused. Both pick the action text (actions.js).
export class ConfigError extends Error {
  constructor(message, { file, kind = 'invalid', envVar } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.file = file;
    this.kind = kind;
    if (envVar) this.envVar = envVar;
  }
}

function makeSchema(platform) {
  const absPath = z.string().refine((p) => isAbsoluteStrict(p, platform), {
    message: platform === 'win32' ? 'must be an absolute path (drive letter or \\\\host\\share)' : 'must be an absolute path',
  });
  const posInt = z.number().int().positive();
  const modelId = z
    .string()
    .min(1)
    .superRefine((id, ctx) => {
      const s = refusedSuffix(id);
      if (s) ctx.addIssue({ code: 'custom', message: refusedSuffixMessage(s) });
    });
  const alias = z.string().regex(/^[A-Za-z0-9_-]+$/, 'alias may contain only letters, digits, "_" and "-"');

  const model = z.strictObject({
    ids: z.array(modelId).min(1),
    params: z.record(z.string(), z.unknown()).optional().default({}).superRefine((params, ctx) => {
      for (const k of Object.keys(params)) {
        if (!ALLOWED_PARAMS.includes(k)) {
          ctx.addIssue({ code: 'custom', path: [k], message: `"${k}" is not allowed; allowed: ${ALLOWED_PARAMS.join(', ')}` });
        }
      }
    }),
  });

  return z
    .strictObject({
      // Free text for humans (JSON has no comments); ignored by the server.
      $comment: z.union([z.string(), z.array(z.string())]).optional(),
      // Empty is allowed: URL jobs still work, file paths are refused with the action.
      read_roots: z.array(absPath).default([]),
      // Added to the built-in list, never replacing it.
      deny_globs: z
        .array(z.string().min(1))
        .default([])
        .transform((extra) => [...new Set([...DEFAULT_DENY_GLOBS, ...extra])]),
      state_dir: absPath.optional(),
      results_retention_days: posInt.default(14),
      results_max_mb: posInt.default(500),
      write_roots: z.array(absPath).default([]),
      export_dir: absPath.optional(),
      export_retention_days: z.number().int().min(0).default(0),
      models: z.record(alias, model).default({}),
      defaults: z
        .strictObject({ extract: alias.optional(), draft: alias.optional(), edits: alias.optional(), schema: alias.optional() })
        .default({}),
      max_price_usd_per_mtok: z.strictObject({ in: z.number().positive(), out: z.number().positive() }).optional(),
      max_context: posInt.optional(),
      allow_raw_model_ids: z.boolean().default(false),
      // null switches the local cap off explicitly; absent means the default.
      daily_budget_usd: z.number().positive().nullable().default(1.0),
      // Plain text files: the file; extracted formats: the extracted text.
      max_file_bytes: posInt.default(2 * MB),
      // Raw size of a file of any format but plain text before extraction.
      max_doc_bytes: posInt.default(50 * MB),
      extract_timeout_s: posInt.default(60),
      // http(s) URLs in files[]: fetched by the server.
      url_input: z.boolean().default(true),
      // A contact added to the User-Agent of URL fetches (some sites refuse
      // undeclared automated clients). Empty = none. It goes into an HTTP header,
      // hence the character rules.
      url_contact: z
        .string()
        .default('')
        .superRefine((v, ctx) => {
          if (v === '') return;
          if (v.length > 100) ctx.addIssue({ code: 'custom', message: 'at most 100 characters' });
          if (!/^[\x20-\x7e]+$/.test(v)) ctx.addIssue({ code: 'custom', message: 'printable ASCII only (no control characters, CR or LF)' });
          if (/[();]/.test(v)) ctx.addIssue({ code: 'custom', message: 'must not contain "(", ")" or ";"' });
        }),
      url_timeout_s: posInt.default(30),
      max_url_bytes: posInt.default(10 * MB),
      max_job_bytes: posInt.default(5 * MB),
      max_files: posInt.default(200),
      concurrency: posInt.default(3),
      timeout_s: posInt.default(180),
      mask: z
        .strictObject({
          extra_patterns: z.array(z.string().min(1)).default([]).superRefine((pats, ctx) => {
            pats.forEach((p, i) => {
              try {
                new RegExp(p, 'g');
              } catch (e) {
                ctx.addIssue({ code: 'custom', path: [i], message: `invalid regular expression: ${e.message}` });
              }
            });
          }),
        })
        .default({ extra_patterns: [] }),
      hook: z.strictObject({ max_bytes: posInt.default(30720) }).default({ max_bytes: 30720 }),
      time: z
        .strictObject({
          default_tz: z.string().default('UTC').refine(isValidTimeZone, { message: 'unknown IANA time zone' }),
        })
        .default({ default_tz: 'UTC' }),
    })
    .superRefine((cfg, ctx) => {
      for (const mode of ['extract', 'draft', 'edits', 'schema']) {
        const a = cfg.defaults[mode];
        if (a !== undefined && !Object.hasOwn(cfg.models, a)) {
          ctx.addIssue({ code: 'custom', path: ['defaults', mode], message: `alias "${a}" is not defined in models` });
        }
      }
      if (cfg.export_dir !== undefined) {
        if (cfg.write_roots.length === 0) {
          ctx.addIssue({ code: 'custom', path: ['export_dir'], message: 'export_dir needs write_roots (write_roots is empty, export is off)' });
        } else if (!cfg.write_roots.some((r) => isInside(cfg.export_dir, r, platform))) {
          ctx.addIssue({ code: 'custom', path: ['export_dir'], message: 'must lie inside one of write_roots' });
        }
      }
    });
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function fieldName(pathArr) {
  let s = '';
  for (const p of pathArr) s += typeof p === 'number' ? `[${p}]` : s ? `.${p}` : String(p);
  return s || '(root)';
}

export function formatZodError(error) {
  const lines = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const k of issue.keys) lines.push(`unknown field "${fieldName([...issue.path, k])}"`);
    } else {
      lines.push(`field "${fieldName(issue.path)}": ${issue.message}`);
    }
  }
  return lines;
}

// An empty value, or the placeholder a launcher leaves for a form field nobody filled
// in (a desktop extension's `${user_config.x}`), counts as not set.
export const PLACEHOLDER_RE = /^\$\{user_config\.[A-Za-z0-9_]+\}$/;

export function envValue(env, name) {
  const v = env[name];
  return v === undefined || v === '' || PLACEHOLDER_RE.test(v) ? undefined : v;
}

// Candidate config files in lookup order; the first existing file wins.
export function configCandidates({ env = process.env, cwd = process.cwd(), platform = process.platform, homedir = os.homedir() } = {}) {
  const api = pathApi(platform);
  const list = [];
  const fromEnv = envValue(env, 'CHEAP_EYES_CONFIG');
  if (fromEnv) list.push({ path: api.resolve(cwd, fromEnv), source: 'env CHEAP_EYES_CONFIG', required: true });
  list.push({ path: api.join(cwd, 'cheap-eyes.json'), source: './cheap-eyes.json' });
  if (platform === 'win32') {
    const appData = envValue(env, 'APPDATA') ?? api.join(homedir, 'AppData', 'Roaming');
    list.push({ path: api.join(appData, 'cheap-eyes', 'config.json'), source: 'user config (%APPDATA%)' });
  } else {
    list.push({ path: api.join(homedir, '.config', 'cheap-eyes', 'config.json'), source: 'user config (~/.config)' });
  }
  return list;
}

export function defaultStateDir({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  const api = pathApi(platform);
  if (platform === 'win32') {
    const local = envValue(env, 'LOCALAPPDATA') ?? api.join(homedir, 'AppData', 'Local');
    return api.join(local, 'cheap-eyes');
  }
  return api.join(homedir, '.local', 'state', 'cheap-eyes');
}

// env CHEAP_EYES_STATE_DIR > config state_dir > per-OS default.
export function resolveStateDir(cfg, { env = process.env, platform = process.platform, homedir = os.homedir(), cwd = process.cwd() } = {}) {
  const api = pathApi(platform);
  const fromEnv = envValue(env, 'CHEAP_EYES_STATE_DIR');
  if (fromEnv) return { path: api.resolve(cwd, fromEnv), source: 'env CHEAP_EYES_STATE_DIR' };
  if (cfg.state_dir) return { path: api.resolve(cfg.state_dir), source: 'config state_dir' };
  return { path: defaultStateDir({ env, platform, homedir }), source: 'default' };
}

function parseJsonFile(file, text) {
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    // The engine message may quote a slice of the file; report only the position.
    const m = /position (\d+)/.exec(e.message);
    let where = '';
    if (m) {
      const before = text.slice(0, Number(m[1]));
      const line = before.split('\n').length;
      const col = Number(m[1]) - before.lastIndexOf('\n');
      where = ` at line ${line}, column ${col}`;
    }
    throw new ConfigError(`${file}: not valid JSON${where}`, { file, kind: 'json' });
  }
}

// Read and parse a settings file without validating it (`cheap-eyes set` edits the raw object).
export function readSettingsFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`${file}: cannot read (${e.code ?? e.message})`, { file, kind: 'unreadable' });
  }
  return parseJsonFile(file, text);
}

export function parseConfig(raw, { platform = process.platform, file = '(config)' } = {}) {
  const result = makeSchema(platform).safeParse(raw);
  if (!result.success) {
    const lines = formatZodError(result.error);
    throw new ConfigError(`${file}: invalid config\n  ${lines.join('\n  ')}`, { file });
  }
  const api = pathApi(platform);
  const cfg = result.data;
  cfg.read_roots = cfg.read_roots.map((p) => api.resolve(p));
  cfg.write_roots = cfg.write_roots.map((p) => api.resolve(p));
  if (cfg.export_dir) cfg.export_dir = api.resolve(cfg.export_dir);
  return cfg;
}

// The settings file in force: the first existing candidate. With none, the file
// `cheap-eyes set` would create: CHEAP_EYES_CONFIG when set, else the user config.
// Returns { hit, target, candidates }; `hit` is null when no file exists.
export function findSettingsFile(opts = {}) {
  const candidates = configCandidates(opts);
  let hit = null;
  for (const c of candidates) {
    if (fs.existsSync(c.path)) {
      hit = c;
      break;
    }
    if (c.required) break;
  }
  const target = hit ?? (candidates[0].required ? candidates[0] : candidates[candidates.length - 1]);
  return { hit, target, candidates };
}

// Top-level settings keys, for the per-key source labels.
export const SETTING_KEYS = Object.keys(makeSchema('linux').shape).filter((k) => k !== '$comment');

const ROOTS_ENV = 'CHEAP_EYES_READ_ROOTS';
const BUDGET_ENV = 'CHEAP_EYES_DAILY_BUDGET_USD';

// CHEAP_EYES_READ_ROOTS: absolute paths joined by the platform's path delimiter
// (";" on Windows, ":" elsewhere); empty items dropped. Undefined when not set.
export function readRootsFromEnv(env = process.env, platform = process.platform) {
  const raw = envValue(env, ROOTS_ENV);
  if (raw === undefined) return undefined;
  const api = pathApi(platform);
  const items = raw
    .split(api.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) return undefined;
  const bad = items.filter((p) => !isAbsoluteStrict(p, platform));
  if (bad.length) {
    throw new ConfigError(`env ${ROOTS_ENV}: every item must be an absolute path (separator "${api.delimiter}"): ${bad.map((b) => JSON.stringify(b)).join(', ')}`, {
      kind: 'env',
      envVar: ROOTS_ENV,
    });
  }
  return items.map((p) => api.resolve(p));
}

// CHEAP_EYES_DAILY_BUDGET_USD: a positive number, or "off" for null (no local cap).
export function budgetFromEnv(env = process.env) {
  const raw = envValue(env, BUDGET_ENV);
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (v.toLowerCase() === 'off') return null;
  const n = /^\d+(?:\.\d+)?$/.test(v) ? Number(v) : NaN;
  if (!(n > 0)) throw new ConfigError(`env ${BUDGET_ENV}: must be a positive number of USD or "off", got ${JSON.stringify(raw)}`, { kind: 'env', envVar: BUDGET_ENV });
  return n;
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The read root a stdio server uses when no source gives one: the client's project
 * folder (CLAUDE_PROJECT_DIR, which Claude Code sets for the servers it spawns, when
 * it is an absolute existing directory), else the working directory. Resolved with
 * realpath and refused when it is the home directory, an ancestor of it or a
 * filesystem or drive root: a default must never open a whole home or disk.
 * Returns { path, from } or { path: null, candidate, reason }.
 */
export function defaultReadRoot({
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  homedir = os.homedir(),
  realpath = fs.realpathSync.native,
  isDir = isDirectory,
} = {}) {
  const proj = envValue(env, 'CLAUDE_PROJECT_DIR');
  const useProj = proj !== undefined && isAbsoluteStrict(proj, platform) && isDir(proj);
  const given = useProj ? proj : cwd;
  const from = useProj ? 'CLAUDE_PROJECT_DIR' : 'working directory';
  let real;
  try {
    real = realpath(given);
  } catch (e) {
    return { path: null, candidate: given, reason: `cannot resolve it: ${e.code ?? e.message}` };
  }
  let home = homedir;
  try {
    home = realpath(homedir);
  } catch {
    // An unresolvable home is compared as given.
  }
  if (pathSegments(real, platform).length === 1) return { path: null, candidate: real, reason: platform === 'win32' ? 'it is a drive root' : 'it is the filesystem root' };
  if (isInside(home, real, platform)) {
    return { path: null, candidate: real, reason: isInside(real, home, platform) ? 'it is the home directory' : 'it contains the home directory' };
  }
  return { path: real, from };
}

export const DEFAULT_ROOT_LABEL = 'default: project folder';

/**
 * Find, read and validate the settings and apply the higher sources. Returns
 * { config, file, source, searched, writeTarget, sources, settingsUi, defaultRoot,
 *   stateDir, resultsDir }. `file` is null when no settings file exists.
 * `args`: read roots given as arguments (stdio). `defaultRoot`: true only for stdio;
 * `serve --http` has no default root.
 * `sources[key]`: "file", "default", "env NAME", "arguments", DEFAULT_ROOT_LABEL or
 * "none" (read_roots given by no source and no default).
 */
export function loadConfig(opts = {}) {
  const { env = process.env, cwd = process.cwd(), platform = process.platform, homedir = os.homedir(), args, defaultRoot = false } = opts;
  const api = pathApi(platform);
  const { hit, target, candidates } = findSettingsFile({ env, cwd, platform, homedir });
  if (!hit && target.required) throw new ConfigError(`config file from env CHEAP_EYES_CONFIG not found: ${target.path}`, { file: target.path, kind: 'config-missing' });
  const raw = hit ? readSettingsFile(hit.path) : {};
  const config = parseConfig(raw, { platform, file: hit?.path });

  const sources = {};
  for (const k of SETTING_KEYS) sources[k] = Object.hasOwn(raw, k) ? 'file' : 'default';

  const envRoots = readRootsFromEnv(env, platform);
  const argRoots = args?.length ? args.map((a) => api.resolve(cwd, a)) : undefined;
  let rootInfo = null;
  if (argRoots) {
    config.read_roots = argRoots;
    sources.read_roots = 'arguments';
  } else if (envRoots) {
    config.read_roots = envRoots;
    sources.read_roots = `env ${ROOTS_ENV}`;
  } else if (sources.read_roots === 'default') {
    // An explicit list in the file, even an empty one, counts as given.
    sources.read_roots = 'none';
    if (defaultRoot) {
      rootInfo = defaultReadRoot({ env, cwd, platform, homedir, ...opts.defaultRootDeps });
      if (rootInfo.path) {
        config.read_roots = [rootInfo.path];
        sources.read_roots = DEFAULT_ROOT_LABEL;
      }
    }
  }

  const envBudget = budgetFromEnv(env);
  if (envBudget !== undefined) {
    config.daily_budget_usd = envBudget;
    sources.daily_budget_usd = `env ${BUDGET_ENV}`;
  }

  const stateDir = resolveStateDir(config, { env, platform, homedir, cwd });
  if (stateDir.source.startsWith('env ')) sources.state_dir = stateDir.source;
  return {
    config,
    file: hit?.path ?? null,
    source: hit?.source ?? null,
    searched: candidates.map((c) => c.path),
    writeTarget: target.path,
    sources,
    settingsUi: envValue(env, 'CHEAP_EYES_SETTINGS_UI') ?? null,
    defaultRoot: rootInfo,
    stateDir,
    resultsDir: api.join(stateDir.path, 'results'),
  };
}

// Realpath and kind of every read root; missing roots are reported, not thrown.
export async function resolveReadRoots(roots) {
  const out = [];
  for (const given of roots) {
    try {
      const real = await fs.promises.realpath(given);
      const st = await fs.promises.stat(real);
      out.push({ given, real, kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other' });
    } catch (e) {
      out.push({ given, real: null, kind: 'missing', error: e.code ?? e.message });
    }
  }
  return out;
}

// The OpenRouter key, or null: an empty value or an unfilled launcher placeholder is
// no key and never goes to OpenRouter.
export function openRouterKey(env = process.env) {
  return envValue(env, 'CHEAP_EYES_OPENROUTER_KEY') ?? null;
}

export function hasOpenRouterKey(env = process.env) {
  return openRouterKey(env) !== null;
}
