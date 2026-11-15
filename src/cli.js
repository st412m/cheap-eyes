#!/usr/bin/env node
// Entry point. stdout belongs to the MCP protocol in stdio mode: log to stderr only.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { configErrorAction, noKeyText, proxyFailText, runtimeLine, settingsUi } from './actions.js';
import { launcherProxyPlan, PROXY_ENV, rerun, restartStdio, switchOnInProcess } from './stdio-proxy.js';
import { CappedLedger, DEFAULT_SUITE, loadSuite, renderMarkdown, runBench, suiteRoots } from './bench.js';
import { ledgerFor } from './budget.js';
import { checkConfig, rootsSummary } from './check-config.js';
import { findSettingsFile, loadConfig, openRouterKey, PLACEHOLDER_RE, resolveReadRoots } from './config.js';
import { bindDescription, DEFAULT_HOST, startHttp } from './http.js';
import { OpenRouter } from './openrouter.js';
import { startMaintenance } from './maintenance.js';
import { createServer, setupHandlers } from './server.js';
import { installHook, removeHook } from './hook-install.js';
import { runInit } from './init.js';
import { accountLine } from './models.js';
import { AUTO, capFor, capText, pinDate, pinPath, probeTable, usesAuto } from './pick.js';
import { eyesRun, pickAgain, resolveModelChoice } from './run.js';
import { missingFolders, SETTABLE, valueAt, writeSetting } from './set.js';
import { modelsReport } from './stats.js';
import { connectionLines, envOverrides, readStored, replaceToken, resolveToken, tokenPath } from './token.js';
import { MODES } from './tools.js';
import { readUsage } from './usage.js';
import { VERSION } from './version.js';

const USAGE = `cheap-eyes ${VERSION}

Usage:
  cheap-eyes [<dir>...]                MCP server on stdio (default); the folders, when
                                       given, are the read roots (a folder named like a
                                       command is passed as ./serve)
  cheap-eyes serve --http [--port 3400] [--host 127.0.0.1] [--token-file F]
                                       MCP server over Streamable HTTP; token from
                                       --token-file, env CHEAP_EYES_HTTP_TOKEN or the
                                       state folder (generated on the first start);
                                       a non-local --host drops the Host/Origin checks
  cheap-eyes token [--new]             print the connector path and the Bearer line;
                                       --new replaces the saved token
  cheap-eyes set <key> [<value>...]    write a setting into the settings file;
                                       no value: back to the default
  cheap-eyes init [--client C] [--roots <dir>...] [--proxy URL] [--no-browser] [--yes]
                                       set-up on a terminal: network, key (browser
                                       sign-in or paste), folders, models, client
  cheap-eyes hook install [--project]  add the Claude Code hook that stops whole reads of
                                       large files (~/.claude/settings.json, or
                                       .claude/settings.json here); hook remove takes it out
  cheap-eyes check-config [--live]     validate the settings, print what is in force;
                                       --live adds the checks against OpenRouter
  cheap-eyes models [--candidates [--min-context N] [--max-price-in USD]]
                                       model table from OpenRouter (USD per 1M tokens)
  cheap-eyes models --pick             with no models in the settings: probe candidates
                                       now and pin the pick (paid calls)
  cheap-eyes bench [--suite DIR] [--models a,b] [--modes extract,schema] [--repeat N]
                   [--out FILE] [--max-usd USD]
                                       run a suite with expected answers through eyes_run;
                                       Markdown table to stdout, JSON to --out
  cheap-eyes --version | --help
`;

// Settings that cannot be used: the error and what to fix.
function configErrorText(e) {
  return `${e.message}\nto fix: ${configErrorAction(e, settingsUi())}`;
}

// Shared start: results dir, warnings for missing roots, housekeeping.
async function prepareServer(loaded) {
  fs.mkdirSync(loaded.resultsDir, { recursive: true });
  for (const r of await resolveReadRoots(loaded.config.read_roots)) {
    if (r.kind === 'missing') console.error(`cheap-eyes: warning: read root missing: ${r.given} (${r.error})`);
  }
  startMaintenance(loaded);
}

// The start line: settings, read roots, the runtime and the proxy state (never the URL).
function settingsLine(loaded) {
  return `settings file ${loaded.file ?? 'none'}; read roots: ${rootsSummary(loaded)}; ${runtimeLine()}`;
}

