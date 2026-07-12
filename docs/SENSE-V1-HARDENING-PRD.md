# Sense v1 hardening PRD

Status: implemented and verified on 2026-07-11.

## Problem

Before this pass, each MCP connection started a complete polling stack.
Multi-agent clients amplified OS probes, consumed unnecessary memory, raced on
shared files, and could launch Calendar.app. Several privacy promises depended
on client behavior instead of server-enforced consent, output limits, or
storage boundaries.

## Success criteria

1. Multiple Codex and Claude MCP connections share one sensor cadence and one coherent broker-owned state store.
2. Calendar, camera enumeration, raw-title inspection, location, and other sensitive or intrusive probes do not run unless policy and demand require them. Calendar queries do not launch Calendar.app.
3. Sensor scheduling never overlaps a sensor with itself, supports cancellation, rechecks dynamic availability, and applies bounded backoff and jitter after failure.
4. The settings surface lists every sensor, distinguishes disabled, unavailable, permission-denied, no-signal, degraded, stale, and healthy states, and accurately explains collection, storage, and possible model-provider egress.
5. Camera and screen capture require a local, short-lived consent receipt. Window-only capture is the default screen path; full-screen capture is a separate higher-risk action.
6. Context output modes enforce useful size limits. MCP tools return structured output with schemas and annotations through the current SDK registration API.
7. Ledger, snapshot, policy, broker, and iPhone files use private permissions, bounded reads, atomic no-follow replacement, locking or single-writer ownership, and deterministic expiry cleanup.
8. iPhone pairing stores secrets in Keychain, rejects clock-skewed payloads, encrypts LAN payloads, and provides a low-friction pairing handoff.
9. Runtime, protocol, privacy, multi-client, packaging, and critical UI flows have automated coverage. Existing routing and privacy fixtures remain green.
10. The npm package excludes duplicate media and unrelated source payload while preserving the CLI, documentation needed by users, and release checks.

## Scope

- Shared per-user local broker with private Unix-domain socket and thin stdio MCP adapters.
- Demand-aware sensor registry and scheduler, including a headless Calendar implementation.
- Central sensor policy, live health telemetry, honest settings copy, and consent leases.
- Compact ContextFrame projections, context diffs, modern MCP tools/resources, schemas, and integration tests.
- Hardened ledger, temporary artifacts, iPhone context persistence, LAN transport, and iOS secret storage.
- Packaging, migration, documentation, doctor diagnostics, benchmarks, and release verification.

## Constraints

- Preserve stdio compatibility for Codex, Claude Desktop, and Claude Code.
- Preserve the existing uncommitted window-capture guidance changes.
- No cloud context store, behavioral profile, background camera, microphone transcription, or hidden media capture.
- Existing environment variables continue to work during migration, but strict policy defaults win when no explicit choice exists.
- Fail closed for sensitive capabilities; fail soft for ordinary semantic context.

## Implemented plan

1. Added acceptance tests for shared runtime, scheduling, policy defaults,
   consent, bounded output, storage, iPhone validation, and MCP schemas.
2. Implemented the shared broker and demand-aware scheduler.
3. Hardened sensors, media consent, storage, panel, and iPhone bridge.
4. Updated the MCP contract and compact output paths.
5. Updated migration, documentation, package contents, and release checks.
6. Ran unit, integration, routing, prompt, security, package, iOS, and
   multi-client verification.

## Release gates

- `npm run build`
- `npm test`
- `npm run eval:routing`
- `npm run eval:prompt-pack`
- `npm run audit:prod`
- Protocol-level MCP discovery/call tests
- Multi-client broker test proving one sensor cadence
- Package dry run with no duplicate large assets
- No Calendar.app launch from default or schedule-context paths
