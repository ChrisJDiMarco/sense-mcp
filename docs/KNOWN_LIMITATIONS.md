# Known Limitations

Sense is a public preview and is intentionally conservative.

## Platform

- macOS is the primary supported platform today.
- Linux and Windows are not first-class yet.
- Sensors degrade gracefully when an OS API or permission is unavailable.

## Permissions

- Camera, screen, microphone, Accessibility, Automation, and Calendar
  permissions are controlled by macOS and by the MCP client process.
- After changing permissions or environment variables, restart the MCP client.
- `sense-mcp doctor` can identify common setup problems, but it cannot grant
  OS permissions by itself.

## Media

- Camera and screen snapshots are explicit tools, not background sensors.
- The AI client still has to inspect the returned image content or `snapshot_path`
  before answering visual questions.
- Snapshot files live in a private temp directory and are cleaned up
  opportunistically on later snapshot calls.

## Context

- Active-window labels are semantic classifications, not a promise that Sense
  understood the full app content.
- Calendar event labels are generic by default.
- Workspace context is only available for configured roots.
- Quality metadata helps clients avoid overclaiming, but clients must still
  phrase uncertain context carefully.

