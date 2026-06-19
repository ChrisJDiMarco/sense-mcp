# Privacy Model

`sense-mcp` is designed to give an AI client situational awareness without
turning the user's machine into a surveillance feed.

The core promise:

1. Local only.
2. Pull based.
3. Ephemeral.
4. Semantic by default.
5. Explicit opt-in for sensitive capabilities.

## What Sense Sends to the AI

The normal tool output is a ContextFrame: a small JSON object with semantic
fields like:

- `activity_class: "coding"`
- `presence: "active"`
- `time_pressure: "moderate"`
- `noise_class: "quiet"`
- `power_source: "ac_power"`

These fields are intended to help the AI choose the right level of help. They
are not a transcript, recording, or screenshot.

Each ContextFrame can also include `quality` metadata: which sensor produced a
field, whether it was observed/classified/derived, how stale it is, and whether
screen activity looks stable or recently changed. This helps clients avoid
overclaiming inferred context.

Frames may also include a compact `situation` card. This is a lossy summary of
the same semantic frame: summary, evidence, unknowns, risks, recommendations,
and recent safe changes. It is designed to reduce token use, not expose more
private data.

## What Sense Does Not Send by Default

By default, Sense does not send:

- camera images
- screenshots
- audio content
- keystrokes
- message contents
- browser page text
- file contents
- Wi-Fi SSIDs
- calendar event titles
- raw window titles
- track, artist, podcast, or episode names

## Explicit Snapshot Tools

`take_camera_snapshot` and `take_screen_snapshot` are separate MCP tools.

They are disabled unless the user opts in with:

```bash
SENSE_CAMERA_SNAPSHOT=1
SENSE_SCREEN_SNAPSHOT=1
```

Even when enabled, they should only be called when the current user request is
visual, such as:

- "how does my hair look?"
- "is my lighting okay?"
- "what is this error on my screen?"
- "review this UI"

They should not be called for ordinary writing, coding, planning, or background
context.

## Temporary Snapshot Files

Some MCP clients do not forward image blocks to the model. To make explicit
visual requests work in those clients, Sense also writes a private temporary PNG
and returns `snapshot_path`.

Snapshot files are:

- created in a private temp directory
- written with private file permissions
- cleaned up on later snapshot calls
- not part of the ContextFrame
- not written to project directories unless the user explicitly asks for that

## Control Panel

`sense-mcp panel` starts a local control panel.

Security properties:

- binds to `127.0.0.1`
- rejects non-local Host headers
- uses an ephemeral per-process token for permission changes
- edits only allowlisted Sense environment variables
- shows health and recent explicit snapshot metadata
- shows a metadata-only privacy ledger for recent Sense tool calls
- shows a restart notice because MCP clients usually read env at startup

## Privacy Ledger

Sense records a small local access ledger by default in the OS temp directory
(`SENSE_LEDGER_PATH` can override it). The ledger is metadata only. It helps the
user answer: what did Sense access, when, why, and did it capture media?

Ledger entries can include:

- tool name
- status
- reason, redacted and truncated
- context domains used
- expected context value and token budget
- connector hints such as `calendar_connector`
- local artifact paths for explicit snapshots

Ledger entries must not include:

- ContextFrame payloads
- screenshot or camera pixels
- audio samples or transcripts
- raw window titles
- message contents
- file contents

Set `SENSE_LEDGER_DISABLED=1` to disable ledger writes.

## Doctor Command

`sense-mcp doctor` performs local setup checks for Node, macOS support, ffmpeg,
Codex config, opt-in capabilities, workspace roots, panel reachability, and live
sensor diagnostics. It can explain cases such as mic disabled by env, Focus mode
bridge missing, Calendar query timeout, or ambient light not exposed by macOS. It
does not inspect private content.

## Capability Diagnostics

ContextFrames may include `privacy.capability_details` for capabilities that are
denied or unavailable. These diagnostics explain setup state; they do not expose
raw private data.

Examples:

- `microphone_level`: `disabled_by_env`
- `focus_mode`: `missing_focus_bridge`
- `calendar`: `calendar_query_timeout`
- `ambient_light`: `ambient_light_not_exposed`

## Optional Capabilities

| Capability | Default | Data class |
|---|---:|---|
| Camera snapshot | Off | explicit image snapshot |
| Screen snapshot | Off | explicit screenshot |
| Mic level | Off | one-second volume level, no audio content |
| Raw window titles | Off | redacted active-window title |
| Workspace roots | Off unless configured | git branch and dirty count |

## Guidance for MCP Clients

Clients should:

- call `get_relevant_context` before deciding whether media is needed
- honor `context_plan.expected_value`, `context_plan.plan_only`, and the token budget
- call the narrowest tool that answers the request
- honor `minimum_tool`, `avoided_tools`, `fallbacks`, and `privacy_notes`
- use `privacy.capability_details` to explain missing context
- inspect `snapshot_path` before answering visual questions
- state uncertainty for classified fields
- avoid proactive camera or screen capture
- never treat inferred context as ground truth

## Known Tradeoffs

Sense is a local helper, not a sandbox. A compromised local MCP client can misuse
any tool the user grants it. The privacy model depends on the client respecting
tool descriptions and the user keeping sensitive capabilities disabled unless
they are needed.
