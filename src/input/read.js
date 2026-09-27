// Decoding: UTF-8 (BOM stripped) or UTF-16 LE/BE by BOM; binary detection; line split.
import fs from 'node:fs/promises';
import { InputError } from '../errors.js';

const BINARY_PROBE = 8192;

// Returns { text, encoding } or throws InputError for binary content.
export function decode(buf, name = 'input') {
  let encoding = 'utf-8';
  let body = buf;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    body = buf.subarray(3);
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    encoding = 'utf-16le';
    body = buf.subarray(2);
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    encoding = 'utf-16be';
    body = buf.subarray(2);
  }

  let text;
  if (encoding === 'utf-8') {
    if (body.subarray(0, BINARY_PROBE).includes(0)) throw new InputError(`binary file refused: ${name}`);
    text = new TextDecoder('utf-8').decode(body);
  } else {
    const even = body.length - (body.length % 2);
    let units = Buffer.from(body.subarray(0, even));
    if (encoding === 'utf-16be') units.swap16();
    text = units.toString('utf16le');
    if (text.slice(0, BINARY_PROBE / 2).includes('\u0000')) throw new InputError(`binary file refused: ${name}`);
  }
  return { text, encoding };
}

// Lines without `\r`, numbered from 1 by index + 1. A trailing newline adds no line.
export function splitLines(text) {
  if (text === '') return [];
  const lines = text.replace(/\r/g, '').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

// Reads one already guarded file. `maxBytes` is a hard refusal, never a truncation.
export async function readTextFile(file, { name = file, maxBytes } = {}) {
  const st = await fs.stat(file);
  if (!st.isFile()) throw new InputError(`not a regular file: ${name}`);
  if (maxBytes !== undefined && st.size > maxBytes) {
    throw new InputError(`file too large: ${name} (${st.size} bytes > max_file_bytes ${maxBytes})`);
  }
  const buf = await fs.readFile(file);
  if (maxBytes !== undefined && buf.length > maxBytes) {
    throw new InputError(`file too large: ${name} (${buf.length} bytes > max_file_bytes ${maxBytes})`);
  }
  const { text, encoding } = decode(buf, name);
  return { lines: splitLines(text), encoding, bytes: buf.length };
}
