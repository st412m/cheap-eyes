#!/usr/bin/env node
// Entry point. stdout belongs to the MCP protocol in stdio mode: log to stderr only.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { checkConfig } from './check-config.js';
import { loadConfig, resolveReadRoots } from './config.js';
import { bindDescription, DEFAULT_HOST, startHttp, validateToken } from './http.js';
import { OpenRouter } from './openrouter.js';
import { startMaintenance } from './maintenance.js';
import { createServer } from './server.js';
import { modelsReport } from './stats.js';
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
