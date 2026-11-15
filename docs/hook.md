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

```
npm install -g cheap-eyes
cheap-eyes hook install            # ~/.claude/settings.json: all projects
cheap-eyes hook install --project  # .claude/settings.json of the current folder
cheap-eyes hook remove [--project] # takes it out again
```

The command adds one `PreToolUse` entry for `Read` with the absolute path of this
installation's hook, keeps every other setting in the file, does nothing when the entry
is already there, and refuses a settings file that is not valid JSON. It refuses to run
from the npx cache, whose path changes: install cheap-eyes globally first.

### By hand

Find the path with `npm root -g` and register the hook in `~/.claude/settings.json`
(all projects) or `.claude/settings.json` (one project):

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
