# Hook for Claude Code

An optional Claude Code hook that stops the agent from reading large text files whole
and points it at cheap-eyes instead. Read this if your agent keeps pulling big files
into its own context.

## What it does

`hooks/block-large-reads.js` is a `PreToolUse` hook: a whole-file `Read` of a text file
larger than `hook.max_bytes` (30 KB) is denied with a pointer to `eyes_run`, Grep or a
ranged read. Ranged reads, images, PDFs and notebooks pass; any hook error lets the
call through. It covers Claude Code's `Read` tool only: shell commands are not
intercepted.

## Installing it

Install cheap-eyes globally, find the path with `npm root -g`, and register the hook in
`~/.claude/settings.json` (all projects) or `.claude/settings.json` (one project):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          { "type": "command", "command": "node /usr/lib/node_modules/cheap-eyes/hooks/block-large-reads.js" }
        ]
      }
    ]
  }
}
```

The hook reads `hook.max_bytes` from the same config file as the server.
