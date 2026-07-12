# Codex Setup

Sense works well with Codex because Codex can use MCP tools and local file
inspection together.

## Recommended Setup

From the Sense repo:

```bash
npm install
npm run build
node dist/index.js init --write --profile visual --workspace /absolute/path/to/workspace
```

Then restart Codex and run:

```bash
sense-mcp doctor
```

If you are developing from source and do not have the `sense-mcp` bin on your
PATH yet, use:

```bash
node dist/index.js doctor
```

## Manual Config

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.sense]
command = "node"
args = ["/absolute/path/to/sense-mcp/dist/index.js"]
startup_timeout_sec = 20

[mcp_servers.sense.env]
SENSE_WORKSPACE_ROOTS = "/absolute/path/to/workspace"
```

Environment flags remain migration fallbacks. Prefer central policy after the
first start:

```bash
sense-mcp enable camera
sense-mcp enable screen
```

Policy changes hot-reload in the shared broker. Restart Codex only for MCP
config or macOS host-permission changes.

## Suggested Codex Guidance

Add this to your Codex guidance if your client does not naturally discover
Sense:

```text
Use Sense when local context would materially improve the answer. Start with
get_relevant_context for ambiguous requests. If context_plan.plan_only is true
or expected_value is none, answer normally without fetching a ContextFrame. For
visual appearance prompts, use take_camera_snapshot and inspect snapshot_path
before answering. For local Mac app visual QA, prefer CoreGraphics window-id
capture with screencapture so focus is not interrupted. For visible
screen/UI/debug prompts, use take_window_snapshot for one app window, then
inspect snapshot_path before answering. take_screen_snapshot is a deprecated
window-only alias. Use take_full_screen_snapshot only for an explicit request
for the main display. Do not use camera or screen tools for ordinary writing,
planning, or coding prompts. Expect a local allow-once confirmation before each
capture.
```

## Troubleshooting

```bash
sense-mcp status
sense-mcp doctor
sense-mcp ledger
sense-mcp settings --open
```

Common fixes:

- Restart Codex after MCP config or macOS host-permission changes. Central Sense
  policy hot-reloads.
- Grant Camera permission to the app process that runs the MCP server.
- Grant Screen Recording permission for screen snapshots.
- Install `ffmpeg` with `brew install ffmpeg`.
- Install optional `icalBuddy` and run `sense-mcp enable calendar` for headless
  local schedule timing. Sense never launches Calendar.app. Use a direct
  Calendar connector for account-backed data.
