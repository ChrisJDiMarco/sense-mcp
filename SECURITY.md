# Security policy

## Supported versions

Sense is pre-1.0. Security fixes land on `main` and ship in the next release.

## Reporting a vulnerability

Use GitHub private vulnerability reporting or open a private security advisory.
Do not file a public issue. Include the affected version, platform, MCP client,
reproduction steps, and the data class involved.

## Security boundaries

- One per-user broker owns sensor cadence and in-memory state. MCP adapters use
  a private Unix socket and reconnect or elect a replacement after broker loss.
- Central policy defaults sensitive probes and raw fields off. Invalid policy
  storage fails closed.
- Calendar uses optional headless `icalBuddy` only when policy enables it. Sense
  never launches Calendar.app.
- Context responses have enforced serialized byte ceilings. Token counts are
  conservative estimates.
- Camera, app-window, and full-screen capture each require a matching local,
  short-lived, single-use consent receipt immediately before acquisition.
  Sense rechecks policy before and after acquisition and again after private-file
  finalization, discarding artifacts if policy changes. App-window consent also
  names and binds the validated on-screen owner app, process, and bounds.
- `take_window_snapshot` does not activate the target app. Full-screen capture
  is a separate tool. Deprecated `take_screen_snapshot` remains window-only.
- Private files use bounded reads, symlink rejection, modes `0700`/`0600`, and
  atomic replacement. Locks are not reaped while their recorded PID is alive.
- The settings panel binds to localhost. A private `0600` launcher posts a
  one-use bootstrap secret without putting it in a URL or process argument;
  the server exchanges it for a distinct HttpOnly, SameSite session and
  authenticates the HTML, status, and every API request. The plaintext
  fixed-header iPhone endpoint has been removed; companion traffic uses the
  separate authenticated encrypted bridge.
- Accepted iPhone LAN request payloads and successful response payloads use
  AES-256-GCM with timestamp, nonce, method, and path binding. Successful
  responses are bound to their request nonce; rejected requests use generic
  plaintext errors. Replay, skew, and body limits are enforced. Pairing secrets
  live in iOS Keychain and are not printed. The secret-bearing clipboard pairing
  link is exposed to clipboard managers and same-user processes. Local check-in
  history uses a bounded atomic file with complete file protection; expired
  records are removed from memory and disk.

Sensor acquisition is local. MCP tool results may be forwarded by the client to
its model provider. Review that provider's data policy before enabling media or
raw-title access.

## Out of scope

Sense does not defend against a malicious administrator, malware, a compromised
MCP client, or another process running as the same user. Do not enable optional
media or raw titles when those actors are in scope.
