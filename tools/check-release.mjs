#!/usr/bin/env node
// Release consistency, also run by CI and by the image workflow: one version everywhere,
// a server.json the MCP Registry accepts and a Claude Desktop extension manifest that
// matches the package. Checks
// - package.json version = server.json version = server.json packages[0].version =
//   ha-addon config.yaml version = the cheap-eyes@<v> pin and io.hass.version in the
//   add-on Dockerfile = the pin in the root Dockerfile = the ghcr.io image tag in
//   compose.example.yaml = manifest.json version = the image tag of every docker line in
//   README.md and docs/installation.md;
// - manifest.json: name, author, the node entry point = package.json bin, args[0] the
//   entry point, compatibility.runtimes.node = engines.node, the tools = TOOL_DEFS of
//   src/tools.js, no HTTPS_PROXY in env (an unfilled optional field would stop Node at
//   start), icon.png a 512×512 PNG;
// - package.json mcpName = server.json name; packages[0] is the npm package itself;
// - server.json field limits of the 2025-12-11 schema: name pattern and 3–200 chars,
//   description and title 1–100 chars, a specific package version (no range).
// No network. The tool list comes from src/tools.js (needs npm ci).
//
//   node tools/check-release.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
export const SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
const NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const RANGE_RE = /[\^~><=*x ]|\|\|/;

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

/** Returns a list of problems (empty when the release is consistent). `toolNames`: the
 * tool names of src/tools.js, checked against the manifest when given. */
export function checkRelease(root = ROOT, { toolNames = null } = {}) {
  const problems = [];
  const pkg = JSON.parse(read(root, 'package.json'));
  const server = JSON.parse(read(root, 'server.json'));
  const v = pkg.version;
  const versions = {
    'server.json version': server.version,
    'server.json packages[0].version': server.packages?.[0]?.version,
    'ha-addon/cheap_eyes/config.yaml version': /^version:\s*"?([^"\s]+)"?\s*$/m.exec(read(root, 'ha-addon/cheap_eyes/config.yaml'))?.[1],
    'ha-addon/cheap_eyes/Dockerfile cheap-eyes@': /cheap-eyes@([^\s\\]+)/.exec(read(root, 'ha-addon/cheap_eyes/Dockerfile'))?.[1],
    'ha-addon/cheap_eyes/Dockerfile io.hass.version': /io\.hass\.version="([^"]+)"/.exec(read(root, 'ha-addon/cheap_eyes/Dockerfile'))?.[1],
    'Dockerfile cheap-eyes@': /cheap-eyes@([^\s\\]+)/.exec(read(root, 'Dockerfile'))?.[1],
    'compose.example.yaml image': /^\s*image:\s*ghcr\.io\/st412m\/cheap-eyes:(\S+)\s*$/m.exec(read(root, 'compose.example.yaml'))?.[1],
    'manifest.json version': JSON.parse(read(root, 'manifest.json')).version,
  };
  for (const [where, got] of Object.entries(versions)) {
    if (got !== v) problems.push(`${where} is ${got ?? '(missing)'}, package.json version is ${v}`);
  }
  problems.push(...checkDocImages(root, v));
  if (server.$schema !== SCHEMA_URL) problems.push(`server.json $schema is ${server.$schema}, expected ${SCHEMA_URL}`);
  if (pkg.mcpName !== server.name) problems.push(`package.json mcpName ${pkg.mcpName} != server.json name ${server.name}`);
  if (typeof server.name !== 'string' || !NAME_RE.test(server.name) || server.name.length < 3 || server.name.length > 200) problems.push(`server.json name is not a valid registry name: ${server.name}`);
  for (const field of ['description', 'title']) {
    const s = server[field];
    if (field === 'description' || s !== undefined) {
      if (typeof s !== 'string' || s.length < 1 || s.length > 100) problems.push(`server.json ${field} must be 1–100 chars (has ${s?.length ?? 0})`);
    }
  }
  const p0 = server.packages?.[0];
  if (!p0 || p0.registryType !== 'npm' || p0.identifier !== pkg.name) problems.push(`server.json packages[0] must be the npm package ${pkg.name}`);
  if (p0?.transport?.type !== 'stdio') problems.push('server.json packages[0].transport.type must be stdio');
  if (typeof p0?.version !== 'string' || RANGE_RE.test(p0.version)) problems.push(`server.json packages[0].version must be a specific version: ${p0?.version}`);
  if (!Array.isArray(pkg.files) || pkg.files.includes('server.json')) problems.push('server.json must stay out of the npm package (package.json files)');
  problems.push(...checkManifest(root, pkg, toolNames));
  return problems;
}

