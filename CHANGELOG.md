# Changelog

All notable changes to sense-mcp will be documented in this file.

This project follows semantic versioning while it is pre-1.0: minor versions may
add or refine capabilities, and patch versions are reserved for compatible fixes.

## [0.1.0] - 2026-06-15

Initial public preview.

### Added

- MCP server exposing local, privacy-first situational context.
- ContextFrame `0.2` envelope with privacy capability status and quality metadata.
- Relevance router that recommends the narrowest Sense tool for a user request.
- Explicit opt-in camera and screen snapshot tools that return MCP image content and a private `snapshot_path`.
- macOS sensors for active window class, idle state, time, battery, devices, workspace, calendar, location, media, ambient light, mic level, focus mode, camera availability, and local semantic bridges.
- Local control panel for capability toggles, health state, recent snapshot metadata, and recent explicit tool activity.
- `sense-mcp init`, `status`, `permissions`, `doctor`, `panel`, `enable`, and `disable` CLI commands.
- Routing eval fixtures and a prompt-based eval pack.
- Open-source project docs: privacy contract, client setup guides, roadmap, release checklist, security policy, contributing guide, and GitHub issue templates.

### Privacy Notes

- Sensors emit semantic state by default, not raw private content.
- Camera and screen capture are separate explicit tools, disabled unless opted in.
- Snapshot artifacts are temporary local files and are not persisted by Sense beyond the configured temp directory behavior.
- The panel derives its recent tool activity from temporary snapshot files instead of writing a separate audit database.

