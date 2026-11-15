// `cheap-eyes init`: set-up on a terminal. Every step prints what it found before it
// asks. Nothing secret is written to a file of cheap-eyes: the key leaves init only
// inside the client command or the JSON block, and so does the proxy URL (it may carry
// credentials). Everything that talks to the person, the network, the browser or
// another process comes through `io`, so the whole flow runs under test with stubs.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { proxyState, REGION_TEXT } from './actions.js';
import { liveChecks } from './check-live.js';
import { displayCommand, findCommand, runCommand } from './claude-cli.js';
import { envValue, findSettingsFile, loadConfig } from './config.js';
import { BLOCKED_BY_ACCOUNT, loadAccount, summarizeZdr } from './models.js';
import { ApiError, OpenRouter } from './openrouter.js';
import { capFor, capText, pickCandidates, pinDate, probeTable, readPin } from './pick.js';
import { authUrl, challengeOf, exchangeCode, keySettingsUrl, listenForCode, newState, newVerifier, PKCE_TIMEOUT_MS } from './pkce.js';
import { pickAgain } from './run.js';
import { missingFolders, writeSetting } from './set.js';
import { VERSION } from './version.js';

export const CLIENTS = ['claude-code', 'claude-desktop', 'other', 'http'];
const KEY_ENV = 'CHEAP_EYES_OPENROUTER_KEY';
// Set for the copy of init that runs through the proxy, so it does not restart again.
const RESTARTED_ENV = 'CHEAP_EYES_INIT_PROXIED';
const RELEASES_URL = 'https://github.com/st412m/cheap-eyes/releases/latest';
const SERVER_NAME = 'cheap-eyes';
const NPX_ARGS = ['-y', 'cheap-eyes'];

export const INIT_FLAGS = `  --client claude-code|claude-desktop|other|http   where cheap-eyes will be used
  --roots <dir>...                                  folders the server may read
  --proxy URL                                       a proxy for OpenRouter (where it refuses the network)
  --no-browser                                      sign in without opening a browser (paste the code)
  --yes                                             take the defaults; never runs claude mcp add`;

const NO_TTY = `cheap-eyes init asks questions and needs a terminal. Without one, pass --yes and the answers as flags:
${INIT_FLAGS}
The key comes from env ${KEY_ENV}, or from the browser sign-in.`;

export function parseInitArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      proxy: { type: 'string' },
      'no-browser': { type: 'boolean' },
      client: { type: 'string' },
      roots: { type: 'string', multiple: true },
      yes: { type: 'boolean' },
    },
  });
  if (positionals.length && !values.roots) throw new Error(`unexpected argument: ${positionals[0]}`);
  if (values.client !== undefined && !CLIENTS.includes(values.client)) throw new Error(`--client: one of ${CLIENTS.join(', ')}`);
  return {
    proxy: values.proxy,
    noBrowser: Boolean(values['no-browser']),
    client: values.client,
    roots: values.roots ? [...values.roots, ...positionals] : null,
    yes: Boolean(values.yes),
  };
}

// The arguments for the copy of init that runs through the proxy: everything but --proxy.
export function withoutProxyArg(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--proxy') {
      i++;
      continue;
    }
    if (argv[i].startsWith('--proxy=')) continue;
    out.push(argv[i]);
  }
  return out;
}

function nodeHasEnvProxy(version) {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 21);
}

function proxyOk(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function yes(answer, dflt) {
  const a = String(answer ?? '').trim().toLowerCase();
  if (a === '') return dflt;
  return a === 'y' || a === 'yes';
}

// ---- the person's terminal ----

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.question(question, (a) => {
      answered = true;
      rl.close();
      resolve(a.trim());
    });
    rl.on('close', () => {
      if (!answered) resolve('');
    });
  });
}

// Typed or pasted input that is not shown on the screen.
function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let buf = '';
    const cleanup = () => {
      stdin.off('data', onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(buf.replace(/\x1b\[20[01]~/g, '').trim());
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ' || ch === '\x1b') buf += ch;
      }
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

// Best effort: a failure to open the browser is not an error, the link is printed anyway.
function openBrowser(url, platform = process.platform) {
  const [cmd, args] = platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, shell: false });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The person opens the printed link.
  }
}

