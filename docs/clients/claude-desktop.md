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
        "SENSE_CAMERA_SNAPSHOT": "1",
        "SENSE_SCREEN_SNAPSHOT": "1",
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
- Camera and screen snapshots are disabled unless the env vars are set.
- Claude still needs to call the snapshot tool and inspect the returned image.
- Use the Sense panel from a terminal if you want to toggle capabilities:

```bash
sense-mcp ledger
sense-mcp panel --open
```
