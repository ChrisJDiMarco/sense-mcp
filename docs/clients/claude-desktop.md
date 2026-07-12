# Claude Desktop Setup

Claude Desktop uses JSON MCP config.

## Generate Config

```bash
npm install
npm run build
node dist/index.js init --client claude-desktop --profile visual --entry /absolute/path/to/sense-mcp/dist/index.js
```

Merge the printed JSON into `claude_desktop_config.json`.

## Manual Config

```json
{
  "mcpServers": {
    "sense": {
      "command": "node",
      "args": ["/absolute/path/to/sense-mcp/dist/index.js"],
      "env": {
        "SENSE_WORKSPACE_ROOTS": "/absolute/path/to/workspace"
      }
    }
  }
}
```

Restart Claude Desktop after editing config.

## Notes

- Start with `get_relevant_context`; if `context_plan.plan_only` is true, answer
  normally without fetching a ContextFrame.
- Camera, app-window, and full-screen snapshots are disabled until central
  policy enables the exact capability.
- Claude still needs to call the snapshot tool and inspect the returned image.
- Every media call shows a local allow-once confirmation. Use
  `take_window_snapshot` by default; `take_screen_snapshot` is its deprecated
  window-only alias.
Use the Sense panel or CLI from a terminal to inspect and change policy:

```bash
sense-mcp ledger
sense-mcp settings --open
sense-mcp enable screen
```