// Node arguments of the copy of init that runs through the proxy. With
// NODE_USE_ENV_PROXY=1, Node 22 prints "[UNDICI-EHPA] Warning: EnvHttpProxyAgent is
// experimental" on the first request, which reads like an error during set-up; only
// that warning code is switched off, every other warning still shows.
export const RESTART_NODE_ARGS = ['--disable-warning=UNDICI-EHPA'];

export function restartArgv(args) {
  return [...RESTART_NODE_ARGS, fileURLToPath(new URL('./cli.js', import.meta.url)), ...args];
}

function restart(env, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, restartArgv(args), { stdio: 'inherit', env, shell: false });
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

export function realIo() {
  return {
    out: (s = '') => process.stdout.write(s + '\n'),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask,
    askHidden,
    env: process.env,
    cwd: process.cwd(),
    homedir: os.homedir(),
    fetch: globalThis.fetch,
    now: () => Date.now(),
    platform: process.platform,
    nodeVersion: process.versions.node,
    openBrowser: (url) => openBrowser(url),
    listen: listenForCode,
    pkceTimeoutMs: PKCE_TIMEOUT_MS,
    findClaude: () => findCommand('claude'),
    runCommand: (found, args) => runCommand(found, args),
    restart,
  };
}

// ---- the client ----

function clientEnv(key, proxy) {
  return { [KEY_ENV]: key, ...(proxy ? { HTTPS_PROXY: proxy, NODE_USE_ENV_PROXY: '1' } : {}) };
}

// `claude mcp add`: each --env is followed by another option before the server name,
// since the CLI otherwise reads the name as one more KEY=value pair.
export function claudeAddArgs(key, proxy) {
  const envArgs = Object.entries(clientEnv(key, proxy)).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  return ['mcp', 'add', '--scope', 'user', ...envArgs, '--transport', 'stdio', SERVER_NAME, '--', 'npx', ...NPX_ARGS];
}

// The Claude Code command for a server in HTTP mode; user scope, as for stdio above.
export const HTTP_ADD_COMMAND = (url) => `claude mcp add --scope user --transport http ${SERVER_NAME} ${url}`;
export const SCOPE_NOTE = 'Without --scope user, Claude Code adds the server for the current folder only.';

export function jsonBlock(key, proxy) {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: 'npx', args: NPX_ARGS, env: clientEnv(key, proxy) } } }, null, 2);
}

