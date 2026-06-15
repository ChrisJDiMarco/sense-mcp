# Claude Code Setup

Claude Code MCP configuration varies by installation, but the Sense server is
the same process:

```bash
node /absolute/path/to/sense-mcp/dist/index.js
```

## Generate a Starting Point

```bash
npm install
npm run build
node dist/index.js init --client claude-desktop --profile developer --workspace /absolute/path/to/workspace
```

Use the generated command, args, and env block in the MCP config surface your
Claude Code installation expects.

## Recommended Env

For code work, start with workspace and screen context:

```bash
SENSE_SCREEN_SNAPSHOT=1
SENSE_WORKSPACE_ROOTS=/absolute/path/to/workspace
```

Add camera only if you want appearance or room checks:

```bash
SENSE_CAMERA_SNAPSHOT=1
```

## Verification

```bash
node dist/index.js doctor
node dist/index.js panel --open
```

