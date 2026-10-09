// Frames around text the caller must not take as instructions: model output, and
// source text (which may carry injected instructions too).
export const FRAME_OPEN = '--- untrusted model output ---';
export const FRAME_CLOSE = '--- end ---';
export const SOURCE_OPEN = '--- source text (masked) ---';
export const SOURCE_CLOSE = '--- end of source text ---';
const MARKERS = new Set([FRAME_OPEN, FRAME_CLOSE, SOURCE_OPEN, SOURCE_CLOSE]);

// A line that looks like a frame marker (after trimming spaces and tabs) is quoted
// so it can never close or reopen a frame.
export function neutralize(line) {
  return MARKERS.has(line.trim()) ? `> ${line}` : line;
}
