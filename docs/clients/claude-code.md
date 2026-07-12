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

## Recommended policy

Workspace roots remain an MCP client environment setting:

```bash
SENSE_WORKSPACE_ROOTS=/absolute/path/to/workspace
```

Enable app-window capture from a terminal after Sense is installed:

```bash
sense-mcp enable screen
```

Add camera only if you want appearance or room checks:

```bash
sense-mcp enable camera
```

## Verification

```bash
node dist/index.js doctor
node dist/index.js ledger
node dist/index.js settings --open
```

When prompting Claude Code, start with `get_relevant_context`. If
`context_plan.plan_only` is true, answer normally without pulling a ContextFrame.
Use `take_window_snapshot` for an app window. `take_screen_snapshot` is a
deprecated window-only alias; full-screen capture is separate. Every media call
requires local allow-once consent.
