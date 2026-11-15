// The HTTP token: where it comes from, how it is generated and kept.
//
// Order: --token-file, env CHEAP_EYES_HTTP_TOKEN, <state_dir>/token, else a new one is
// generated and saved there. Never from the settings file or the command line. A
// generated token is 32 random bytes as 64 hex characters, saved with mode 0600
// through a temporary file and a rename. On Windows the mode has no effect; the file
// is protected by the access rights of the user profile that holds the state folder.
//
// The token itself is printed only by `cheap-eyes token` and once at generation
// (cli.js); no message of this module carries it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { envValue } from './config.js';
import { TokenError, validateToken } from './http.js';

export const TOKEN_FILE = 'token';
const ENV = 'CHEAP_EYES_HTTP_TOKEN';
const HINT = 'run `cheap-eyes token --new` for a generated one';

export function tokenPath(stateDir) {
  return path.join(stateDir, TOKEN_FILE);
}

export function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// null when the file does not exist.
export function readStored(stateDir) {
  try {
    return fs.readFileSync(tokenPath(stateDir), 'utf8').trim();
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function writeStored(stateDir, token) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = tokenPath(stateDir);
  const tmp = path.join(stateDir, `.token.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Already gone.
    }
    throw e;
  }
  return file;
}

/**
 * The token in force. Returns { token, source, generated, file } or throws TokenError.
 * With generate: false a missing token is an error instead.
 */
export function resolveToken({ tokenFile, env = process.env, stateDir, generate = true }) {
  let given;
  let source;
  if (tokenFile !== undefined) {
    try {
      given = fs.readFileSync(tokenFile, 'utf8').trim();
    } catch (e) {
      throw new TokenError(`cannot read --token-file (${e.code ?? e.message})`);
    }
    source = '--token-file';
  } else if (envValue(env, ENV) !== undefined) {
    given = env[ENV].trim();
    source = `env ${ENV}`;
  }

  if (source) {
    try {
      validateToken(given);
    } catch (e) {
      throw new TokenError(`token from ${source}: ${e.message}; ${HINT}`);
    }
    return { token: given, source, generated: false, file: null };
  }

  const file = tokenPath(stateDir);
  const stored = readStored(stateDir);
  if (stored !== null) {
    try {
      validateToken(stored);
    } catch (e) {
      throw new TokenError(`token in ${file}: ${e.message}; ${HINT}`);
    }
    return { token: stored, source: file, generated: false, file };
  }

  if (!generate) throw new TokenError(`no token yet: \`cheap-eyes serve --http\` generates one on its first start, or ${HINT}`);
  const token = generateToken();
  writeStored(stateDir, token);
  return { token, source: file, generated: true, file };
}

// `cheap-eyes token --new`: replaces the stored token.
export function replaceToken(stateDir) {
  const token = generateToken();
  const file = writeStored(stateDir, token);
  return { token, file };
}

// The two lines `cheap-eyes token` prints and generation shows once.
export function connectionLines(token) {
  return [`/private_${token}/mcp`, `Authorization: Bearer ${token}`];
}

// Whether the environment overrides the stored token.
export function envOverrides(env = process.env) {
  return envValue(env, ENV) !== undefined;
}
