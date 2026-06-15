# Cursor Setup

Cursor supports MCP configuration through its own settings surface. Use Sense as
a standard local MCP server.

## Server

```bash
node /absolute/path/to/sense-mcp/dist/index.js
```

## Env

Start conservative:

```bash
SENSE_WORKSPACE_ROOTS=/absolute/path/to/workspace
```

Opt into explicit media only when you want the model to answer current visual
questions:

```bash
SENSE_CAMERA_SNAPSHOT=1
SENSE_SCREEN_SNAPSHOT=1
```

## Generate a Config Shape

Cursor config formats can change, so use this command to generate the command,
args, and env values to copy into the current Cursor MCP settings UI:

```bash
node dist/index.js init --client claude-desktop --profile developer --workspace /absolute/path/to/workspace
```

The generated JSON is not Cursor-specific, but the server shape is the same:
`command`, `args`, and optional `env`.