function serveCommandText(key, proxy, platform) {
  const vars = clientEnv(key, proxy);
  if (platform === 'win32') return `${Object.entries(vars).map(([k, v]) => `$env:${k} = '${v.replace(/'/g, "''")}'`).join('; ')}; cheap-eyes serve --http`;
  return `${Object.entries(vars).map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`).join(' ')} cheap-eyes serve --http`;
}

// ---- the flow ----

/** Returns the exit code. */
export async function runInit(argv, io = realIo()) {
  const out = io.out;
  const step = (title) => out(`\n${title}`);
  let opts;
  try {
    opts = parseInitArgs(argv);
  } catch (e) {
    out(`cheap-eyes init: ${e.message}\nFlags:\n${INIT_FLAGS}`);
    return 2;
  }
  if (!io.isTTY && !opts.yes) {
    out(NO_TTY);
    return 2;
  }
  const env = io.env;
  const restarted = env[RESTARTED_ENV] === '1';
  out(`cheap-eyes ${VERSION} init${restarted ? ' (continued through the proxy)' : ''}`);

  // 1. Environment
  step('1. Environment');
  out(`  Node ${io.nodeVersion}; proxy: ${proxyState(env)}`);
  const restartThrough = async (url) => {
    if (!nodeHasEnvProxy(io.nodeVersion)) {
      out(`  Node ${io.nodeVersion} cannot use a proxy for its own requests (NODE_USE_ENV_PROXY needs Node 22.21 or newer, or 24). Update Node and run init again.`);
      return 1;
    }
    out('  Continuing through the proxy (the questions answered so far are kept).');
    return io.restart({ ...env, HTTPS_PROXY: url, NODE_USE_ENV_PROXY: '1', [RESTARTED_ENV]: '1' }, ['init', ...withoutProxyArg(argv)]);
  };
  if (opts.proxy !== undefined) {
    if (!proxyOk(opts.proxy)) {
      out('  --proxy: an http:// or https:// URL is needed');
      return 2;
    }
    if (!(env.HTTPS_PROXY === opts.proxy && proxyState(env) === 'HTTPS_PROXY set')) return restartThrough(opts.proxy);
  }
  const proxy = proxyState(env) === 'HTTPS_PROXY set' ? env.HTTPS_PROXY : null;

  // 2. Network
  step('2. Network');
  const pub = new OpenRouter({ fetch: io.fetch, env, now: io.now });
  let zdrList;
  try {
    zdrList = await pub.zdrEndpoints();
    out(`  OpenRouter answers${proxy ? ' through the proxy' : ''}: ${zdrList.length} zero-data-retention endpoints.`);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.status !== 403) {
      out(`  OpenRouter does not answer: ${e.message}\n  Check the connection; where OpenRouter refuses the network, run init with --proxy URL.`);
      return 1;
    }
    out(`  ${REGION_TEXT}.`);
    if (restarted || proxy) {
      out('  The proxy in use is refused too: run init again with a proxy in another region (--proxy URL).');
      return 1;
    }
    if (opts.yes) {
      out('  Run init again with --proxy URL.');
      return 1;
    }
    const p = await io.ask('  Proxy URL (http://host:port, with the login in it when the proxy needs one; empty to stop): ');
    if (!p) return 1;
    if (!proxyOk(p)) {
      out('  That is not an http:// or https:// URL.');
      return 1;
    }
    return restartThrough(p);
  }

  // 3. Key
  step('3. OpenRouter key');
  let key = envValue(env, KEY_ENV) ?? null;
  if (key) out(`  ${KEY_ENV} is set: using it.`);
  else {
    let way = opts.yes ? '1' : await io.ask('  No key in the environment. [1] sign in with the browser (default), [2] paste a key: ');
    if (opts.noBrowser && !io.isTTY) {
      out('  --no-browser needs the code pasted on a terminal; set the key in env ' + KEY_ENV + ' instead.');
      return 2;
    }
    way = way.trim() === '2' ? 'paste' : 'browser';
    if (way === 'browser') key = await signIn(io, opts, pub, restarted || Boolean(proxy));
    else {
      for (let i = 0; i < 3 && !key; i++) {
        const k = await io.askHidden('  OpenRouter key (input hidden): ');
        if (k) key = k;
      }
    }
    if (!key) {
      out('  No key: stopping. Run init again, or set the key in env ' + KEY_ENV + '.');
      return 1;
    }
  }
  const or = new OpenRouter({ key, fetch: io.fetch, env, now: io.now });
  let info;
  try {
    info = await or.keyInfo();
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    out(`  The key was not accepted: ${e.message}`);
    return 1;
  }
  out(`  Key accepted; limit ${info.limit === null ? 'none' : `$${info.limit}`}, remaining ${info.limit_remaining === null ? '-' : `$${info.limit_remaining}`}.`);
  if (info.limit === null) {
    out('  WARNING: this key has no spending limit. Set a limit on this key: it is the real spending ceiling.');
    out(`  ${keySettingsUrl(key)}`);
  }

  // 4. Folders (the default depends on the client, so the client is chosen here)
  step('4. Client and folders');
  const claude = io.findClaude();
  let client = opts.client;
  if (!client) {
    const dflt = claude ? 'claude-code' : 'other';
    if (opts.yes) client = dflt;
    else {
      const a = await io.ask(`  Where will cheap-eyes be used? claude-code, claude-desktop, other, http [${dflt}]: `);
      client = a ? a.trim() : dflt;
      if (!CLIENTS.includes(client)) {
        out(`  Not one of ${CLIENTS.join(', ')}: using ${dflt}.`);
        client = dflt;
      }
    }
  }
  out(`  Client: ${client}`);
  let roots = opts.roots;
  if (!roots && !opts.yes) {
    const q =
      client === 'claude-code'
        ? `  Folders the server may read (absolute, separated by "${path.delimiter}") [Enter: the project folder of each Claude Code session]: `
        : `  Folders the server may read (absolute, separated by "${path.delimiter}"; Enter for none): `;
    const a = await io.ask(q);
    roots = a ? a.split(path.delimiter).map((s) => s.trim()).filter(Boolean) : null;
  }
  if (roots?.length) {
    const { target } = findSettingsFile({ env, cwd: io.cwd, homedir: io.homedir });
    try {
      writeSetting(target.path, 'read_roots', roots, { cwd: io.cwd, env });
      out(`  read_roots written to ${target.path}: ${roots.map((r) => path.resolve(io.cwd, r)).join(', ')}`);
      for (const m of missingFolders('read_roots', roots.map((r) => path.resolve(io.cwd, r)))) out(`  warning: folder does not exist: ${m} (written anyway)`);
    } catch (e) {
      if (e.name !== 'ConfigError') throw e;
      out(`  read_roots not written: ${e.message}`);
    }
  } else if (client === 'claude-code') out('  Folders: the project folder of each Claude Code session (nothing stored).');
  else out('  Folders: none. File paths are refused until you add one: cheap-eyes set read_roots <dir>...');

  // 5. Models
  step('5. Models');
  let loaded;
  try {
    loaded = loadConfig({ env, cwd: io.cwd, homedir: io.homedir });
  } catch (e) {
    if (e.name !== 'ConfigError') throw e;
    out(`  The settings cannot be used: ${e.message}`);
    return 1;
  }
  const named = Object.keys(loaded.config.models);
  if (named.length) out(`  The settings name models (${named.join(', ')}): nothing to pick.`);
  else await pickStep(io, opts, loaded, or, pub, key, zdrList);

  // 6. Client
  step('6. Client set-up');
  await clientStep(io, opts, client, claude, key, proxy);

  // 7. Check
  step('7. Check');
  const live = await liveChecks({ loaded, env: { ...env, [KEY_ENV]: key }, fetch: io.fetch });
  for (const l of live.lines) out(`  ${l}`);
  out('\nTry it: ask your assistant to "use eyes_run in mode extract to quote every line with ERROR in <a log file in your project>".');
  return live.failed ? 1 : 0;
}

async function signIn(io, opts, pub, viaProxy) {
  const out = io.out;
  if (viaProxy) out('  The sign-in runs in your browser, which does not use this proxy: if OpenRouter refuses your network there too, use your own VPN for that step.');
  const verifier = newVerifier();
  const challenge = challengeOf(verifier);
  let code;
  if (opts.noBrowser) {
    out('  Open this link, sign in and approve; the page then shows a code:');
    out(`  ${authUrl({ challenge })}`);
    code = await io.ask('  Code from the page: ');
    if (!code) return null;
  } else {
    const state = newState();
    let l;
    try {
      l = await io.listen({ state, timeoutMs: io.pkceTimeoutMs });
    } catch (e) {
      out(`  Cannot listen for the browser's answer (${e.code ?? e.message}); run init with --no-browser.`);
      return null;
    }
    const url = authUrl({ challenge, callbackUrl: l.url, state });
    out('  Sign in with your browser. The link opens by itself; if it does not, open it yourself:');
    out(`  ${url}`);
    out(`  Waiting up to ${Math.round(io.pkceTimeoutMs / 60e3)} minutes for the browser...`);
    try {
      io.openBrowser(url);
    } catch {
      // The printed link is enough.
    }
    try {
      code = await l.done;
    } catch (e) {
      out(`  Sign-in not finished: ${e.message}. Run init again, or use --no-browser.`);
      return null;
    }
  }
  try {
    const key = await exchangeCode(pub, { code, verifier });
    out('  Signed in: OpenRouter created a key labelled "cheap-eyes".');
    return key;
  } catch (e) {
    out(`  OpenRouter did not give a key for that code: ${e.message}`);
    return null;
  }
}

