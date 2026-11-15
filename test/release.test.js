// Release consistency (tools/check-release.mjs) and the tool annotations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { TOOL_DEFS } from '../src/tools.js';
import { checkRelease } from '../tools/check-release.mjs';
import { tmpDir } from './helpers.js';

const ROOT = path.join(import.meta.dirname, '..');
const FILES = ['package.json', 'server.json', 'manifest.json', 'icon.png', 'Dockerfile', 'compose.example.yaml', 'ha-addon/cheap_eyes/config.yaml', 'ha-addon/cheap_eyes/Dockerfile', 'README.md', 'docs/installation.md'];
const TOOLS = Object.keys(TOOL_DEFS);

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
  assert.deepEqual(checkRelease(ROOT, { toolNames: TOOLS }), []);
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

test('check-release covers the manifest: version, tools, entry point, no HTTPS_PROXY, the icon', () => {
  const d = copy();
  const m = JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8'));
  m.version = '9.9.7';
  m.tools = m.tools.slice(0, 2);
  m.server.mcp_config.args[0] = '${__dirname}/src/main.js';
  m.server.mcp_config.env.HTTPS_PROXY = '${user_config.https_proxy}';
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(m));
  const png = fs.readFileSync(path.join(d, 'icon.png'));
  png.writeUInt32BE(256, 16);
  fs.writeFileSync(path.join(d, 'icon.png'), png);
  const p = checkRelease(d, { toolNames: TOOLS });
  assert.ok(p.some((x) => /^manifest\.json version is 9\.9\.7/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /^manifest\.json tools \(eyes_run, eyes_result\) differ from src\/tools\.js \(eyes_run, eyes_result, eyes_stats\)$/.test(x)));
  assert.ok(p.some((x) => /mcp_config\.args\[0\] must be \$\{__dirname\}\/src\/cli\.js/.test(x)));
  assert.ok(p.some((x) => /env must not set HTTPS_PROXY/.test(x)));
  assert.ok(p.some((x) => /^icon\.png is 256×512, expected 512×512$/.test(x)));
});

test('check-release covers the image line of compose.example.yaml and the Dockerfile pin', () => {
  const d = copy();
  edit(d, 'compose.example.yaml', /ghcr\.io\/st412m\/cheap-eyes:[\d.]+/, 'ghcr.io/st412m/cheap-eyes:9.9.6');
  edit(d, 'Dockerfile', /SRC=cheap-eyes@[\d.]+/, 'SRC=cheap-eyes@9.9.5');
  const p = checkRelease(d, { toolNames: TOOLS });
  assert.ok(p.some((x) => /^compose\.example\.yaml image is 9\.9\.6/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /^Dockerfile cheap-eyes@ is 9\.9\.5/.test(x)));
  const local = copy();
  edit(local, 'compose.example.yaml', /image: ghcr\.io\/st412m\/cheap-eyes:[\d.]+/, 'image: cheap-eyes:local');
  assert.ok(checkRelease(local).some((x) => /^compose\.example\.yaml image is \(missing\)/.test(x)), 'only the published image counts');
});

test('check-release covers the image version in the docker lines of README.md and docs/installation.md', () => {
  const d = copy();
  edit(d, 'README.md', /ghcr\.io\/st412m\/cheap-eyes:[\d.]+/, 'ghcr.io/st412m/cheap-eyes:9.9.4');
  edit(d, 'docs/installation.md', /ghcr\.io\/st412m\/cheap-eyes:[\d.]+/g, 'ghcr.io/st412m/cheap-eyes:latest');
  const p = checkRelease(d, { toolNames: TOOLS });
  assert.ok(p.some((x) => /^README\.md:\d+ image is 9\.9\.4, package\.json version is /.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /^docs\/installation\.md:\d+ image is latest/.test(x)));
  const none = copy();
  edit(none, 'README.md', /ghcr\.io\/st412m\/cheap-eyes:[\d.]+/g, 'cheap-eyes:local');
  assert.ok(checkRelease(none, { toolNames: TOOLS }).some((x) => /^README\.md image is \(missing\)/.test(x)), 'a doc without the image line is a problem');
});

test('the Docker image and the extension: the settings UI, the read root, the state dir; no HTTPS_PROXY in the manifest', () => {
  const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(docker, /ENV CHEAP_EYES_STATE_DIR=\/data CHEAP_EYES_READ_ROOTS=\/input CHEAP_EYES_SETTINGS_UI="the environment of the container"/);
  assert.match(docker, /--omit=optional/);
  assert.doesNotMatch(docker, /npm install -g/);
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(m.server.mcp_config.env).sort(), ['CHEAP_EYES_DAILY_BUDGET_USD', 'CHEAP_EYES_HTTPS_PROXY', 'CHEAP_EYES_OPENROUTER_KEY', 'CHEAP_EYES_SETTINGS_UI']);
  assert.deepEqual(m.server.mcp_config.args, ['${__dirname}/src/cli.js', '${user_config.read_roots}']);
  assert.equal(m.user_config.openrouter_key.sensitive, true);
  assert.equal(m.user_config.read_roots.multiple, true);
  assert.deepEqual(m.compatibility.platforms, ['darwin', 'win32']);
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
