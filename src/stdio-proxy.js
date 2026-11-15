// The proxy of a stdio launcher that cannot set HTTPS_PROXY itself. Node reads
// HTTPS_PROXY (with NODE_USE_ENV_PROXY=1) once at start and refuses to start when the
// value is not a URL, such as an unfilled `${user_config.x}` placeholder an optional
// extension field may leave. So the launcher passes the proxy in CHEAP_EYES_HTTPS_PROXY.
// A real URL there is switched on in this process with http.setGlobalProxyFromEnv
// (Node 24.14+ and 25.4+). Without that function, Node 22.21 or newer starts the server
// again as a child with HTTPS_PROXY and NODE_USE_ENV_PROXY=1, relaying stdin and stdout
// through this process. An empty value or a placeholder means no proxy.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { PROXY_ENV, VIA_ENV } from './actions.js';
import { envValue } from './config.js';

export { PROXY_ENV, VIA_ENV };

// Built-in proxy support of fetch with NODE_USE_ENV_PROXY: Node 22.21+ on 22.x, any newer major.
function nodeHasEnvProxy(version) {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 21);
}

function isHttpUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// The variables every reader of the proxy looks at: Node's agents, proxyState and the
// URL fetch. Node prefers the lower-case name when both are set, so both carry the proxy.
function proxyVars(proxy, via) {
  return { HTTPS_PROXY: proxy, https_proxy: proxy, NODE_USE_ENV_PROXY: '1', [VIA_ENV]: via };
}

/**
 * What a start does about CHEAP_EYES_HTTPS_PROXY:
 *   null — nothing (no proxy, or already switched on);
 *   { mode: 'in-process', vars, setGlobal } — switch it on here (switchOnInProcess);
 *   { mode: 'restart', env } — start again as a child with this environment;
 *   { error } — a value or a Node that cannot be used; the proxy URL never appears in it.
 * `setGlobal`: http.setGlobalProxyFromEnv, absent before Node 24.14 / 25.4.
 */
export function launcherProxyPlan(env = process.env, { nodeVersion = process.versions.node, setGlobal = http.setGlobalProxyFromEnv } = {}) {
  const proxy = envValue(env, PROXY_ENV)?.trim();
  if (!proxy || env[VIA_ENV]) return null;
  if (!isHttpUrl(proxy)) return { error: `${PROXY_ENV} is not an http:// or https:// URL` };
  if (typeof setGlobal === 'function') return { mode: 'in-process', vars: proxyVars(proxy, 'in-process'), setGlobal };
  if (nodeHasEnvProxy(nodeVersion)) return { mode: 'restart', env: { ...env, ...proxyVars(proxy, 'restart') } };
  return { error: `${PROXY_ENV} is set, but Node ${nodeVersion} cannot use a proxy (it needs Node 24.14 or newer, or 22.21 or newer)` };
}

/**
 * Switch the proxy of an in-process plan on: the variables go into `target` (the
 * environment the readers look at), then http.setGlobalProxyFromEnv(target) replaces the
 * global agents and the fetch dispatcher, as NODE_USE_ENV_PROXY=1 does at start.
 * Returns null, or the reason it failed (the variables are then put back).
 */
export function switchOnInProcess(plan, target = process.env) {
  const before = Object.fromEntries(Object.keys(plan.vars).map((k) => [k, target[k]]));
  Object.assign(target, plan.vars);
  // The experimental-proxy warning the restart switches off with --disable-warning.
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const code = typeof rest[0] === 'object' ? rest[0]?.code : rest[1];
    if (code === 'UNDICI-EHPA') return;
    return emit.call(process, warning, ...rest);
  };
  try {
    plan.setGlobal(target);
    return null;
  } catch (e) {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete target[k];
      else target[k] = v;
    }
    return `http.setGlobalProxyFromEnv failed (${e.code ?? e.name})`;
  } finally {
    process.emitWarning = emit;
  }
}

function runtimeName(execPath, versions) {
  return versions.electron ? `${path.basename(execPath)} (Electron ${versions.electron}, Node ${versions.node})` : `${path.basename(execPath)} (Node ${versions.node})`;
}

/**
 * Start the stdio server again with `env` and the same arguments. This process relays
 * stdin to the child and the child's stdout back; stderr is shared. Once the child has
 * answered, this process exits with the child's code and passes SIGINT and SIGTERM on.
 * When the child cannot be started, or ends before it has written anything, `onFail(why,
 * input)` is called instead: `input` replays what the child was sent and then carries
 * the rest of stdin, so a server started on it sees the client's first messages.
 * The Node options of this process are kept; the experimental-proxy warning of Node 22
 * is switched off, every other warning still shows.
 */
export function restartStdio(env, args, opts = {}) {
  const {
    spawnFn = spawn,
    stdin = process.stdin,
    stdout = process.stdout,
    execPath = process.execPath,
    execArgv = process.execArgv,
    versions = process.versions,
    exit = (code) => process.exit(code),
    signals = process,
    onFail,
  } = opts;
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  let held = [];
  let answered = false;
  let settled = false;
  let stdinEnded = false;
  let child = null;

  const fail = (why) => {
    if (settled) return;
    settled = true;
    stdin.off('data', onData);
    stdin.off('end', onEnd);
    const input = new PassThrough();
    for (const c of held) input.write(c);
    held = null;
    if (stdinEnded) input.end();
    else stdin.pipe(input);
    onFail(`${why}; this Node is ${runtimeName(execPath, versions)}`, input);
  };
  const onData = (c) => {
    if (held) held.push(c);
    child?.stdin?.write(c);
  };
  const onEnd = () => {
    stdinEnded = true;
    child?.stdin?.end();
  };

  try {
    child = spawnFn(execPath, [...execArgv, '--disable-warning=UNDICI-EHPA', cli, ...args], { stdio: ['pipe', 'pipe', 'inherit'], env, shell: false, windowsHide: true });
  } catch (e) {
    queueMicrotask(() => fail(`the server could not be started again (${e.code ?? e.message})`));
    return null;
  }
  // A write after the child is gone fails; its exit is handled below.
  child.stdin?.on('error', () => {});
  child.stdout?.on('data', (c) => {
    if (settled) return;
    answered = true;
    held = null;
    stdout.write(c);
  });
  child.once('error', (e) => {
    if (answered) return exit(1);
    fail(`the server could not be started again (${e.code ?? e.message})`);
  });
  child.once('exit', (code, signal) => {
    if (settled) return;
    if (answered || stdinEnded) {
      settled = true;
      return exit(code ?? (signal ? 1 : 0));
    }
    fail(`the restarted server ended (${signal ? `signal ${signal}` : `exit code ${code}`}) before it answered`);
  });
  const pass = (sig) => () => {
    if (settled && !answered) return;
    try {
      child.kill(sig);
    } catch {
      // Already gone.
    }
  };
  signals.on('SIGINT', pass('SIGINT'));
  signals.on('SIGTERM', pass('SIGTERM'));
  stdin.on('data', onData);
  stdin.on('end', onEnd);
  return child;
}

/**
 * Run one command again as a child with `env` (stdio shared) and resolve with its exit
 * code: for a command that is not a server, such as `check-config --live`.
 */
export function rerun(env, args, { spawnFn = spawn } = {}) {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  return new Promise((resolve) => {
    const child = spawnFn(process.execPath, [...process.execArgv, '--disable-warning=UNDICI-EHPA', cli, ...args], { stdio: 'inherit', env, shell: false });
    child.once('error', (e) => {
      console.error(`cheap-eyes: cannot start again through the proxy (${e.code ?? e.message})`);
      resolve(1);
    });
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
