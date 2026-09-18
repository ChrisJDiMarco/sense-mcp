# Privacy model

Sense collects context on the Mac and returns bounded results through MCP. Local
collection does not mean model-local processing. The configured MCP client may
send tool results, including images, to its model provider. Sense cannot control
that provider's retention, training, or logging policy.

## Defaults

Sense keeps ordinary context semantic and short-lived. Raw content and
sensitive probes are off unless policy enables them.

The private per-user policy file is `~/.sense-mcp/policy.json` by default. Its
values are authoritative. Existing `SENSE_*` environment variables remain
per-key migration fallbacks when the file has no value. A missing value defaults
to off for:

- Calendar
- coarse location
- microphone level
- camera snapshots
- app-window snapshots
- full-screen snapshots
- raw window titles

Use `sense-mcp enable <capability>` and `sense-mcp disable <capability>` to
change central policy. The broker reloads policy changes without requiring each
MCP adapter to restart. An invalid or symlinked policy file fails closed.

## Semantic context

Normal ContextFrame fields are small states such as `activity_class: "coding"`,
`presence: "active"`, and `power_source: "ac_power"`. Frames do not contain
camera pixels, screenshots, audio content, keystrokes, messages, page text,
file contents, Wi-Fi SSIDs, event titles, media titles, or raw window titles by
default.

Every observation has a TTL. The broker stores fields in memory by sensor and
domain, and expires each field independently. A fresh partial update cannot
extend an older field. Context tools can use cached state, refresh stale
requested domains, or force a domain refresh.

## Calendar

Calendar is off by default. When enabled, Sense uses the optional headless
`icalBuddy` command. It does not script, activate, or launch Calendar.app.
The query requests date/time metadata only; event titles are neither requested
nor emitted.

Use a direct calendar connector when account-backed schedule data is required.
Sense's local Calendar signal is a coarse timing fallback.

## Media capture

Media is never a broker background sensor.

| Tool | Scope |
|---|---|
| `take_camera_snapshot` | One camera frame. |
| `take_window_snapshot` | One selected or safely resolved app window without activating it. |
| `take_full_screen_snapshot` | The main display; requires `confirm_full_screen: true`. |
| `take_screen_snapshot` | Deprecated compatibility alias for `take_window_snapshot`; it never captures the full screen. |

Policy enablement is necessary but not sufficient. Immediately before every
camera, window, or full-screen capture, Sense shows a local allow-once prompt.
Approval creates a signed, short-lived, single-use receipt bound to the media
kind, scope, target, normalized reason, and expiry. The exact receipt must be
consumed before acquisition. A mismatch, denial, expiry, replay, storage error,
or unavailable prompt stops the capture. Receipt lifetime is clamped to 1 to
120 seconds.

Snapshot PNGs are written to a private per-user temp directory with mode `0600`.
The directory is mode `0700`. Paths are unpredictable, bounded to 25 MiB,
validated as PNGs, and become eligible for bounded, opportunistic cleanup after two hours; they may remain longer while Sense is idle.
Sense rejects symlinked storage paths.

## Output budgets

Context projections are `compact`, `brief`, `focused`, `debug`, and `diff`.
The requested `max_tokens` is converted to an enforced complete-response byte
ceiling at three bytes per estimated token. Sense reports the byte ceiling,
serialized bytes, conservative token estimate, and whether it selected a
smaller projection. Exact token counts remain model-specific.

Default budgets are 1,150 tokens for compact, 1,500 for brief, 2,800 for
focused, 5,600 for debug, and 800 for diff; `get_relevant_context` defaults to
2,800. Every context tool and the router accept the same closed range, 320 to
8,192. These defaults are ceilings, not costs: they are each the measured cost
of that projection's complete output over a full frame plus headroom, so a
stock response is not truncated. They are substantially higher than the earlier
defaults, which is a deliberate trade. Measured on
`docs/evals/real-frame-fixture.json`, a stock response now carries roughly four
to eight times as many tokens into the model's context as the old ceilings
allowed: `get_context_frame` 2,211 estimated tokens against an old ceiling of
280, `get_screen_context` 1,020 against 180, `get_relevant_context` 1,958
against 480. What it buys is that those responses are complete — under the old
ceilings the same calls silently shed domains the caller asked for. A caller
that wants the old footprint should pass `max_tokens` explicitly and read
`context_omitted` to see what that costs.

## Local storage

Policy, consent, ledger, snapshot, broker, and iPhone context files use bounded
reads, symlink rejection, private modes, and atomic same-directory replacement.
Lock recovery checks file identity and live owner PIDs before removing stale
locks.

The access ledger defaults to `~/.sense-mcp/access-ledger.jsonl`. It keeps at
most 200 metadata entries. Caller-controlled reasons and errors are never stored
as plaintext; entries use fixed summaries/classes and SHA-256 hashes for local
correlation. Reads migrate legacy plaintext rows under the ledger lock. The
ledger never stores ContextFrames, pixels, audio, raw titles, messages, or file
contents. Set `SENSE_LEDGER_DISABLED=1` to disable it.

Consent receipts live under `~/.sense-mcp/consent`. Use:

```bash
sense-mcp consent list
sense-mcp consent revoke <receipt-id>
sense-mcp consent revoke all
```

## Settings panel

`sense-mcp settings --open` binds to `127.0.0.1` and rejects non-local Host
headers. It opens a private `0600` launcher file whose secret is posted once in
the request body, never placed in a process argument, URL, history, terminal
output, or clipboard. The server invalidates that bootstrap and issues a
distinct HttpOnly, SameSite session cookie before serving HTML, status, or any
settings API. The panel reports central policy, capability state, broker
health, capture-consent requirement state, recent snapshot metadata, and ledger metadata. It does
not embed snapshot pixels. The panel exposes no plaintext fixed-header iPhone
check-in endpoint; companion traffic uses the separate AEAD bridge.

## iPhone companion

The iPhone companion stores its pairing secret in Keychain. It stores at most
12 unexpired local check-ins in an atomic 256 KiB-capped Application Support
file with complete file protection; legacy `UserDefaults` history migrates once
and is removed only after protected persistence succeeds. Accepted LAN request
payloads and successful response payloads use AES-256-GCM with
method/path/timestamp/nonce binding. The
bridge rejects replayed nonces, excessive clock skew, invalid content lengths,
oversized bodies, and unencrypted requests. The decrypted check-in payload is
capped at 16 KiB and
the encrypted HTTP body at 32 KiB. It exposes only the check-in and
connection-check paths, not panel settings. Each successful response is
authenticated against the nonce of its request; rejected requests use generic
plaintext errors.

Pairing uses a secret-bearing deep link copied through `pbcopy`; Sense does not
print it. Clipboard managers and same-user processes are therefore inside the
pairing threat model. The app accepts only private, link-local, loopback, mDNS,
or shared carrier-grade NAT (`100.64.0.0/10`) targets, but every target still
requires a valid pairing secret and AEAD. There is no Bearer-token or
plaintext-loopback mode.

## Client responsibility

Clients should request the smallest useful projection, stop when
`context_satisfied` is true, inspect image content before making visual claims,
and treat classified or derived fields as hints. They should never use capture
tools for ordinary writing, coding, planning, or personalization.

Sense does not defend against an administrator, malware, or another compromised
process running as the same OS user. Local consent limits accidental and remote
tool misuse; it is not an operating-system sandbox.
