// Source copies kept with a result: <results>/<id>.sources/
//   <n>.txt    the extracted, normalised, masked text exactly as numbered for the
//              model: "L12| text" lines with the marker lines ("--- page 3 ---")
//   <n>.json   { markers, page_starts, sections }
//   index.json [{ n, name, kind: file|url, path | url, final_url, content_type, format,
//                 bytes, sha256, fetched_at, pages, lines }]
// Quote checks, page maps and later verification (eyes_result source) work from
// these without the original file or page.
import fs from 'node:fs/promises';
import path from 'node:path';
import { RESULT_ID_RE } from './tools.js';

export function sourcesDir(resultsDir, id) {
  if (!RESULT_ID_RE.test(id)) throw new Error(`not a result id: ${id}`);
  return path.join(resultsDir, `${id}.sources`);
}

export function renderSource(lines, markers = []) {
  const out = [];
  let mi = 0;
  lines.forEach((text, i) => {
    for (; mi < markers.length && markers[mi].at <= i; mi++) out.push(markers[mi].text);
    out.push(`L${i + 1}| ${text}`);
  });
  for (; mi < markers.length; mi++) out.push(markers[mi].text);
  return out;
}

/** `copies`: [{ name, kind, path?, meta?, format, bytes, sha256, lines, markers, pageStarts, sections }] */
export async function writeSources(resultsDir, id, copies) {
  if (!copies.length) return;
  const dir = sourcesDir(resultsDir, id);
  await fs.mkdir(dir, { recursive: true });
  const index = [];
  for (const [i, c] of copies.entries()) {
    const n = i + 1;
    await fs.writeFile(path.join(dir, `${n}.txt`), renderSource(c.lines, c.markers).join('\n') + '\n');
    await fs.writeFile(path.join(dir, `${n}.json`), JSON.stringify({ markers: c.markers, page_starts: c.pageStarts, sections: c.sections ?? [] }) + '\n');
    index.push({
      n,
      name: c.name,
      kind: c.kind,
      ...(c.kind === 'url' ? { url: c.meta.url, final_url: c.meta.final_url, content_type: c.meta.content_type, fetched_at: c.meta.fetched_at } : { path: c.path }),
      format: c.format,
      bytes: c.bytes,
      sha256: c.sha256,
      pages: c.pageStarts ? c.pageStarts.length : null,
      lines: c.lines.length,
    });
  }
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
}

export async function readSourcesIndex(resultsDir, id) {
  try {
    return JSON.parse(await fs.readFile(path.join(sourcesDir(resultsDir, id), 'index.json'), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Rendered lines of source n (an integer from index.json, never a path).
export async function readSourceLines(resultsDir, id, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`bad source number: ${n}`);
  const text = await fs.readFile(path.join(sourcesDir(resultsDir, id), `${n}.txt`), 'utf8');
  return text.replace(/\n$/, '').split('\n');
}
