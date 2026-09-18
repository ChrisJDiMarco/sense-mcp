# Changelog

All notable changes to sense-mcp will be documented in this file.

This project follows semantic versioning while it is pre-1.0: minor versions may
add or refine capabilities, and patch versions are reserved for compatible fixes.

## Unreleased

### Breaking changes

- **`max_tokens` now has a single, higher floor and a closed accepted range.**
  Every context tool and `get_relevant_context` accept `320` to `8192`. The
  previous floors were `96` for the context tools and `160` for the router, and
  the previous ceiling was `4096`, so calls that were legal before — anything
  below `320` — now fail schema validation. `320` is the smallest budget that
  returns a domain body rather than a bare envelope; `8192` is the largest
  budget the server will ever suggest retrying at, so a suggestion is always a
  legal input.
- **A budget shortfall is no longer an error.** A response that fits its budget
  but could not carry every requested domain returns `ok: true` with the context
  it has, `context_satisfied: false`, and a new `context_omitted` object naming
  the omitted domains, the reason, and a `suggested_max_tokens` that returns the
  complete response. `ok: false` with `context_budget_too_small` is now reserved
  for a budget that cannot carry any response at all, and that error is marked
  `retryable` only when a budget within the accepted range was measured to work. Clients that branched on
  that error to detect truncation will now read a partial response as a complete
  one unless they check `context_satisfied`.
- **`context_satisfied` has a defined meaning.** It means "every requested
  domain that has data is present in this response", and it is measured against
  the frame the response was built from rather than asserted by the caller.
- **`context_omitted` on `get_relevant_context` changed shape**, from a string to
  the same `{ domains, reason, suggested_max_tokens? }` object the context tools
  return.
- **Default projection budgets rose substantially.** Defaults are now `1150`
  compact, `1500` brief, `2800` focused, `5600` debug, `800` diff, and `2800` for
  `get_relevant_context`. Each is the measured cost of that projection's
  complete, untruncated output over a realistically full frame plus roughly 40%
  headroom, so a stock call is no longer silently truncated. This is a real cost
  decision: measured on `docs/evals/real-frame-fixture.json`, a stock
  `get_context_frame` now returns 2,211 estimated tokens against an old ceiling
  of 280, `get_screen_context` 1,020 against 180, and `get_relevant_context`
  1,958 against 480. Callers that want the old footprint must pass `max_tokens`
  explicitly and read `context_omitted` to see what it costs them.
- **Tool listing order changed.** `get_relevant_context` is now the first tool a
  client sees, because clients weight tool order and the routing discipline the
  server instructions describe only holds if the planning tool comes before the
  raw getters.
- **The package no longer declares `main` or `types`.** `sense-mcp` is a binary,
  not a library: importing it bound an MCP stdio transport to the importer's
  stdout. A minimal `exports` map replaces them, and `"os": ["darwin"]` is now
  declared because the `0700`/`0600` private-storage guarantees are no-ops off
  macOS.

### Protocol and dependencies

- Moved from MCP SDK v1 (`@modelcontextprotocol/sdk`) to v2
  (`@modelcontextprotocol/server`, with `@modelcontextprotocol/client` for
  tests and the smoke check), and from Zod 3 to Zod 4.
- **Fixed the advertised JSON Schema dialect.** Tool input and output schemas
  now advertise `https://json-schema.org/draft/2020-12/schema`. Under the
  previous SDK and Zod 3 they were converted through `zod-to-json-schema` at its
  default target and advertised draft-07, which a client that validates tool
  arguments against the advertised dialect is entitled to reject. A test asserts
  the dialect on all 11 tools.
- Rewrote the server instructions sent in the initialize result to describe the
  partial-response contract instead of the old retry-on-error path.
  `docs/PROMPTING.md` quotes the constant verbatim and a test enforces it, so
  the documented contract and the wire contract cannot drift.

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
- The idle sensor scopes its `ioreg` read to the `IOHIDSystem` entry (`-r -d 1`).
  The unrestricted `ioreg -c IOHIDSystem` dump walks the whole registry, overran
  the exec buffer on a normal Mac, and cost the sensor every sample, so presence
  and input cadence were permanently absent.
- The Bluetooth device sensor reads both `system_profiler SPBluetoothDataType`
  shapes: the `device_connected` / `device_not_connected` grouping on Ventura and
  later, and the flat `device_title` list with per-device `device_isconnected` on
  Monterey and earlier.
- The location sensor distinguishes the causes `networksetup` reports
  identically. Wi-Fi off, a non-Wi-Fi interface, and an SSID withheld pending
  Location Services now produce separate diagnostics and fix hints instead of one
  indistinguishable absent-location result. The Wi-Fi power probe reads the exit
  status as well as both streams, because `-getairportpower` prints to stdout and
  then exits non-zero.
- The active-window sensor withholds a raw window title outright when its own
  classifier rates the title medium or high sensitivity, instead of emitting a
  redacted one. Redaction strips emails, URLs and long digit runs, which helps
  only when the sensitive part is a substring; in an email subject, a Messages
  thread name or a Slack DM title the sensitive part is the whole title. Those
  now report `title_withheld: "sensitivity"`.
- The broker resolves the Sense entry point from its own module location rather
  than `process.argv[1]`, which is only the Sense entry when Sense is invoked
  directly and not under a launcher shim, a symlinked wrapper, or an embedding
  host.
- Broker socket establishment and the opening `ping` handshake have separate
  bounded timeouts, so a wedged peer that accepts a connection and stays silent
  no longer holds every adapter for a full request timeout before the
  recover/elect path runs. Owner-record staleness checks tolerate wall-clock
  drift rather than treating a live owner as pre-boot.
- `doctor` resolves helper binaries the way `which` does, requiring a regular
  file rather than only the execute bit, so a directory named `ffmpeg` on the
  PATH is no longer reported as a working helper. It measures the PATH the
  server will actually be started with instead of assuming its own, and warns
  rather than passing when a helper resolves for `doctor` but would be invisible
  to a server spawned by a GUI `.app` under launchd's stripped PATH. TCC checks
  attribute a grant to the outermost `.app`, walking past non-grantable nested
  helper bundles, and read screen-capture and camera authorization without ever
  prompting or capturing.
- The panel no longer writes a Codex `config.toml` for clients that never read
  one; it returns the equivalent env-block instruction instead, and honours a
  Codex-config `SENSE_SNAPSHOT_DIR` override when resolving the snapshot
  directory.

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
