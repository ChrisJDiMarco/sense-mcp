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
- Calendar, Focus, mic level, and ambient light now include diagnostics when
  they do not yield, but the user may still need to grant macOS permissions or
  configure a bridge.

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
- Calendar timing depends on local macOS Calendar automation. If Calendar.app
  queries hang, Sense reports `calendar_query_timeout` instead of guessing.
- If the AI client has a direct Google Calendar or calendar connector, prefer
  that connector for account calendar data. Sense's local Calendar sensor is a
  fallback local signal, not a replacement for connected account APIs.
- Focus mode requires either `SENSE_FOCUS_MODE` or a Shortcut named
  `Sense Current Focus` that returns text.
- Ambient light depends on macOS exposing `AppleLMUController`; many setups do
  not expose it, so Sense falls back to time/daylight context.
- Workspace context is only available for configured roots.
- Quality metadata helps clients avoid overclaiming, but clients must still
  phrase uncertain context carefully.
