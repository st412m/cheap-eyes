// Platform-aware path helpers. `platform` is injectable so Windows rules can be
// tested on Linux and vice versa.
import path from 'node:path';

export function pathApi(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

// Absolute in the strict sense: on Windows a drive letter or a UNC share is
// required (`\foo` is drive-relative and refused).
export function isAbsoluteStrict(p, platform = process.platform) {
  if (typeof p !== 'string' || p === '') return false;
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(p);
  return p.startsWith('/');
}

// Normalised root + segments. Windows compares case-insensitively.
export function pathSegments(p, platform = process.platform) {
  const api = pathApi(platform);
  const full = api.resolve(p);
  let root = api.parse(full).root;
  const rest = full.slice(root.length).split(api.sep).filter(Boolean);
  if (platform === 'win32') {
    root = root.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    return [root, ...rest.map((s) => s.toLowerCase())];
  }
  return [root, ...rest];
}

// True when `child` equals `parent` or lies below it, compared by whole path
// segments: `\\host\vault-evil` is never inside `\\host\vault`.
export function isInside(child, parent, platform = process.platform) {
  const c = pathSegments(child, platform);
  const p = pathSegments(parent, platform);
  if (c.length < p.length) return false;
  for (let i = 0; i < p.length; i++) if (c[i] !== p[i]) return false;
  return true;
}