// stdio always starts: settings that cannot be used put it in the setup state, where
// the client still gets the tool list and every call answers with the error. The proxy
// of the launcher goes on first: in this process, or by starting again as a child.
async function startStdio(roots) {
  const plan = launcherProxyPlan();
  if (plan?.mode === 'restart') {
    console.error(`cheap-eyes: Node ${process.versions.node} has no http.setGlobalProxyFromEnv: starting again through the proxy in ${PROXY_ENV}`);
    restartStdio(plan.env, roots, {
      onFail: (why, input) => {
        console.error(`cheap-eyes: the restart through the proxy failed: ${why}`);
        void serveStdioHere(roots, proxyFailText(why, process.env, { restarted: true }), input);
      },
    });
    return null;
  }
  let setup = null;
  if (plan?.error) setup = `settings cannot be used: ${configErrorText(Object.assign(new Error(plan.error), { name: 'ConfigError', kind: 'env', envVar: PROXY_ENV }))}`;
  if (plan?.mode === 'in-process') {
    const why = switchOnInProcess(plan);
    if (why) setup = proxyFailText(why);
  }
  return serveStdioHere(roots, setup);
}

// The stdio server of this process. `setup`: a message for the setup state, or null to
// load the settings. `input`: the stream to read instead of stdin.
async function serveStdioHere(roots, setup, input = null) {
  let loaded = null;
  if (!setup) {
    try {
      loaded = loadConfig({ args: roots, defaultRoot: true });
    } catch (e) {
      if (e.name !== 'ConfigError') throw e;
      setup = `settings cannot be used: ${configErrorText(e)}`;
    }
  }
  if (loaded) await prepareServer(loaded);
  const handle = serveStdio(() => (loaded ? createServer(loaded) : createServer(null, setupHandlers(`${setup}\n${runtimeLine()}`))), {
    onerror: (err) => console.error(`cheap-eyes: ${err.message}`),
    ...(input ? { transport: new StdioServerTransport(input, process.stdout) } : {}),
  });
  const stop = () => void handle.close().finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (loaded) console.error(`cheap-eyes ${VERSION} on stdio; ${settingsLine(loaded)}`);
  else console.error(`cheap-eyes ${VERSION} on stdio in setup state (every tool call answers with this error):\ncheap-eyes: ${setup}\ncheap-eyes: ${runtimeLine()}`);
  return null;
}

// `hook install [--project]` / `hook remove [--project]`.
function hookCommandCli(rest) {
  const [action, ...flags] = rest;
  const project = flags.includes('--project');
  if (!['install', 'remove'].includes(action) || flags.some((f) => f !== '--project')) return usageError('hook install [--project] | hook remove [--project]');
  try {
    if (action === 'install') {
      const r = installHook({ project });
      if (!r.changed) console.log(`The hook is already in ${r.file}:\n  ${r.command}`);
      else console.log(`${r.replaced ? 'Replaced the cheap-eyes hook' : 'Added the hook'} in ${r.file}:\n  PreToolUse, matcher Read: ${r.command}\nClaude Code reads it at the next session start.`);
    } else {
      const r = removeHook({ project });
      console.log(r.removed ? `Removed the hook from ${r.file}.` : `No cheap-eyes hook in ${r.file}.`);
    }
    return 0;
  } catch (e) {
    if (e.name !== 'HookError') throw e;
    console.error(`cheap-eyes: ${e.message}`);
    return 1;
  }
}

// `set`: the file in force when there is one, else the user settings file.
function setCommand(rest) {
  const [key, ...values] = rest;
  if (!key || key.startsWith('-')) return usageError(`set needs a setting name: ${SETTABLE.join(', ')}`);
  const { hit, target } = findSettingsFile();
  let r;
  try {
    r = writeSetting(target.path, key, values);
  } catch (e) {
    if (e.name !== 'ConfigError') throw e;
    console.error(`cheap-eyes: ${e.message}\nnothing was written`);
    return 1;
  }
  const out = [r.removed ? `${key} removed from ${r.file}` : `${key} = ${JSON.stringify(r.value)} written to ${r.file}`];
  if (!target.source.startsWith('user config')) out.push(`${r.file} is the settings file in force here (${target.source})${hit ? '' : '; it was created'}`);
  for (const p of missingFolders(key, r.value)) out.push(`warning: folder does not exist: ${p} (written anyway)`);
  let now = null;
  try {
    now = loadConfig();
  } catch (e) {
    if (e.name !== 'ConfigError') throw e;
    out.push(`warning: the settings do not load now: ${e.message}`);
  }
  if (now) {
    const top = key.split('.')[0];
    if (r.removed) {
      out.push(top === 'read_roots' ? 'the default applies: on stdio the project folder of the client, on serve --http none' : `the default applies: ${JSON.stringify(valueAt(now.config, key)) ?? 'none'}`);
    }
    const src = now.sources[top];
    if (typeof src === 'string' && src.startsWith('env ')) {
      out.push(`warning: ${src} is set and overrides the settings file: the server keeps using ${JSON.stringify(valueAt(now.config, key))} until it is removed`);
    }
  }
  if (key === 'read_roots') out.push('note: folders given to the server as arguments (a desktop extension, a client config) override this list');
  out.push('A running server uses the change after a restart (over stdio: restart the client, such as Claude Code or Claude Desktop).');
  console.log(out.join('\n'));
  return 0;
}

