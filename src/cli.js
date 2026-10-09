#!/usr/bin/env node
// Entry point. stdout belongs to the MCP protocol in stdio mode: log to stderr only.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { CappedLedger, DEFAULT_SUITE, loadSuite, renderMarkdown, runBench, suiteRoots } from './bench.js';
import { ledgerFor } from './budget.js';
import { checkConfig } from './check-config.js';
import { loadConfig, resolveReadRoots } from './config.js';
import { bindDescription, DEFAULT_HOST, startHttp, validateToken } from './http.js';
import { OpenRouter } from './openrouter.js';
import { startMaintenance } from './maintenance.js';
import { createServer } from './server.js';
import { eyesRun, resolveModelChoice } from './run.js';
import { modelsReport } from './stats.js';
import { MODES } from './tools.js';
import { readUsage } from './usage.js';
import { VERSION } from './version.js';

const USAGE = `cheap-eyes ${VERSION}

Usage:
  cheap-eyes                           MCP server on stdio (default)
  cheap-eyes serve --http [--port 3400] [--host 127.0.0.1] [--token-file F]
                                       MCP server over Streamable HTTP; token from
                                       --token-file or env CHEAP_EYES_HTTP_TOKEN;
                                       a non-local --host drops the Host/Origin checks
  cheap-eyes check-config              validate config, print resolved settings
  cheap-eyes models [--candidates [--min-context N] [--max-price-in USD]]
                                       model table from OpenRouter (USD per 1M tokens)
  cheap-eyes bench [--suite DIR] [--models a,b] [--modes extract,schema] [--repeat N]
                   [--out FILE] [--max-usd USD]
                                       run a suite with expected answers through eyes_run;
                                       Markdown table to stdout, JSON to --out
  cheap-eyes --version | --help
`;

// Shared start: config, results dir, warnings for missing roots, housekeeping.
async function loadForServer() {
  let loaded;
  try {
    loaded = loadConfig();
  } catch (e) {
    if (e.name !== 'ConfigError') throw e;
    console.error(`cheap-eyes: ${e.message}`);
    return null;
  }
  fs.mkdirSync(loaded.resultsDir, { recursive: true });
  for (const r of await resolveReadRoots(loaded.config.read_roots)) {
    if (r.kind === 'missing') console.error(`cheap-eyes: warning: read root missing: ${r.given} (${r.error})`);
  }
  startMaintenance(loaded);
  return loaded;
}

async function startStdio() {
  const loaded = await loadForServer();
  if (!loaded) return 1;
  const handle = serveStdio(() => createServer(loaded), {
    onerror: (err) => console.error(`cheap-eyes: ${err.message}`),
  });
  const stop = () => void handle.close().finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.error(`cheap-eyes ${VERSION} on stdio; config ${loaded.file}`);
  return null;
}

// The model table for a human. Network to OpenRouter only. The ZDR and model lists are
// public; the key (when set) is used only to read which models the account allows.
async function modelsCommand(rest) {
  let opts;
  try {
    opts = parseArgs({
      args: rest,
      options: { candidates: { type: 'boolean' }, 'min-context': { type: 'string' }, 'max-price-in': { type: 'string' } },
    }).values;
  } catch (e) {
    console.error(`cheap-eyes: ${e.message}\n\n${USAGE}`);
    return 2;
  }
  const filters = {};
  for (const [flag, field] of [['min-context', 'min_context'], ['max-price-in', 'max_price_in']]) {
    if (opts[flag] === undefined) continue;
    const v = Number(opts[flag]);
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`cheap-eyes: --${flag} must be a positive number`);
      return 2;
    }
    filters[field] = v;
  }
  let loaded;
  try {
    loaded = loadConfig();
  } catch (e) {
    if (e.name !== 'ConfigError') throw e;
    console.error(`cheap-eyes: ${e.message}`);
    return 1;
  }
  try {
    const records = await readUsage(loaded.stateDir.path);
    const or = new OpenRouter({ key: process.env.CHEAP_EYES_OPENROUTER_KEY || null });
    console.log(await modelsReport(loaded.config, or, { withCandidates: Boolean(opts.candidates), filters, records }));
    return 0;
  } catch (e) {
    if (e.name !== 'ApiError') throw e;
    console.error(`cheap-eyes: ${e.message}`);
    return 1;
  }
}

