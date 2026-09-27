// grep with context windows. Matching runs in a worker_thread with a timeout.
import { Worker } from 'node:worker_threads';
import { InputError } from '../errors.js';

export const GREP_TIMEOUT_MS = 5000;
const MAX_PATTERN = 1000;

export function compileCheck(pattern, ignoreCase) {
  if (pattern.length > MAX_PATTERN) throw new InputError(`grep pattern too long (> ${MAX_PATTERN} chars)`);
  try {
    new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (e) {
    throw new InputError(`grep: invalid regular expression: ${e.message}`);
  }
}

// `texts`: per file, the candidate lines' (already masked) text. Returns, per file,
// the indices into that array whose line matches.
export async function grepMatches(texts, { pattern, ignoreCase = false, timeoutMs = GREP_TIMEOUT_MS }) {
  compileCheck(pattern, ignoreCase);
  const payload = texts;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./grep-worker.js', import.meta.url), {
      workerData: { pattern, flags: ignoreCase ? 'i' : '', files: payload },
      execArgv: [],
    });
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => {
      worker.terminate();
      finish(reject, new InputError(`grep: pattern timed out after ${timeoutMs} ms (catastrophic backtracking?): ${pattern}`));
    }, timeoutMs);
    worker.once('message', (hits) => {
      finish(resolve, hits);
      worker.terminate();
    });
    worker.once('error', (e) => finish(reject, new InputError(`grep failed: ${e.message}`)));
    worker.once('exit', (code) => finish(reject, new InputError(`grep worker exited with code ${code}`)));
  });
}

// Keep candidate lines within `context` original line numbers of a match.
export function withContext(nums, hitIdx, context) {
  const keep = new Set();
  let lo = 0;
  for (const i of hitIdx) {
    const n = nums[i];
    while (lo < nums.length && nums[lo] < n - context) lo++;
    for (let j = lo; j < nums.length && nums[j] <= n + context; j++) keep.add(nums[j]);
  }
  return nums.filter((n) => keep.has(n));
}
