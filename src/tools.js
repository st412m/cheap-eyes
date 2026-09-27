// Input schemas of the three tools. Every description is sent to the client in
// each session, so they stay short.
import { z } from 'zod';
import { refusedSuffix, refusedSuffixMessage } from './model-ids.js';

export const MODES = ['extract', 'draft', 'edits'];

// YYYY-MM-DD_HHMMSS-<mode>-<6 hex>, UTC. Matched exactly; never used as a path.
export const RESULT_ID_RE = /^\d{4}-\d{2}-\d{2}_\d{6}-(?:extract|draft|edits)-[0-9a-f]{6}$/;

export const eyesRunInput = z.strictObject({
  task: z.string().min(1).describe('What to look for or write. Masked like file content.'),
  mode: z
    .enum(MODES)
    .describe('extract: verbatim input lines; draft: markdown with line refs; edits: JSON line edits (never applied)'),
  model: z
    .string()
    .min(1)
    .superRefine((id, ctx) => {
      const s = refusedSuffix(id);
      if (s) ctx.addIssue({ code: 'custom', message: refusedSuffixMessage(s) });
    })
    .optional()
    .describe('Model alias from config; default per mode'),
  files: z
    .array(z.string().min(1))
    .min(1)
    .describe('Absolute paths or globs inside read roots. Range "#L100-L400" only with a single file'),
  grep: z
    .strictObject({
      pattern: z.string().min(1).describe('JS regex'),
      context: z.number().int().min(0).optional().describe('Lines around each match, default 3'),
      ignore_case: z.boolean().optional(),
    })
    .optional()
    .describe('Send only matching windows'),
  time: z
    .strictObject({
      since: z.string().optional().describe('ISO 8601'),
      until: z.string().optional().describe('ISO 8601'),
      tz: z.string().optional().describe('IANA zone for stamps without offset'),
    })
    .optional()
    .describe('Keep log lines whose timestamp is in the window'),
  export_to: z.string().min(1).optional().describe('Also copy the result here (inside write_roots)'),
  overwrite: z.boolean().optional().describe('Replace an earlier export of this server'),
  max_tokens: z.number().int().positive().optional().describe('Output cap per chunk, default 4096'),
  dry_run: z.boolean().optional().describe('Build and store the request, do not call the model'),
  async: z.boolean().optional().describe('Return the result id at once; poll eyes_result'),
});

export const eyesResultInput = z.strictObject({
  id: z.string().regex(RESULT_ID_RE, 'not a result id').describe('Result id from eyes_run'),
  offset: z.number().int().min(1).optional().describe('First result line (1-based)'),
  limit: z.number().int().min(1).max(200).optional().describe('Lines to return, max 200'),
  grep: z.string().min(1).optional().describe('JS regex over result lines'),
  check: z.boolean().optional().describe('Return the check report, bad items first'),
  cancel: z.boolean().optional().describe('Abort a running job'),
});

export const eyesStatsInput = z.strictObject({
  models: z.boolean().optional().describe('Add the model table per alias'),
  candidates: z
    .strictObject({
      min_context: z.number().int().positive().optional(),
      max_price_in: z.number().positive().optional().describe('USD per 1M input tokens'),
    })
    .optional()
    .describe('Suggest up to 10 cheap ZDR models not in config'),
});

export const TOOL_DEFS = {
  eyes_run: {
    description:
      'Hand bulk reading of local files to a cheap model. The server reads, masks secrets, numbers lines, filters, chunks, then checks every quote and line ref against the source. Returns a short checked header; full text via eyes_result.',
    inputSchema: eyesRunInput,
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  eyes_result: {
    description: 'Read a stored eyes_run result: status and header, paged lines, grep, check report; or cancel a running job.',
    inputSchema: eyesResultInput,
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  eyes_stats: {
    description: 'Spend and usage today and all-time, OpenRouter key status; models: true adds the model table.',
    inputSchema: eyesStatsInput,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
};
