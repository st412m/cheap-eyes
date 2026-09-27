// MCP server factory. One instance per connection (stdio) or per request (HTTP).
import { McpServer } from '@modelcontextprotocol/server';
import { InputError } from './errors.js';
import { eyesRun } from './run.js';
import { eyesResult } from './result-tool.js';
import { eyesStats } from './stats.js';
import { TOOL_DEFS } from './tools.js';
import { VERSION } from './version.js';

function text(t, isError = false) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: t }] };
}

function notImplemented(name) {
  return async () => text(`${name}: not implemented in this build yet`, true);
}

// Refusals go back as tool errors; anything else is logged and reported briefly.
function guarded(name, fn) {
  return async (args, extra, ctx) => {
    try {
      return await fn(args, extra, ctx);
    } catch (e) {
      if (e instanceof InputError) return text(`${name}: ${e.message}`, true);
      console.error(`cheap-eyes: ${name} failed: ${e?.stack ?? e}`);
      return text(`${name}: internal error: ${e?.message ?? e}`, true);
    }
  };
}

export const DEFAULT_HANDLERS = {
  eyes_run: async (args, _extra, ctx) => text((await eyesRun(args, ctx)).header),
  eyes_result: async (args, _extra, ctx) => text(await eyesResult(args, ctx)),
  eyes_stats: async (args, _extra, ctx) => text(await eyesStats(args, ctx)),
};

// `ctx` carries the loaded config and resolved dirs.
export function createServer(ctx, handlers = DEFAULT_HANDLERS) {
  const server = new McpServer({ name: 'cheap-eyes', version: VERSION }, { capabilities: { tools: {} } });
  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    const handler = guarded(name, handlers[name] ?? notImplemented(name));
    server.registerTool(name, def, (args, extra) => handler(args, extra, ctx));
  }
  return server;
}