// The docs that show a `docker run` of the published image with its version written out.
export const DOC_IMAGE_FILES = ['README.md', 'docs/installation.md'];
const DOC_IMAGE_RE = /ghcr\.io\/st412m\/cheap-eyes:([^\s`"')\]]+)/g;

/** Every ghcr.io/st412m/cheap-eyes:<tag> in DOC_IMAGE_FILES carries version `v`; each file has one at least. */
export function checkDocImages(root, v) {
  const problems = [];
  for (const rel of DOC_IMAGE_FILES) {
    const lines = read(root, rel).split('\n');
    let found = 0;
    lines.forEach((line, i) => {
      for (const m of line.matchAll(DOC_IMAGE_RE)) {
        found++;
        if (m[1] !== v) problems.push(`${rel}:${i + 1} image is ${m[1]}, package.json version is ${v}`);
      }
    });
    if (!found) problems.push(`${rel} image is (missing): no ghcr.io/st412m/cheap-eyes:<version> line`);
  }
  return problems;
}

/** manifest.json (Claude Desktop extension) against package.json and the tool list. */
export function checkManifest(root, pkg, toolNames = null) {
  const problems = [];
  const m = JSON.parse(read(root, 'manifest.json'));
  const entry = m.server?.entry_point;
  if (m.name !== pkg.name) problems.push(`manifest.json name is ${m.name}, package.json name is ${pkg.name}`);
  if (m.author?.name !== 'st412m') problems.push('manifest.json author.name must be st412m');
  if (m.server?.type !== 'node' || entry !== pkg.bin?.['cheap-eyes']) problems.push(`manifest.json server must be node with entry_point ${pkg.bin?.['cheap-eyes']} (package.json bin)`);
  if (m.server?.mcp_config?.args?.[0] !== '${__dirname}/' + entry) problems.push(`manifest.json mcp_config.args[0] must be \${__dirname}/${entry} (the entry point)`);
  if (m.compatibility?.runtimes?.node !== pkg.engines?.node) problems.push(`manifest.json compatibility.runtimes.node is ${m.compatibility?.runtimes?.node}, package.json engines.node is ${pkg.engines?.node}`);
  const env = m.server?.mcp_config?.env ?? {};
  if (Object.hasOwn(env, 'HTTPS_PROXY')) problems.push('manifest.json env must not set HTTPS_PROXY: an unfilled optional field stops Node at start; pass the proxy in CHEAP_EYES_HTTPS_PROXY');
  const got = (m.tools ?? []).map((t) => t.name);
  if (toolNames && JSON.stringify(got) !== JSON.stringify(toolNames)) problems.push(`manifest.json tools (${got.join(', ')}) differ from src/tools.js (${toolNames.join(', ')})`);
  if ((m.tools ?? []).some((t) => !t.description)) problems.push('manifest.json: every tool needs a description');
  problems.push(...checkIcon(root, m.icon));
  return problems;
}

/** manifest.json icon: icon.png, a PNG of 512×512 by its IHDR chunk. */
export function checkIcon(root = ROOT, icon = 'icon.png') {
  if (icon !== 'icon.png') return [`manifest.json icon is ${icon ?? '(missing)'}, expected icon.png`];
  let buf;
  try {
    buf = fs.readFileSync(path.join(root, icon));
  } catch {
    return [`${icon} is missing`];
  }
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG) || buf.toString('latin1', 12, 16) !== 'IHDR') return [`${icon} is not a PNG`];
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return w === 512 && h === 512 ? [] : [`${icon} is ${w}×${h}, expected 512×512`];
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const { TOOL_DEFS } = await import(pathToFileURL(path.join(ROOT, 'src', 'tools.js')).href);
  const problems = checkRelease(ROOT, { toolNames: Object.keys(TOOL_DEFS) });
  for (const p of problems) console.error(`check-release: ${p}`);
  if (problems.length) process.exitCode = 1;
  else console.log(`check-release: ${JSON.parse(read(ROOT, 'package.json')).version} everywhere, server.json ok, manifest.json ok`);
}
