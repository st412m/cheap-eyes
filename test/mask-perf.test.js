// Hostile inputs for the masker. scan-secrets:allow-file
// Every rule must stay linear: a 2 MB single-line file must not stall the event loop.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Masker } from '../src/mask.js';

const N = 2 * 1024 * 1024;
const rep = (s) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
const INPUTS = {
  'a×N': rep('a'),
  'aB3_-×N': rep('aB3_-'),
  'a.×N': rep('a.'),
  'base64 with /': rep('Ab3/+x9Z'),
};
const LIMIT_MS = 1000;

function timed(fn) {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

test('each rule on the 2 MB inputs: under 1 s in total', () => {
  const rules = new Masker().rules;
  for (const [name, re] of rules) {
    let total = 0;
    for (const s of Object.values(INPUTS)) {
      total += timed(() => {
        re.lastIndex = 0;
        s.replace(re, (m) => m);
      });
    }
    assert.ok(total < LIMIT_MS, `rule ${name}: ${total.toFixed(0)} ms`);
  }
});

test('the whole Masker on the 2 MB inputs: under 1 s in total', () => {
  let total = 0;
  const per = {};
  for (const [name, s] of Object.entries(INPUTS)) {
    const dt = timed(() => new Masker().maskText(s));
    per[name] = Math.round(dt);
    total += dt;
  }
  assert.ok(total < LIMIT_MS, `Masker: ${total.toFixed(0)} ms ${JSON.stringify(per)}`);
});

test('key–value rule on hostile shapes stays linear', () => {
  const hostile = [rep('password:"'), rep("password: '"), rep('a:'), 'a' + ' '.repeat(N) + ':', rep('password: x ')];
  let total = 0;
  for (const s of hostile) total += timed(() => new Masker().maskText(s));
  assert.ok(total < 2 * LIMIT_MS, `${total.toFixed(0)} ms`);
});