async function pickStep(io, opts, loaded, or, pub, key, zdrList) {
  const out = io.out;
  const zdr = summarizeZdr(zdrList);
  const cap = capFor(loaded.config);
  const account = await loadAccount(or);
  out(account.ids ? `  account: ${account.ids.size} models allowed` : `  account: availability unknown (${account.error})`);
  if (account.ids) {
    let publicText = null;
    try {
      publicText = await pub.textModels();
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    }
    if (publicText) {
      const blocked = pickCandidates(zdr, publicText, cap).filter((c) => !account.ids.has(c.id));
      if (blocked.length) out(`  not available to this account: ${blocked.slice(0, 5).map((c) => c.id).join(', ')}${blocked.length > 5 ? `, +${blocked.length - 5} more` : ''} (${BLOCKED_BY_ACCOUNT})`);
    }
  }
  const pinned = readPin(loaded.stateDir.path).pin;
  if (pinned) {
    out(`  Models pinned ${pinDate(pinned)}: ${pinned.ids.join(', ')}`);
    if (opts.yes || !yes(await io.ask('  Pick again now? [y/N]: '), false)) return;
  }
  out(`  Picking: each candidate within ${capText(cap)} runs a short paid test job until two pass (at most five).`);
  try {
    const r = await pickAgain(loaded, {
      key,
      fetch: io.fetch,
      now: io.now,
      onProbe: (p) => out(`    ${p.id}: ${p.ok ? 'pass' : p.reason}; $${p.cost.toFixed(6)}; ${(p.ms / 1000).toFixed(1)} s`),
    });
    out('  tried:');
    for (const l of probeTable(r.pin.probe, r.cands)) out(`  ${l}`);
    out(`  pinned: ${r.pin.ids.join(', ')}; cap ${capText(r.pin.cap ?? cap)}`);
  } catch (e) {
    if (e.name !== 'InputError' && e.name !== 'ApiError') throw e;
    if (e.probes?.length) for (const l of probeTable(e.probes)) out(`  ${l}`);
    out(`  No model pinned: ${e.message}`);
  }
}

