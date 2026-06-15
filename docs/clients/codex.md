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
SENSE_CAMERA_SNAPSHOT = "1"
SENSE_SCREEN_SNAPSHOT = "1"
SENSE_WORKSPACE_ROOTS = "/absolute/path/to/workspace"
```

Restart Codex after editing this file.

## Suggested Codex Guidance

Add this to your Codex guidance if your client does not naturally discover
Sense:

```text
Use Sense when local context would materially improve the answer. Start with
get_relevant_context for ambiguous requests. For visual appearance prompts, use
take_camera_snapshot and inspect snapshot_path before answering. For visible
screen/UI/debug prompts, use take_screen_snapshot and inspect snapshot_path
before answering. Do not use camera or screen tools for ordinary writing,
planning, or coding prompts.
```

## Troubleshooting

```bash
sense-mcp status
sense-mcp doctor
sense-mcp panel --open
```

Common fixes:

- Restart Codex after config changes.
- Grant Camera permission to the app process that runs the MCP server.
- Grant Screen Recording permission for screen snapshots.
- Install `ffmpeg` with `brew install ffmpeg`.

