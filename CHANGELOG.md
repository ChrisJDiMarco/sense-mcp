# Changelog

All notable changes to sense-mcp will be documented in this file.

This project follows semantic versioning while it is pre-1.0: minor versions may
add or refine capabilities, and patch versions are reserved for compatible fixes.

## Unreleased

### Changed

- Hardened relevance routing to require current/deictic screen references before
  recommending screenshots.
- Tightened time-pressure and focus-state matching to avoid broad keywords such
  as bare `quick` and unrelated `state`.
- Changed default routing for unrelated prompts to `no_local_context_needed`.

### Added

- `sense-mcp settings --open` as a clearer alias for the local settings panel,
  plus first-run and doctor guidance that points users to it.
- Context broker metadata on `get_relevant_context`: expected value, token
  budget, plan-only behavior, included/excluded context, and external connector
  hints.
- ContextFrame `situation` card with compact summary, evidence, unknowns, risks,
  recommendations, and recent semantic changes.
- In-memory semantic timeline for short-term local continuity without raw
  titles, pixels, audio, or file contents.
- Metadata-only local privacy ledger plus `sense-mcp ledger` and panel display.
- Adversarial routing fixtures for known false positives.
- Prompt-pack routing expectations and `npm run eval:prompt-pack`.
- Recorded router benchmark result for the 2026-06-15 prompt pack run.
- Capability diagnostics for Calendar, mic level, Focus mode, and ambient light.
- ContextFrame `privacy.capability_details` for denied or unavailable sensors.
- Calendar connector fallback guidance for clients that have direct account
  calendar connections.

### Fixed

- Mic level sampling now prefers a real microphone input over virtual audio
  devices when `SENSE_MIC_DEVICE_INDEX` is unset.
- Calendar timeouts now surface as diagnostics instead of silent missing
  schedule context.
- Ledger reason redaction covers emails, URLs, long numbers/codes, and common
  secret keywords.

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