async function clientStep(io, opts, client, claude, key, proxy) {
  const out = io.out;
  if (client === 'claude-code') {
    const args = claudeAddArgs(key, proxy);
    const shown = displayCommand('claude', args, io.platform);
    let why = null;
    if (!claude) why = '`claude` is not on PATH. When Claude Code is installed, run:';
    else if (claude.kind === 'shim-unknown') why = `${claude.file} is a command shim that cannot be started without a shell, and the key must not pass through shell quoting. Run this yourself:`;
    else if (opts.yes) why = '--yes never runs claude mcp add. Run this yourself:';
    if (!why && !yes(await io.ask('  Run `claude mcp add` now (user scope, server name cheap-eyes)? [Y/n]: '), true)) why = 'Run this yourself:';
    if (why) {
      out(`  ${why}`);
      out(`  ${shown}`);
      out('  Claude Code keeps the key in its own settings file (~/.claude.json).');
      return;
    }
    const r = await io.runCommand(claude, args);
    if (r.code === 0) out('  Added to Claude Code (user scope). Claude Code keeps the key in its own settings file (~/.claude.json); check with `claude mcp list`.');
    else {
      out(`  claude mcp add did not succeed (exit ${r.code}${r.error ? `, ${r.error}` : ''}). If a server named cheap-eyes exists already, remove it with \`claude mcp remove cheap-eyes --scope user\`; or run this yourself:`);
      out(`  ${shown}`);
    }
    return;
  }
  if (client === 'claude-desktop') {
    out(`  Claude Desktop: install the extension cheap-eyes-<version>.mcpb from ${RELEASES_URL}; its settings ask for the key, the folders and a proxy.`);
    out('  Or add this to claude_desktop_config.json (Settings > Developer > Edit Config):');
    for (const l of jsonBlock(key, proxy).split('\n')) out(`  ${l}`);
    return;
  }
  if (client === 'other') {
    out('  Add this to the MCP settings of your client:');
    for (const l of jsonBlock(key, proxy).split('\n')) out(`  ${l}`);
    return;
  }
  out('  HTTP: start the server with the key in its environment:');
  out(`  ${serveCommandText(key, proxy, io.platform)}`);
  out('  The first start generates the HTTP token; `cheap-eyes token` prints the connector path and the Bearer line.');
  out(`  Claude Code: ${HTTP_ADD_COMMAND('http://127.0.0.1:3400/private_<token>/mcp')}`);
  out(`  ${SCOPE_NOTE}`);
  out('  claude.ai needs the server behind your own TLS reverse proxy.');
}

