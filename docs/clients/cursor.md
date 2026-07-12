# Cursor Setup

Cursor supports MCP configuration through its own settings surface. Use Sense as
a standard local MCP server.

## Server

```bash
node /absolute/path/to/sense-mcp/dist/index.js
```

## Conservative setup

Start conservative:

```bash
SENSE_WORKSPACE_ROOTS=/absolute/path/to/workspace
```

Enable explicit media in central policy only when you want the model to answer
current visual questions:

```bash
sense-mcp enable camera
sense-mcp enable screen
```

## Generate a Config Shape

Cursor config formats can change, so use this command to generate the command,
args, and env values to copy into the current Cursor MCP settings UI:

```bash
node dist/index.js init --client claude-desktop --profile developer --workspace /absolute/path/to/workspace
```

The generated JSON is not Cursor-specific, but the server shape is the same:
`command`, `args`, and optional `env`.

Client guidance should start with `get_relevant_context` and honor
`context_plan.plan_only` so ordinary prompts do not spend local context.
Use `take_window_snapshot` for one app window and reserve
`take_full_screen_snapshot` for an explicit main-display request. Media capture
requires local allow-once consent.
