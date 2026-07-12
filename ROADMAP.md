# Roadmap

Sense is a local-first context broker for MCP clients. It should improve an
answer with the smallest useful signal and make sensitive acquisition visible
to the person at the Mac.

## Shipped in the v1 hardening pass

- One per-user broker with private election, reconnect, stale-socket checks,
  idle shutdown, and one sensor cadence across MCP clients.
- Completion-based sensor scheduling, cancellation, availability rechecks,
  backoff, jitter, domain refresh, and per-field expiry.
- Central strict-default policy with hot reload and CLI toggles.
- Enforced output byte ceilings with compact, brief, focused, debug, and diff
  projections.
- Window-only capture by default, separate full-screen capture, and exact
  local one-use consent before every media acquisition.
- Headless optional Calendar through `icalBuddy`, with no Calendar.app launch.
- Private atomic storage for policy, consent, ledger, snapshots, broker state,
  and iPhone context.
- AES-256-GCM iPhone LAN transport and Keychain-backed pairing.
- Current MCP tool registration, schemas, structured output, annotations, and
  protocol-level tests.

## Near term

- Better macOS permission diagnostics for the exact host process and System
  Settings pane.
- Paired baseline-versus-Sense response evaluations that measure answer lift,
  latency, and token cost.
- More broker stress tests across client crashes, sleep/wake, and long-running
  sessions.
- First stable npm release and upgrade notes for pre-hardening installs.

## Later

- Linux and Windows sensor adapters.
- A stable `context-frame` schema package.
- Community sensor packs with a security and privacy review checklist.
- Local enum-only classifiers that never retain source media.

## Non-goals

- Background camera monitoring.
- Microphone transcription.
- Reading messages, credentials, or unrelated screen content.
- Cloud storage of ContextFrames.
- Persistent behavioral profiling.
