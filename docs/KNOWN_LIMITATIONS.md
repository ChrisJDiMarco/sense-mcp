# Known limitations

## Platform and dependencies

- macOS is the primary platform. Linux and Windows sensor coverage is limited.
- Node.js 22 or newer is required.
- Camera and microphone-level features need `ffmpeg`.
- Local Calendar timing needs optional `icalBuddy`. When it is absent or policy
  is off, schedule context remains unavailable without launching Calendar.app.
- macOS still controls Camera, Screen Recording, Microphone, Accessibility, and
  related permissions. Sense can diagnose but cannot grant them.

## Context quality

- Semantic labels are classifications, not screen or document understanding.
- The situation card is lossy. Use field provenance and freshness when precision
  matters.
- Field TTLs prevent stale retention, but sensor availability and OS APIs can
  still leave a domain empty.
- `if_stale` and `force` refresh only sensors declared for the requested domain.
- Token estimates use a conservative byte ratio. The serialized byte ceiling is
  enforced; exact model tokenization can differ.
- Sense Calendar output contains coarse time windows only. Use a connected
  calendar service for account data, titles, attendees, or authoritative event
  content.

## Media

- Every capture requires an interactive local allow-once confirmation. Headless
  sessions therefore fail closed.
- Window capture is the default and does not activate the target app, but the
  selected window can still contain sensitive content.
- Full-screen capture is a separate higher-risk tool limited to the main
  display. It requires policy, `confirm_full_screen: true`, and local consent.
- `take_screen_snapshot` is retained for compatibility and is window-only.
- Temporary PNGs become eligible for bounded, opportunistic cleanup after two hours and may remain longer while Sense is idle.
- The MCP client must inspect returned image content or `snapshot_path`; Sense
  cannot guarantee that every client forwards image blocks to its model.

## Broker and policy

- The broker shuts down after the last adapter disconnects and the idle grace
  period passes. A later adapter starts a replacement.
- Central policy hot-reloads by file identity and modification time. OS-level
  permission changes may still require the host application to be restarted.
- Environment variables are migration fallbacks. Once a key exists in the
  policy file, the file value wins.

## Model egress

Sense does not make background cloud calls for sensor acquisition. MCP results
may still be sent to the model provider by the client. Sense cannot inspect or
enforce the provider's retention or training policy.

## iPhone companion

- The app is a companion, not an MCP server.
- Physical-device sync requires explicit LAN mode on a trusted network.
- LAN traffic is application-encrypted, but the listener still uses local HTTP;
  network observers can see endpoints, sizes, and timing.
- Pairing targets are limited to private, link-local, loopback, mDNS, or shared
  carrier-grade NAT (`100.64.0.0/10`) hosts.
- There is no unpaired or plaintext loopback fallback; even simulator/loopback
  use requires a valid pairing secret and AEAD.
- The bridge allows five minutes of clock skew. Large device clock errors are
  rejected.
- iOS keeps only 12 unexpired check-ins in a 256 KiB protected local file.
- Pairing uses a secret-bearing clipboard link; clipboard managers and
  same-user processes are part of the pairing threat model.

## Ledger

The bounded ledger stores local metadata, including tool names, fixed reason
summaries/hashes, and snapshot paths. It never stores caller reason/error text.
Disable it with `SENSE_LEDGER_DISABLED=1` if the remaining metadata is unwanted.