// The model table for a human. Network to OpenRouter only. The ZDR and model lists are
// public; the key (when set) is used only to read which models the account allows.
async function modelsCommand(rest) {
  let opts;
  try {
    opts = parseArgs({
      args: rest,
      options: { candidates: { type: 'boolean' }, 'min-context': { type: 'string' }, 'max-price-in': { type: 'string' }, pick: { type: 'boolean' } },
    }).values;
  } catch (e) {
    console.error(`cheap-eyes: ${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.pick) return pickCommand();
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
    const or = new OpenRouter({ key: openRouterKey() });
    console.log(await modelsReport(loaded.config, or, { withCandidates: Boolean(opts.candidates), filters, records, stateDir: loaded.stateDir.path }));
    return 0;
  } catch (e) {
    if (e.name !== 'ApiError') throw e;
    console.error(`cheap-eyes: ${e.message}`);
    return 1;
  }
}

// `models --pick`: probe candidates now and pin the pick; the table of tried ids.
// Each probe is a paid call within the daily budget.
async function pickCommand() {
  let loaded;
  try {
    loaded = loadConfig();
  } catch (e) {
    if (e.name !== 'ConfigError') throw e;
    console.error(`cheap-eyes: ${configErrorText(e)}`);
    return 1;
  }
  fs.mkdirSync(loaded.resultsDir, { recursive: true });
  const cap = capFor(loaded.config);
  console.error(`cheap-eyes: picking models (cap ${capText(cap)}); each probe is a paid call`);
  let r;
  try {
    r = await pickAgain(loaded);
  } catch (e) {
    if (e.name === 'ApiError') {
      console.error(`cheap-eyes: ${e.message}`);
      return 1;
    }
    if (e.name !== 'InputError') throw e;
    if (e.probes?.length) console.log(['tried:', ...probeTable(e.probes)].join('\n'));
    console.error(`cheap-eyes: ${e.message}`);
    return 1;
  }
  const out = [...r.notes, accountLine(r.account)];
  if (!r.picked) out.push('another cheap-eyes process picked the models a moment ago; its pick:');
  out.push('tried:', ...probeTable(r.pin.probe ?? [], r.cands));
  out.push(`pinned: ${r.pin.ids.join(', ')} (${pinDate(r.pin)}, cap ${capText(r.pin.cap ?? cap)}) in ${pinPath(loaded.stateDir.path)}`);
  out.push('A running server uses the new pin on its next model job.');
  console.log(out.join('\n'));
  return 0;
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
  if (needModel && models.length === 0 && usesAuto(undefined, 'extract', config)) models = [AUTO];
  try {
    for (const m of models) if (!usesAuto(m, 'extract', config)) resolveModelChoice(m, 'extract', config);
  } catch (e) {
    console.error(`cheap-eyes: ${e.message}`);
    return 2;
  }
  if (needModel && models.length === 0) return usageError('no model: pass --models or set defaults in the config');
  if (needModel && !openRouterKey()) {
    console.error(`cheap-eyes: ${noKeyText()}`);
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
  // HTTP fails fast on settings that cannot be used (a supervisor or container log
  // shows it) and has no default read root.
  let loaded;
  try {
    loaded = loadConfig();
  } catch (e) {
    if (e.name !== 'ConfigError') throw e;
    console.error(`cheap-eyes: ${configErrorText(e)}`);
    return 1;
  }
  let tok;
  try {
    tok = resolveToken({ tokenFile: opts['token-file'], env: process.env, stateDir: loaded.stateDir.path });
  } catch (e) {
    // No TokenError message carries the token itself.
    if (e.name !== 'TokenError') throw e;
    console.error(`cheap-eyes: ${e.message}`);
    return 1;
  }
  await prepareServer(loaded);
  const host = opts.host ?? DEFAULT_HOST;
  let server;
  let localGuards;
  try {
    ({ server, localGuards } = await startHttp(loaded, { port, host, token: tok.token }));
  } catch (e) {
    console.error(`cheap-eyes: cannot listen on ${host}:${port} (${e.code ?? e.message})`);
    return 1;
  }
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // One write, so the lines stay together in the log. A generated token is shown
  // here once; afterwards only `cheap-eyes token` prints it.
  const lines = [`cheap-eyes ${VERSION} on http ${bindDescription(`${host}:${server.address().port}`, localGuards)}; ${settingsLine(loaded)}`];
  if (tok.generated) {
    const [p, b] = connectionLines(tok.token);
    lines.push(
      `cheap-eyes: new HTTP token generated and saved to ${tok.file}`,
      `cheap-eyes: claude.ai connector path: ${p}`,
      `cheap-eyes: Bearer header: ${b}`,
      'cheap-eyes: shown once; `cheap-eyes token` shows it again',
    );
  }
  process.stderr.write(lines.join('\n') + '\n');
  return null;
}

// `token`: the two connection lines of the token in force; `--new` replaces the
// stored one. The token goes to stdout, the notes to stderr.
function tokenCommand(rest) {
  let opts;
  try {
    opts = parseArgs({ args: rest, options: { new: { type: 'boolean' } } }).values;
  } catch (e) {
    return usageError(e.message);
  }
  let loaded;
  try {
    loaded = loadConfig();
  } catch (e) {
    if (e.name !== 'ConfigError') throw e;
    console.error(`cheap-eyes: ${configErrorText(e)}`);
    return 1;
  }
  const stateDir = loaded.stateDir.path;
  if (opts.new) {
    const { token, file } = replaceToken(stateDir);
    process.stdout.write(connectionLines(token).join('\n') + '\n');
    console.error(
      `cheap-eyes: new token saved to ${file}; a running server keeps accepting the old token until it is restarted; every connected client must be updated (connector path or Bearer header)`,
    );
    if (envOverrides()) console.error('cheap-eyes: warning: env CHEAP_EYES_HTTP_TOKEN is set and takes precedence over the saved token; unset it for the new one to take effect');
    return 0;
  }
  let tok;
  try {
    tok = resolveToken({ env: process.env, stateDir, generate: false });
  } catch (e) {
    if (e.name !== 'TokenError') throw e;
    console.error(`cheap-eyes: ${e.message}`);
    return 1;
  }
  process.stdout.write(connectionLines(tok.token).join('\n') + '\n');
  if (envOverrides() && readStoredSafe(stateDir) !== null) {
    console.error(`cheap-eyes: warning: env CHEAP_EYES_HTTP_TOKEN is set and overrides the token saved in ${tokenPath(stateDir)}; this is the env token`);
  }
  return 0;
}

function readStoredSafe(stateDir) {
  try {
    return readStored(stateDir);
  } catch {
    return null;
  }
}

// A folder argument of the stdio server: it has a path separator or is "." / "..";
// a bare word is a command (or a mistake), never a folder.
function isFolderArg(a) {
  return !a.startsWith('-') && (/[\\/]/.test(a) || a === '.' || a === '..');
}

async function main(rawArgv) {
  // A launcher may leave an empty or unresolved placeholder for a form field that was
  // not filled in (a desktop extension's folders): not an argument.
  const argv = rawArgv.filter((a) => a !== '' && !PLACEHOLDER_RE.test(a));
  const [cmd, ...rest] = argv;
  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    return 0;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (cmd === undefined || argv.every(isFolderArg)) return startStdio(argv);
  if (cmd === 'set') return setCommand(rest);
  if (cmd === 'token') return tokenCommand(rest);
  if (cmd === 'check-config') {
    const live = rest.length === 1 && rest[0] === '--live';
    if (rest.length && !live) {
      console.error(USAGE);
      return 2;
    }
    // The network checks go through the launcher's proxy as the stdio server does: on a
    // Node without http.setGlobalProxyFromEnv, in a child started with it.
    const plan = launcherProxyPlan();
    if (live && plan?.mode === 'restart') return rerun(plan.env, ['check-config', '--live']);
    const { code, text } = await checkConfig({ live, proxyPlan: plan });
    console.log(text);
    return code;
  }
  if (cmd === 'init') return runInit(rest);
  if (cmd === 'hook') return hookCommandCli(rest);
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
