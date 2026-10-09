// Release consistency (tools/check-release.mjs) and the tool annotations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { TOOL_DEFS } from '../src/tools.js';
import { checkRelease } from '../tools/check-release.mjs';
import { tmpDir } from './helpers.js';

const ROOT = path.join(import.meta.dirname, '..');
const FILES = ['package.json', 'server.json', 'Dockerfile', 'compose.example.yaml', 'ha-addon/cheap_eyes/config.yaml', 'ha-addon/cheap_eyes/Dockerfile'];

function copy() {
  const d = tmpDir();
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(d, f));
  }
  return d;
}

const edit = (d, f, from, to) => fs.writeFileSync(path.join(d, f), fs.readFileSync(path.join(d, f), 'utf8').replace(from, to));

test('the repository is consistent: one version everywhere, server.json within the registry limits', () => {
  assert.deepEqual(checkRelease(ROOT), []);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.mcpName, 'io.github.st412m/cheap-eyes');
  assert.ok(!pkg.files.some((f) => /^(test|ha-addon|out)\b|server\.json/.test(f)), 'none of these go into the npm package');
});

test('check-release names every place that disagrees', () => {
  const d = copy();
  edit(d, 'ha-addon/cheap_eyes/Dockerfile', /cheap-eyes@[\d.]+/, 'cheap-eyes@9.9.9');
  edit(d, 'Dockerfile', /cheap-eyes@[\d.]+/, 'cheap-eyes@9.9.8');
  edit(d, 'server.json', /"description": "[^"]*"/, `"description": "${'x'.repeat(101)}"`);
  edit(d, 'server.json', /"version": "([\d.]+)",\n      "transport"/, '"version": "^$1",\n      "transport"');
  const p = checkRelease(d);
  assert.ok(p.some((x) => /^ha-addon\/cheap_eyes\/Dockerfile cheap-eyes@ is 9\.9\.9/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /^Dockerfile cheap-eyes@ is 9\.9\.8/.test(x)));
  assert.ok(p.some((x) => /description must be 1–100 chars \(has 101\)/.test(x)));
  assert.ok(p.some((x) => /packages\[0\]\.version must be a specific version/.test(x)));
});

test('every tool has a title and all four hints, as decided for each handler', () => {
  const want = {
    eyes_run: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    eyes_result: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    eyes_stats: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  };
  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    const { title, ...hints } = def.annotations;
    assert.equal(title, def.title);
    assert.deepEqual(hints, want[name], name);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(TOOL_DEFS).map(([k, d]) => [k, d.title])), { eyes_run: 'Run cheap reading job', eyes_result: 'Read job result', eyes_stats: 'Usage and models' });
});

test('each tool description names its alternative or follow-up; all three stay under 800 characters', () => {
  const d = Object.fromEntries(Object.entries(TOOL_DEFS).map(([k, v]) => [k, v.description]));
  const names = (name, words) => {
    for (const w of words) assert.ok(d[name].includes(w), `${name} names ${w}`);
  };
  names('eyes_run', ['grep', 'eyes_result']);
  names('eyes_result', ['eyes_run', 'cancel']);
  names('eyes_stats', ['eyes_run']);
  const total = Object.values(d).join('').length;
  assert.ok(total < 800, `${total} characters`);
});
