// Config lookup, validation and path resolution. No network, no writes.
import fs from 'node:fs';
import os from 'node:os';
import { z } from 'zod';
import { refusedSuffix, refusedSuffixMessage } from './model-ids.js';
import { isAbsoluteStrict, isInside, pathApi } from './paths.js';

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

export class ConfigError extends Error {
  constructor(message, { file } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.file = file;
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
      read_roots: z.array(absPath).min(1, 'at least one read root is required'),
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
        .strictObject({ extract: alias.optional(), draft: alias.optional(), edits: alias.optional() })
        .default({}),
      max_price_usd_per_mtok: z.strictObject({ in: z.number().positive(), out: z.number().positive() }).optional(),
      max_context: posInt.optional(),
      allow_raw_model_ids: z.boolean().default(false),
      // null switches the local cap off explicitly; absent means the default.
      daily_budget_usd: z.number().positive().nullable().default(1.0),
      max_file_bytes: posInt.default(2 * MB),
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
      for (const mode of ['extract', 'draft', 'edits']) {
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

function envOrUndefined(env, name) {
  const v = env[name];
  return v === undefined || v === '' ? undefined : v;
}

// Candidate config files in lookup order; the first existing file wins.
export function configCandidates({ env = process.env, cwd = process.cwd(), platform = process.platform, homedir = os.homedir() } = {}) {
  const api = pathApi(platform);
  const list = [];
  const fromEnv = envOrUndefined(env, 'CHEAP_EYES_CONFIG');
  if (fromEnv) list.push({ path: api.resolve(cwd, fromEnv), source: 'env CHEAP_EYES_CONFIG', required: true });
  list.push({ path: api.join(cwd, 'cheap-eyes.json'), source: './cheap-eyes.json' });
  if (platform === 'win32') {
    const appData = envOrUndefined(env, 'APPDATA') ?? api.join(homedir, 'AppData', 'Roaming');
    list.push({ path: api.join(appData, 'cheap-eyes', 'config.json'), source: 'user config (%APPDATA%)' });
  } else {
    list.push({ path: api.join(homedir, '.config', 'cheap-eyes', 'config.json'), source: 'user config (~/.config)' });
  }
  return list;
}

export function defaultStateDir({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  const api = pathApi(platform);
  if (platform === 'win32') {
    const local = envOrUndefined(env, 'LOCALAPPDATA') ?? api.join(homedir, 'AppData', 'Local');
    return api.join(local, 'cheap-eyes');
  }
  return api.join(homedir, '.local', 'state', 'cheap-eyes');
}

// env CHEAP_EYES_STATE_DIR > config state_dir > per-OS default.
export function resolveStateDir(cfg, { env = process.env, platform = process.platform, homedir = os.homedir(), cwd = process.cwd() } = {}) {
  const api = pathApi(platform);
  const fromEnv = envOrUndefined(env, 'CHEAP_EYES_STATE_DIR');
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
    throw new ConfigError(`${file}: not valid JSON${where}`, { file });
  }
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

// Find, read and validate the config. Returns { config, file, source, searched, stateDir, resultsDir }.
export function loadConfig(opts = {}) {
  const { env = process.env, cwd = process.cwd(), platform = process.platform, homedir = os.homedir() } = opts;
  const api = pathApi(platform);
  const candidates = configCandidates({ env, cwd, platform, homedir });
  let hit;
  for (const c of candidates) {
    if (fs.existsSync(c.path)) {
      hit = c;
      break;
    }
    if (c.required) throw new ConfigError(`config file from env CHEAP_EYES_CONFIG not found: ${c.path}`, { file: c.path });
  }
  if (!hit) {
    throw new ConfigError(`no config file found; looked in:\n  ${candidates.map((c) => c.path).join('\n  ')}`);
  }
  let text;
  try {
    text = fs.readFileSync(hit.path, 'utf8');
  } catch (e) {
    throw new ConfigError(`${hit.path}: cannot read (${e.code ?? e.message})`, { file: hit.path });
  }
  const raw = parseJsonFile(hit.path, text);
  const config = parseConfig(raw, { platform, file: hit.path });
  const stateDir = resolveStateDir(config, { env, platform, homedir, cwd });
  return {
    config,
    file: hit.path,
    source: hit.source,
    searched: candidates.map((c) => c.path),
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

export function hasOpenRouterKey(env = process.env) {
  return Boolean(envOrUndefined(env, 'CHEAP_EYES_OPENROUTER_KEY'));
}
