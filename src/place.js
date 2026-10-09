// The place of a line in its document, from the doclines `sections`: "p.12", "slide 3",
// "notes 3", "chapter 2", "footnotes", "attachments", "attachment: offer.pdf", and for a
// section inside an attachment the chain outer to inner, "attachment: offer.pdf, p.2".
// Shown in refs as "L123 (slide 3)"; derived from the line number, never taken from a
// model's answer.

// A place written in a line prefix between the number and "|": " (p.12)",
// " (attachment: a (1).pdf, p.2)"; it ends at the first ")|".
export const PLACE_IN_PREFIX = String.raw`(?: \([^\n]*?\))?`;

/**
 * Every section holding 1-based line n, outer to inner: start ≤ n ≤ end; of two with
 * the same start the longer is outer; equal ranges keep the doclines order (a parent
 * is listed before the sections inside it).
 */
export function sectionChain(sections, n) {
  return (sections ?? []).filter((s) => s.start <= n && n <= s.end).sort((a, b) => a.start - b.start || b.end - a.end);
}

// An attachment name as its marker shows it: control characters removed, line breaks
// → space, at most 120 characters (the section label is the raw name).
export function nameText(s) {
  return String(s ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 120);
}

function sectionText(s) {
  switch (s.kind) {
    case 'page':
      return `p.${s.n}`;
    case 'attachment':
      return `attachment: ${nameText(s.label)}`;
    case 'footnotes':
    case 'endnotes':
    case 'attachments':
      return s.kind;
    default:
      // slide, notes, chapter (number only, never the title), sheet
      return s.n === null || s.n === undefined ? s.kind : `${s.kind} ${s.n}`;
  }
}

/** The place of line n, or null for a line outside every section. */
export function placeOf(sections, n) {
  const chain = sectionChain(sections, n);
  return chain.length ? chain.map(sectionText).join(', ') : null;
}