// The bench: real eyes_run calls (cost, daily budget, usage log) on a fixed suite.
async function benchCommand(rest) {
  let opts;
  try {
    opts = parseArgs({
      args: rest,
      options: {
        suite: { type: 'string' },
        models: { type: 'string' },
        modes: { type: 'string' },
        repeat: { type: 'string' },
        out: { type: 'string' },
        'max-usd': { type: 'string' },
      },
    }).values;
  } catch (e) {
    console.error(`cheap-eyes: ${e.message}\n\n${USAGE}`);
    return 2;
  }
  const list = (v) => (v === undefined ? undefined : v.split(',').map((x) => x.trim()).filter(Boolean));
  const repeat = opts.repeat === undefined ? 1 : Number(opts.repeat);
  const maxUsd = opts['max-usd'] === undefined ? null : Number(opts['max-usd']);
  const modes = list(opts.modes);
  if (!Number.isInteger(repeat) || repeat < 1) return usageError('--repeat must be a positive integer');
  if (maxUsd !== null && !(maxUsd > 0)) return usageError('--max-usd must be a positive number');
  if (modes && modes.some((m) => !MODES.includes(m))) return usageError(`--modes: one of ${MODES.join(', ')}`);
  let loaded;
  let suite;
  try {
    loaded = loadConfig();
    if (opts.suite === undefined && !fs.existsSync(DEFAULT_SUITE)) {
      console.error('cheap-eyes: the default suite (test/bench) ships with the repository, not the npm package; pass --suite DIR');
      return 2;
    }
    suite = loadSuite(opts.suite ?? DEFAULT_SUITE);
  } catch (e) {
    if (e.name !== 'ConfigError' && e.name !== 'InputError') throw e;
    console.error(`cheap-eyes: ${e.message}`);
    return 1;
  }
  const { config } = loaded;
  const used = [...new Set(suite.cases.filter((c) => !modes || modes.includes(c.mode)).map((c) => c.mode))];
  let models = list(opts.models);
  if (!models) models = [...new Set(used.filter((m) => m !== 'grep').map((m) => config.defaults[m] ?? (m === 'schema' ? config.defaults.extract : undefined)).filter(Boolean))];
  const needModel = used.some((m) => m !== 'grep');
  try {
    for (const m of models) resolveModelChoice(m, 'extract', config);
  } catch (e) {
    console.error(`cheap-eyes: ${e.message}`);
    return 2;
  }
  if (needModel && models.length === 0) return usageError('no model: pass --models or set defaults in the config');
  if (needModel && !process.env.CHEAP_EYES_OPENROUTER_KEY) {
    console.error('cheap-eyes: OpenRouter key is not set (env CHEAP_EYES_OPENROUTER_KEY)');
    return 1;
  }
  // The suite's folders are the read roots; nothing is exported.
  const ctx = { config: { ...config, read_roots: suiteRoots(suite), export_dir: undefined }, stateDir: loaded.stateDir, resultsDir: loaded.resultsDir };
  fs.mkdirSync(loaded.resultsDir, { recursive: true });
  const ledger = new CappedLedger(ledgerFor(loaded.stateDir.path), maxUsd);
  const started = new Date().toISOString();
  const report = await runBench({ suite, models, modes, repeat, ledger, run: (args) => eyesRun(args, ctx, { ledger }), log: (m) => console.error(`cheap-eyes bench: ${m}`) });
  const full = { suite: suite.dir, started, finished: new Date().toISOString(), models, modes: modes ?? null, repeat, max_usd: maxUsd, ...report };
  console.log(renderMarkdown(full));
  if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(full, null, 2) + '\n');
  return report.aborted ? 1 : 0;
}

function usageError(msg) {
  console.error(`cheap-eyes: ${msg}\n\n${USAGE}`);
  return 2;
}

async function serveCommand(rest) {
  let opts;
  try {
    opts = parseArgs({
      args: rest,
      options: { http: { type: 'boolean' }, port: { type: 'string' }, host: { type: 'string' }, 'token-file': { type: 'string' } },
    }).values;
  } catch (e) {
    console.error(`cheap-eyes: ${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (!opts.http) {
    console.error(`cheap-eyes: serve needs --http (stdio is the default without "serve")\n\n${USAGE}`);
    return 2;
  }
  const port = opts.port === undefined ? 3400 : Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('cheap-eyes: --port must be an integer 0-65535');
    return 2;
  }
  let token;
  try {
    token = opts['token-file'] !== undefined ? fs.readFileSync(opts['token-file'], 'utf8').trim() : process.env.CHEAP_EYES_HTTP_TOKEN;
    validateToken(token);
  } catch (e) {
    // Neither message carries the token itself.
    console.error(`cheap-eyes: ${e.name === 'TokenError' ? e.message : `cannot read --token-file (${e.code ?? e.message})`}`);
    return 1;
  }
  const loaded = await loadForServer();
  if (!loaded) return 1;
  const host = opts.host ?? DEFAULT_HOST;
  const { server, localGuards } = await startHttp(loaded, { port, host, token });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.error(`cheap-eyes ${VERSION} on http ${bindDescription(`${host}:${server.address().port}`, localGuards)}; config ${loaded.file}`);
  return null;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    return 0;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (cmd === undefined) return startStdio();
  if (cmd === 'check-config') {
    if (rest.length) {
      console.error(USAGE);
      return 2;
    }
    const { code, text } = await checkConfig();
    console.log(text);
    return code;
  }
  if (cmd === 'models') return modelsCommand(rest);
  if (cmd === 'serve') return serveCommand(rest);
  if (cmd === 'bench') return benchCommand(rest);
  console.error(`cheap-eyes: unknown command "${cmd}"\n\n${USAGE}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== null) process.exitCode = code;
  },
  (err) => {
    console.error(`cheap-eyes: ${err?.stack ?? err}`);
    process.exitCode = 1;
  },
);
