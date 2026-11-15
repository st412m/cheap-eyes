// Preload (--import) that makes the Node of a spawned CLI look like another runtime for
// the launcher proxy, chosen by FIXTURE_PROXY_RUNTIME:
//   no-global-proxy       — no http.setGlobalProxyFromEnv (as before Node 24.14): restart;
//   restart-child-exits   — the same, and the restarted child ends at once without a word;
//   fake-global-proxy     — a stand-in http.setGlobalProxyFromEnv that only notes the call.
// The restarted child gets the same preload, since the parent passes its Node options on.
import http from 'node:http';

const mode = process.env.FIXTURE_PROXY_RUNTIME;
if (mode === 'no-global-proxy' || mode === 'restart-child-exits') http.setGlobalProxyFromEnv = undefined;
if (mode === 'restart-child-exits' && process.env.CHEAP_EYES_PROXY_VIA === 'restart') process.exit(0);
if (mode === 'fake-global-proxy') {
  http.setGlobalProxyFromEnv = (env) => {
    process.stderr.write(`fixture: setGlobalProxyFromEnv called; NODE_USE_ENV_PROXY=${env.NODE_USE_ENV_PROXY}\n`);
    return () => {};
  };
}
