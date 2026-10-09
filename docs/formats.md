# Input formats

Which files cheap-eyes reads, what each format becomes, how refs show the page, slide,
chapter or attachment of a line, and which files are refused. Read this before
pointing a job at documents, presentations, mail or web pages.

Text is extracted by the [doclines](https://github.com/st412m/doclines) package; its
[formats reference](https://github.com/st412m/doclines/blob/main/docs/formats.md) has
the details of every format.

## Supported formats

| Family | Formats | What becomes lines |
|---|---|---|
| Plain text | anything that is not a known format: `.txt`, `.md`, `.csv`, `.log`, … | UTF-8, or UTF-16 by BOM; lines as in the file (only `\r` removed), no other normalisation. A charset in a URL's `Content-Type` decodes text without a BOM. |
| HTML | `.html`, `.htm`, `.xhtml`, a page served as `text/html` | Charset from the BOM, the HTTP `Content-Type`, `<meta>`, else UTF-8. The `<title>` is the first line; scripts, styles and the head are dropped. |
| PDF | with a text layer | Lines rebuilt per page; a `--- page N ---` marker before every page. |
| Word | DOCX, DOCM, DOTX, DOTM; DOC (Word 97–2003) | Paragraphs, lists, tables. DOCX notes follow the body; DOC footnotes and endnotes follow it under `--- footnotes ---` / `--- endnotes ---`. |
| RTF | `.rtf` | Code pages from `\ansicpg` and `\fcharset`, `\uN` Unicode; footnotes under `--- footnotes ---`. |
| Presentations | PPTX, PPTM, POTX, POTM, PPSX; PPT (PowerPoint 97–2003); ODP, OTP | `--- slide N ---` per slide in order, hidden slides included and marked `(hidden)`; speaker notes under `--- notes N ---`. |
| OpenDocument text | ODT, OTT | Headings, paragraphs, lists, tables; footnotes and endnotes under their own markers. |
| Books | EPUB 2 and 3; FB2, and a ZIP holding one `.fb2` | `--- chapter N: <title> ---` per chapter; FB2 notes under `--- notes ---`. |
| Mail | EML (by the extension `.eml` or the type `message/rfc822`), MSG (Outlook) | `From:`, `To:`, `Cc:`, `Date:`, `Subject:`, then the body; the attachments listed under `--- attachments ---`; each readable attachment extracted under `--- attachment: <name> ---`. |

The format is decided by the content, not by the file name. The extension breaks ties
only for HTML, EML and an encrypted Office file; a text file that starts with `From:`
stays text. A file of no known format is read as plain text; one with NUL bytes in its
first 8 KB is refused as binary.

In a message, an attachment of a format cheap-eyes does not read gets one line
`(not extracted: <reason>)`. An attached message is extracted too; its own attachments
are only listed.

## Places in refs

A marker line (`--- slide 3 ---`) is not numbered, not counted as an input line and
cannot be quoted; the model is told so. Each marker opens a section, and a line inside a
section has a place:

| Section | Marker | Place |
|---|---|---|
| PDF page | `--- page 12 ---` | `p.12` |
| Slide | `--- slide 3 ---` | `slide 3` |
| Speaker notes of a slide | `--- notes 3 ---` | `notes 3` |
| EPUB or FB2 chapter | `--- chapter 2: Title ---` | `chapter 2` |
| DOC, ODT or RTF footnotes, endnotes | `--- footnotes ---`, `--- endnotes ---` | `footnotes`, `endnotes` |
| FB2 notes | `--- notes ---` | `notes` |
| List of a message's attachments | `--- attachments ---` | `attachments` |
| One attachment | `--- attachment: offer.pdf ---` | `attachment: offer.pdf` |

Inside an attachment the place names both, outer first: `attachment: offer.pdf, p.2`,
or `attachment: forwarded.eml, attachments` for the list of an attached message's own
attachments. A line outside every section (the head of a message, the title lines of an
FB2 book, any line of a plain text file) has no place.

Where the place shows:

- refs in the header and in `check.json`: `L123 (slide 3)`, `notes.eml:L40 (attachment: offer.pdf, p.2)`;
- every line of an `extract` result and of a `grep` result:
  `L123 (slide 3)| text`;
- JSON: `place` (a string) on every check item, edit and schema field whose line has
  one; a `draft` line lists the places of its refs in `places`. The `page` number stays
  for pages of a PDF itself (not of a PDF inside an attachment), together with
  `pages` on `draft` lines;
- the [source copy](results.md#source-copies) keeps the sections (`sections` next to
  `page_starts`).

The place comes from the line number. A quote that repeats a prefix with a place,
right or wrong, is read by its number, and the result shows the place anew. A ref that
names an attachment instead of a file (`offer.pdf:L12`) counts as a ref to the message
file when line 12 lies inside that attachment, and is shown as
`L12 (attachment: offer.pdf, p.2)`.

When a chunk breaks inside a section, the next chunk starts with the last marker before
its first line. When a filter skips lines, only the last marker before the next shown
line is kept. The model then sees `--- page 2 ---` of an attachment without the
`--- attachment: … ---` marker above it; the places in refs are computed by the server
and stay complete.

A PDF with some empty pages is read; the header says
`pages without text layer: 3, 7–9`.

## Refused formats

These are refused with the reason, before any model call and before the budget is
touched:

| What | Message |
|---|---|
| Spreadsheets: Excel (`.xlsx`, `.xlsm`, `.xltx`, `.xltm`, `.xls`), OpenDocument spreadsheets (`.ods`) | `unsupported format: Excel workbook (.xlsx) — spreadsheets are not read: tables need exact lookups, use grep or code (<file>)` |
| Excel binary workbooks (`.xlsb`), Excel 95 and older, Word 6/95 and older, PowerPoint 95 and older, Apple iWork, XPS, DjVu, OpenDocument drawings, images (PNG, JPEG, GIF, WebP, TIFF, BMP, HEIC), archives (ZIP, 7z, RAR, gzip, bzip2, xz, tar), SQLite, other OLE files | `unsupported format: <format> — cheap-eyes reads text, HTML, PDF, Word, RTF, PowerPoint, OpenDocument text and presentations, EPUB, FB2, EML, MSG (<file>)` |
| A file that needs a password to open (PDF, Word, PowerPoint, OpenDocument), an EPUB with encrypted content | `encrypted document — cheap-eyes cannot read password-protected files (<file>)` |
| A PDF with less than 20 characters of text per page on average | `no usable text layer (scanned PDF?): <file>` |
| A damaged file | `cannot read <file>: damaged or unsupported <format> file` |
| NUL bytes in the first 8 KB of a file of no known format | `binary file refused: <file>` |

Spreadsheets are refused because the questions asked of a table are exact lookups: a
value in a row, a sum, every row with a field. grep or code answers them reliably; a
model reading a table as text loses rows and columns. There is no OCR.

A file named by its path refuses the whole job. A file matched by a glob is skipped,
and the header lists it with the reason, for example
`refused.xls (unsupported format: Excel workbook (.xls))`.

A PDF protected only against editing or printing (an owner password, no password to
open) is read normally.

## What becomes of the text

- **Lines.** Every format becomes plain lines; from there the pipeline is the same as
  for text files: range, time window, masking, grep, numbering, chunking, the model, the
  checks.
- **Tables** (Word, RTF, HTML, ODT, presentations, books): one table row is one line,
  cells joined by ` | `; an empty cell stays an empty slot (`a |  | c`) so columns do
  not shift. A layout table in HTML (a row with one cell, a row holding a nested table,
  a row of 2000 characters or more) is written cell by cell in reading order. PDF tables
  are not rebuilt: a row comes out as its cells separated by spaces. A PPT table comes
  out one cell per line: in that format a table is a group of separate shapes.
- **Normalisation** (every format but plain text): the soft hyphen (U+00AD),
  zero-width space (U+200B) and BOM (U+FEFF) are dropped, NBSP becomes a space, `\r` is
  dropped, text is in Unicode NFC, trailing spaces are trimmed and runs of blank lines
  become one. A word split by a soft hyphen at a line end is joined on the first line
  (`планиру` + `ем упростить` → `планируем` + `упростить`), never across a page.
  Letters are never folded: a Latin `P` inside a Cyrillic word stays as it is.
- **What is lost:** images, charts, layout, fonts and colours; Word headers, footers and
  comments; slide numbers, dates and footers of presentations; tracked deletions and
  comments in ODT.
- **The minus sign.** A document's `−40` (U+2212) stays U+2212. A model that writes
  `-40` with a hyphen gets a quote mismatch; numbers in `schema` values are compared
  after normalisation.
- **CJK text in PDFs** is read with the CMaps shipped inside the installed
  `pdfjs-dist` package.
- **Warnings** from the extraction (a parser note, a missing chapter file) go to the
  server's stderr as `cheap-eyes: <file>: <text>`, not into the job.

## Limits

| Setting | Default | What it caps |
|---|---|---|
| `max_doc_bytes` | 50 MB | The file of every format but plain text; the decoded attachments of a message together get a separate `max_doc_bytes` of their own. |
| `max_file_bytes` | 2 MB | Plain text files; for every other format, the extracted text, attachments included. |
| `extract_timeout_s` | 60 | One extraction. It runs in a worker thread with a 1 GB heap cap, so a hostile or huge file is stopped without stopping the server. |
| `max_url_bytes` | 10 MB | One fetched URL, counted while streaming. |

Over a limit the file is refused, never truncated.

The heap cap holds only when the server process runs without `--max-old-space-size`
(as a flag or in `NODE_OPTIONS`) above about 1.5 GB: Node then gives the worker the
server's own limit, and stderr says once
`cheap-eyes: heap cap of 1024 MB not in effect: …`.

## Verifying a quote

The extracted, masked text of every file that is not plain text, and of every URL, is
stored with the result, numbered and marked exactly as the model saw it.
`eyes_result {id, source: "<name>", offset, limit}` pages it, and `grep` searches it,
so a quote from a web page or a presentation can be checked without file access. See
[tools](tools.md#eyes_result).

## Package size

`pdfjs-dist`, which doclines uses for PDF, ships CMaps and standard fonts: about 33 MB
of the roughly 56 MB an install takes without optional dependencies. It also lists
`@napi-rs/canvas` as an optional dependency (a native binary of about 37 MB); text
extraction does not need it and never loads it, and the Home Assistant app installs
without it (`npm install --omit=optional`).
