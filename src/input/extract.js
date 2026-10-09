// One source → lines, through doclines. Plain text is decoded on the calling thread
// and split into lines as in the file (only \r removed); max_file_bytes applies to the
// file size. Every other format is detected on the calling thread and extracted by
// doclines in a worker thread with a timeout: max_doc_bytes caps the input,
// max_file_bytes the extracted text. Refusals become InputError in cheap-eyes wording,
// with cheap-eyes config keys. doclines warnings go to stderr only (stdout is the
// stdio MCP channel), never into the job.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DoclinesError, FORMATS, extract } from 'doclines';
import { InputError } from '../errors.js';
import { fetchUrl, maskedUrl } from './url.js';

export const READS = 'cheap-eyes reads text, HTML, PDF, Word, RTF, PowerPoint, OpenDocument text and presentations, EPUB, FB2, EML, MSG';
// Exact lookups in tables are grep or code work: spreadsheets are refused.
export const SPREADSHEETS = new Set(['xlsx', 'xls', 'ods']);
export const ALLOWED = Object.freeze(FORMATS.map((f) => f.id).filter((id) => !SPREADSHEETS.has(id)));

// Warnings about the host or the installed pdfjs, not about one file.
const PROCESS_WARNING = /^heap cap of |^pdfjs \S+ not patched for soft hyphens/;
const printed = new Set();

/** doclines warnings to stderr: per file with its name, process-wide ones once per process. */
export function printWarnings(warnings, name) {
  for (const w of warnings) {
    if (!PROCESS_WARNING.test(w)) console.error(`cheap-eyes: ${name}: ${w}`);
    else if (!printed.has(w)) {
      printed.add(w);
      console.error(`cheap-eyes: ${w}`);
    }
  }
}

function unsupported(label, name) {
  return new InputError(`unsupported format: ${label} — ${READS} (${name})`, { reason: `unsupported format: ${label}` });
}

/** A DoclinesError as the InputError the caller sees; anything else is returned as is. */
export function toInputError(e, { name, config }) {
  if (!(e instanceof DoclinesError)) return e;
  const keys = (s) => s.replaceAll('maxDocBytes', 'max_doc_bytes').replaceAll('maxTextBytes', 'max_file_bytes');
  switch (e.code) {
    case 'unsupported':
      // A charset or code page this Node build cannot decode carries no label.
      return e.label ? unsupported(e.label, name) : new InputError(e.message, { reason: e.reason ?? undefined });
    case 'not_allowed':
      if (SPREADSHEETS.has(e.format)) {
        return new InputError(`unsupported format: ${e.label} — spreadsheets are not read: tables need exact lookups, use grep or code (${name})`, { reason: `unsupported format: ${e.label}` });
      }
      return unsupported(e.label, name);
    case 'encrypted':
      return new InputError(`encrypted document — cheap-eyes cannot read password-protected files (${name})`, { reason: 'encrypted document' });
    case 'damaged':
      if (e.detail) console.error(`cheap-eyes: extraction failed: ${name}: ${e.detail}`);
      // "damaged OLE compound file" and the like are refused as formats, as in 0.2.
      if (e.label && e.message.startsWith('unsupported format: ')) return unsupported(e.label, name);
      return new InputError(e.message, { reason: e.reason ?? undefined });
    case 'too_large':
      return new InputError(keys(e.message), { reason: 'document too large' });
    case 'text_too_large':
      if (e.format === 'text') return new InputError(keys(e.message), { reason: 'file too large' });
      // doclines stops at the limit, so the full size is not known.
      return new InputError(`extracted text too large: ${name} (over max_file_bytes ${config.max_file_bytes})`, { reason: 'extracted text too large' });
    case 'timeout':
      return new InputError(`extraction timed out after ${config.extract_timeout_s} s (extract_timeout_s): ${name}`, { reason: 'extraction timed out' });
    case 'binary':
      return new InputError(`binary file refused: ${name}`);
    case 'not_a_file':
      return new InputError(e.message);
    default:
      // no_text_layer, out_of_memory: the doclines wording is the 0.2 wording.
      return new InputError(e.message, { reason: e.reason ?? undefined });
  }
}

async function run(input, opts, { name, config }) {
  let r;
  try {
    r = await extract(input, {
      ...opts,
      name,
      formats: ALLOWED,
      maxDocBytes: config.max_doc_bytes,
      maxTextBytes: config.max_file_bytes,
      timeoutMs: config.extract_timeout_s * 1000,
    });
  } catch (e) {
    throw toInputError(e, { name, config });
  }
  printWarnings(r.warnings, name);
  return {
    lines: r.lines,
    markers: r.markers,
    sections: r.sections,
    pageStarts: r.pageStarts,
    pagesWithoutText: r.pagesWithoutText,
    format: r.format,
    encoding: r.charset,
    bytes: r.bytes,
    sha256: r.sha256,
    warnings: r.warnings,
  };
}

/**
 * Read one already guarded file. Returns { lines, markers, sections, pageStarts,
 * pagesWithoutText, format, encoding, bytes, sha256, warnings }; `markers`/`sections`
 * are empty and `pageStarts` null for plain text.
 */
export async function readSource(file, { name = file, config }) {
  const st = await fs.stat(file);
  if (!st.isFile()) throw new InputError(`not a regular file: ${name}`);
  return run(file, {}, { name, config });
}

/**
 * Fetch one URL (see url.js) and read it like a file: format by content, the
 * extension of the final URL path and the Content-Type breaking ties. Adds { meta }
 * for the sources index: masked URL and final URL, content type, fetch time.
 */
export async function readUrlSource(url, { name, config, deps = {}, now = Date.now() }) {
  const r = await fetchUrl(url, { config, deps });
  const ext = path.posix.extname(new URL(r.finalUrl).pathname);
  const meta = { url: maskedUrl(url), final_url: maskedUrl(r.finalUrl), content_type: r.contentType, fetched_at: new Date(now).toISOString() };
  return { ...(await run(r.buf, { ext, contentType: r.contentType }, { name, config })), meta };
}
