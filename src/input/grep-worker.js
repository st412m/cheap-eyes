// Runs the user's regex off the main thread so a catastrophic pattern can be killed.
import { parentPort, workerData } from 'node:worker_threads';

const { pattern, flags, files } = workerData;
const re = new RegExp(pattern, flags);
const hits = files.map((texts) => {
  const out = [];
  for (let i = 0; i < texts.length; i++) if (re.test(texts[i])) out.push(i);
  return out;
});
parentPort.postMessage(hits);
