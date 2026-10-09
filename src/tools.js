// Input schemas of the three tools. Every description is sent to the client in
// each session, so they stay short.
import { z } from 'zod';
import { refusedSuffix, refusedSuffixMessage } from './model-ids.js';

export const MODES = ['extract', 'draft', 'edits', 'grep', 'schema'];
// Modes that call a model (and have a default alias in the config).
export const MODEL_MODES = ['extract', 'draft', 'edits', 'schema'];

// YYYY-MM-DD_HHMMSS-<mode>-<6 hex>, UTC. Matched exactly; never used as a path.
export const RESULT_ID_RE = /^\d{4}-\d{2}-\d{2}_\d{6}-(?:extract|draft|edits|grep|schema)-[0-9a-f]{6}$/;

export const eyesRunInput = z.strictObject({
  task: z.string().min(1).optional().describe('What to look for or write (optional for grep and schema). Masked like file content.'),
  mode: z
    .enum(MODES)
    .describe('extract: verbatim lines; draft: markdown with refs; edits: JSON line edits (never applied); grep: matches, no model; schema: JSON fields with refs'),
  schema: z
    .union([z.record(z.string(), z.unknown()), z.string()])
    .optional()
    .describe('mode schema: {"field": "number — description", "list": [{...}]}; max 60 fields, depth 4'),
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
    .describe('Absolute paths or globs inside read roots, or http(s) URLs (fetched by the server). Range "#L100-L400" only with a single file'),
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
  max_tokens: z.number().int().positive().optional().describe('Output cap per chunk; default extract 16000, schema 8000, draft/edits 4096'),
  dry_run: z.boolean().optional().describe('Build and store the request, do not call the model'),
  async: z.boolean().optional().describe('Return the result id at once; poll eyes_result'),
});

export const eyesResultInput = z.strictObject({
  id: z.string().regex(RESULT_ID_RE, 'not a result id').describe('Result id from eyes_run'),
  offset: z.number().int().min(1).optional().describe('First result line (1-based)'),
  limit: z.number().int().min(1).max(200).optional().describe('Lines to return, max 200'),
  grep: z.string().min(1).optional().describe('JS regex over result lines'),
  check: z.union([z.boolean(), z.literal('all')]).optional().describe('Check report: true = items that are not ok; "all" = every item'),
  source: z.string().min(1).max(500).optional().describe('Page a stored source text instead (name as in the result); offset = its line number'),
  full: z.boolean().optional().describe('Do not clip lines over 400 chars'),
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

// All four hints on every tool, set explicitly (the MCP defaults are readOnly false,
// destructive true, idempotent false, openWorld true):
// - eyes_run writes results and exports (an export overwrite replaces only a file
//   this server wrote); every call is a new job and new spend; reaches OpenRouter and URLs.
// - eyes_result writes only through cancel (aborts a job, finished chunks are kept);
//   reading or cancelling again changes nothing more; local store only.
// - eyes_stats only reads; asks OpenRouter for the key status and model lists.
export const TOOL_DEFS = {
  eyes_run: {
    title: 'Run cheap reading job',
    description:
      'Hand reading by meaning over large text (logs, archives, long documents, web pages) to a cheap model; quotes and line refs come back checked against the source. For exact values, structure or files under ~30 KB use mode grep ($0) or your own file tools. Each call is a paid job within daily_budget_usd; full result via eyes_result.',
    inputSchema: eyesRunInput,
    annotations: { title: 'Run cheap reading job', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  eyes_result: {
    title: 'Read job result',
    description: 'Read an eyes_run result by the id from its header: pages, grep, check report, the source text to verify a quote; cancel: true aborts a running job. No model call, free.',
    inputSchema: eyesResultInput,
    annotations: { title: 'Read job result', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  eyes_stats: {
    title: 'Usage and models',
    description: 'Spend today and all-time, budget left, OpenRouter key limit; models: true adds the model table. Check it before a large job or when eyes_run hits the budget. Free.',
    inputSchema: eyesStatsInput,
    annotations: { title: 'Usage and models', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
};
