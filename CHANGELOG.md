# Changelog

All notable changes to sense-mcp will be documented in this file.

This project follows semantic versioning while it is pre-1.0: minor versions may
add or refine capabilities, and patch versions are reserved for compatible fixes.

## Unreleased

### Security and runtime hardening

- Added one per-user broker so Codex, Claude, and other MCP adapters share one
  scheduler and state store. Adapters reconnect and elect a replacement after
  broker loss.
- Added non-overlapping completion-based sensor scheduling, cancellation,
  availability rechecks, bounded backoff, jitter, domain refresh, and
  field-level expiry.
- Added a private central policy file with strict defaults, hot reload, CLI
  toggles, and per-key environment migration fallbacks.
- Added app-window capture as the default screen tool, a separate full-screen
  tool, and a deprecated window-only compatibility alias for
  `take_screen_snapshot`.
- Added local allow-once consent receipts bound to media kind, scope, target,
  normalized reason, and expiry. Every camera, window, and full-screen receipt
  is single-use and consumed immediately before acquisition. Policy is checked
  before and after acquisition and after private-file finalization. Window
  receipts bind a validated owner app, process, on-screen window id, and bounds.
- Replaced Calendar AppleScript with optional headless `icalBuddy`; Sense no
  longer launches Calendar.app.
- Enforced complete-response byte ceilings and added compact, brief, focused,
  debug, and diff context projections with conservative token estimates.
- Moved policy, consent, ledger, snapshots, broker metadata, and iPhone context
  to bounded private atomic storage with symlink rejection.
- Replaced iPhone Bearer-token transport with AES-256-GCM request and response
  envelopes, replay/skew/body limits, Keychain secret storage, and a
  secret-bearing clipboard pairing handoff. Removed plaintext loopback fallback
  and moved local check-in history from `UserDefaults` to bounded, protected,
  expiring file storage.
- Replaced the localhost panel's reusable launch URL with a private `0600`
  launcher, one-use request-body bootstrap, and distinct HttpOnly session;
  authenticated every panel API and removed the fixed-header plaintext iPhone
  endpoint.
- Stopped storing caller-controlled ledger reasons and errors as plaintext.
  Entries now keep fixed summaries/classes plus SHA-256 hashes for correlation,
  and migrate older plaintext rows under the ledger lock.
- Updated MCP tools to current SDK registration, input/output schemas,
  annotations, structured content, and machine-readable errors.
- Made `doctor` enforce Node 22, validate enabled `ffmpeg`/`icalBuddy` features,
  probe live Calendar diagnostics, and discover secured panels on custom ports
  through private runtime receipts.
- Moved iOS shortcut drafts out of `UserDefaults` into bounded, atomic,
  complete-file-protected storage and aligned LAN pairing address selection with
  the iOS local-address validator.

### Changed

- Refreshed the GitHub README with a stronger project narrative, clearer
  onboarding flow, and a generated cinematic header image.
- Hardened relevance routing to require current/deictic screen references before
  recommending screenshots.
- Tightened time-pressure and focus-state matching to avoid broad keywords such
  as bare `quick` and unrelated `state`.
- Changed default routing for unrelated prompts to `no_local_context_needed`.

### Added

- GitHub Actions CI for Node 22 and Node 24.
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
- iOS companion check-ins with expiring semantic self-report payloads, optional
  device/motion/noise/health summaries, bridge receipts, and panel display.
- `sense-mcp settings --lan --open` for explicit bridge-only physical iPhone
  sync on a trusted network.

### Fixed

- Ignored generated Xcode build/user-state artifacts so the iOS companion source
  can be shared without local build noise.
- Hardened iPhone bridge writes with a companion header and documented that
  physical-device sync requires the explicitly enabled encrypted LAN bridge on
  a trusted network.
- Kept LAN bridge mode separate from the localhost settings panel.
- Mic level sampling now prefers a real microphone input over virtual audio
  devices when `SENSE_MIC_DEVICE_INDEX` is unset.
- Calendar timeouts now surface as diagnostics instead of silent missing
  schedule context.
- Ledger writes use fixed reason summaries and error classes instead of
  caller-controlled plaintext.

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
