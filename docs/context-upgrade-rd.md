# Sense MCP Context Upgrade RD

## Goal

Expand `sense-mcp` from Tier-1 screen/presence/time awareness into a broader local context layer that can expose useful semantic state to Codex while preserving the original invariants: local-only, ephemeral, pull-based, and privacy-tiered.

## Requirements

- Add local semantic sensors for power, display/device setup, media playback, location class, calendar pressure, ambient light, workspace/git state, and optional external health/weather bridges.
- Add microphone level as an opt-in Tier-2 semantic sensor that emits only a noise class/level, never audio content.
- Add camera availability plus an explicit Tier-3 `take_camera_snapshot` tool that returns an in-memory image only when called for a visual request.
- Do not persist frames, camera snapshots, audio samples, or raw sensor outputs.
- Do not expose raw calendar titles, wifi names, media titles, device names, or window titles by default.
- Sensors must fail silent and degrade to missing fields or unavailable/denied capabilities.
- Keep the existing four context domains unless a new domain is truly required.

## Non-Goals

- No continuous camera analysis or facial/emotion recognition in this pass.
- No off-device network calls from sensors.
- No cloud calendar, wearable, or weather API auth setup inside the MCP server.
- No proactive actions based on camera or microphone data.

## Phase 2 Requirements

- Add `get_relevant_context({ user_request })` so clients can ask Sense which domains and explicit tools matter for a prompt.
- Add explicit `take_screen_snapshot({ reason, mode })` for current-screen visual/debug requests.
- Add vision/task modes to snapshot metadata so clients can answer with the right lens (`appearance_check`, `screen_debug`, `lighting_check`, etc.).
- Expand task-state intelligence with project type, package manager, available scripts, dirty-count severity, and rough work mode.
- Expand schedule intelligence with usable work window and meeting/prep hints.
- Add a lightweight CLI control surface: `sense-mcp status`, `sense-mcp permissions`, `sense-mcp enable <capability>`, `sense-mcp disable <capability>`.
- Create an eval document with prompts and scoring criteria for testing with and without Sense.

## Phase 3 Requirements

- Add a local status/control panel command: `sense-mcp panel`.
- The panel must bind to localhost only.
- The panel must show explicit permission state for camera, screen, mic, raw titles, and workspace context.
- The panel must show recent explicit snapshot metadata without opening or embedding private image pixels.
- The panel must let the user toggle supported capabilities by editing the `sense` env block in `~/.codex/config.toml`.
- Config-changing panel requests must require an ephemeral panel token and reject non-localhost hosts.
- The panel should clearly show that Codex must be restarted after permission changes.

## Consent Defaults

- Tier 0/1 local basics remain on by default.
- Calendar/location/media/power/device/ambient/workspace semantic state can run locally and only emits classified state.
- `SENSE_MIC_LEVEL=1` enables microphone level sampling.
- `SENSE_CAMERA_SNAPSHOT=1` enables the explicit snapshot tool.
- Raw titles/details stay opt-in and off by default.
