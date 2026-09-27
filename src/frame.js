// Frame around untrusted model output (source text may carry injected instructions).
export const FRAME_OPEN = '--- untrusted model output ---';
export const FRAME_CLOSE = '--- end ---';

// A line that looks like a frame marker (after trimming spaces and tabs) is quoted
// so it can never close or reopen the frame.
export function neutralize(line) {
  const t = line.trim();
  return t === FRAME_OPEN || t === FRAME_CLOSE ? `> ${line}` : line;
}
