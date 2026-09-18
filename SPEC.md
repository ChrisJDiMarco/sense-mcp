# ContextFrame Specification — v0.2 (draft)

A **ContextFrame** is a small, normalized JSON document describing a human's
current situation, assembled on demand from local sensors. It is the unit of
exchange between a per-user context broker and an AI client.

> AI should understand your moment, not surveil your life.

Design invariants:

1. **Ephemeral.** A frame describes *now*. Observations carry a TTL and expire.
   Implementations MUST NOT persist frames or raw sensor data to disk.
2. **Semantic, never raw.** Frames contain distilled states (`"present"`,
   `"noisy"`, `"in_meeting"`), never images, audio, or keystroke content.
   Raw media, if implemented, MUST live behind a separate explicit tool and
   MUST NOT be part of a ContextFrame.
3. **Pull-based delivery.** Frames are produced when a client asks. One local
   per-user broker may maintain short-lived sensor state while adapters are
   connected, but nothing is pushed to a client.
4. **Degrade gracefully.** Every field is optional. A frame with one sensor's
   data is valid. Missing means unknown, not false.
5. **Consent is tiered and legible.** Capability comes in numbered tiers the
   user opts into. A frame declares its tier and per-capability status, so a
   client can distinguish consent status from operational health.

## Privacy tiers

| Tier | Name | Adds | Sensors involved |
|---|---|---|---|
| 0 | Clock | local time, day segment, user-set mode | none (pure) |
| 1 | Activity | active app, activity class, window label, idle/presence, power, device/workspace state | OS APIs, no content capture |
| 2 | Surroundings | calendar/meeting state, noise *level* class, location *class*, media state, light/weather/health bridges | calendar, mic level (never audio content), coarse location |
| 3 | Attention | snapshot consent, camera-derived discrete attention states, raw window titles (redacted) | explicit capture or on-device inference only; no background camera enumeration |

Tiers are cumulative. Tier 0 MUST work with zero permissions. Tier 3 frame
sensors MUST emit only discrete enum states — never images, embeddings,
identity, or descriptions of appearance. A camera snapshot tool MAY return one
image only when explicitly invoked for a current visual user request.

## Envelope

```json
{
  "spec": "context-frame/0.2",
  "generated_at": "2026-06-11T14:32:08-04:00",
  "staleness_ms": 1200,
  "privacy": { ... },
  "situation": { ... },
  "screen": { ... },
  "user": { ... },
  "environment": { ... },
  "schedule": { ... },
  "assistive_posture": "lightly_available",
  "quality": { ... },
  "extensions": { ... }
}
```

| Field | Type | Description |
|---|---|---|
| `spec` | string | Spec identifier + version. Required. |
| `generated_at` | ISO 8601 | When the frame was assembled. Required. |
| `staleness_ms` | number | Age of the oldest observation included. Required. |
| `privacy` | object | Consent tier and capability status. Required. |
| `situation` | object | Optional compact summary, evidence, unknowns, risks, recommendations, and recent safe changes. |
| `screen` | object | What the user is doing on screen. |
| `user` | object | The user's physical/attention state. |
| `environment` | object | Ambient physical context. |
| `schedule` | object | Time pressure and calendar context. |
| `assistive_posture` | string | Derived hint: what kind of help is appropriate right now. |
| `quality` | object | Optional freshness, provenance, field classification, and stability metadata. |
| `extensions` | object | Namespaced vendor/community fields (`"x-oura:readiness"`). |

## `quality`

```json
{
  "overall_freshness": "fresh",
  "domains": {
    "screen": {
      "source_sensors": ["active-window"],
      "observation_count": 1,
      "staleness_ms": 1200,
      "freshness": "fresh"
    }
  },
  "fields": {
    "screen": {
      "activity_class": {
        "source": "active-window",
        "classification": "classified",
        "observed_at": "2026-06-11T14:32:07.000Z",
        "staleness_ms": 1200
      }
    }
  },
  "stability": {
    "screen_activity": "stable"
  }
}
```

`quality` lets clients distinguish a directly observed field from a local
classification or derivation, and helps them avoid overreacting to stale or
jumpy signals.

Freshness enum: `empty` | `fresh` | `aging` | `stale`.
Field classification enum: `observed` | `classified` | `derived` | `summary`.
Stability enum: `stable` | `recent_transition` | `unknown`.

## `privacy`

```json
{
  "tier": 1,
  "capabilities": {
    "screen_activity": "granted",
    "calendar": "denied",
    "location_class": "granted",
    "microphone_level": "denied",
    "camera_snapshot": "denied",
    "camera_attention": "unavailable",
    "raw_window_titles": "denied"
  },
  "capability_states": {
    "screen_activity": "healthy",
    "calendar": "disabled",
    "location_class": "healthy",
    "microphone_level": "disabled",
    "camera_snapshot": "disabled",
    "camera_attention": "unavailable",
    "raw_window_titles": "disabled"
  },
  "capability_details": {
    "calendar": {
      "sensor": "calendar",
      "state": "disabled",
      "reason": "disabled_by_policy",
      "detail": "Calendar access is disabled by central Sense policy.",
      "fix_hint": "Install icalBuddy and run sense-mcp enable calendar."
    }
  }
}
```

Capability status enum: `granted` | `denied` | `unavailable`.
`denied` is a compatibility umbrella for access that is disabled by policy or
denied by the operating system; inspect `capability_states` to distinguish
`disabled` from `permission_denied`. `unavailable` = no sensor on this platform.
This lets a client read `"attention": absent` correctly: at
`camera_attention: "denied"` the right behavior is *don't ask, don't infer*,
not "data missing, try harder."

Operational state enum: `disabled` | `unavailable` | `permission_denied` |
`no_signal` | `degraded` | `stale` | `healthy`. Compatibility status remains
stable for existing clients. `capability_states` explains whether a capability
is producing useful data.

`capability_details` is optional diagnostic metadata for any non-healthy
operational state. It lets clients explain missing context without guessing,
for example `disabled_by_policy`, `headless_calendar_provider_missing`,
`missing_focus_bridge`, or
`ambient_light_not_exposed`.

Numeric confidence scores are deliberately excluded from v0.2: no current sensor
produces calibrated probabilities, and uncalibrated numbers are worse than none.
Coarse communication labels such as `situation.confidence: "medium"` are allowed
when they describe evidence strength rather than probability.

## `situation`

```json
{
  "summary": "User appears active working in sense-mcp, activity looks like coding, with 3 changed items, plugged in.",
  "confidence": "medium",
  "evidence": ["workspace sense-mcp", "activity coding", "3 changed items", "power ac_power"],
  "unknowns": ["calendar: calendar_query_timeout"],
  "risks": [],
  "recommendations": ["Use a direct calendar connector for account schedule timing when needed."],
  "recent_changes": ["Working in sense-mcp (coding)", "Power ac_power"]
}
```

The situation card is a lossy, token-frugal reading of the frame. It is meant
for assistants that need a quick sense of the moment without repeating every
field. It MUST avoid raw private content. `recent_changes` MUST be semantic
event labels only, not titles, message text, screenshots, audio, or file
contents.

`confidence` here is not a calibrated model probability. It is a coarse
communication posture based on evidence volume, freshness, and missing signals:
`high` | `medium` | `low` | `unknown`.

## `screen`

```json
{
  "active_app": "Figma",
  "active_window_label": "design file",
  "activity_class": "designing",
  "sensitivity_level": "normal",
  "workspace_name": "checkout",
  "git_branch": "main",
  "git_dirty_count": 3,
  "summary": "Editing a design file; communication app has unread activity"
}
```

`activity_class` enum (extensible): `coding` | `writing` | `designing` |
`browsing` | `reading` | `communicating` | `media` | `meeting` | `idle` |
`unknown`.

`active_window_label` is a locally derived, privacy-safe classification of the
window (`"design file"`, `"code editor — project"`, `"banking"`,
`"document"`). **Raw window titles are a Tier-3 capability**
(`raw_window_titles`): when granted, implementations MAY include
`active_window_title`, and MUST first pass it through local redaction
(strip account numbers, email subjects, message-thread names, document titles
matching sensitive patterns). The base spec biases safe: labels by default,
titles by explicit opt-in.

`summary` is an optional one-sentence natural-language distillation, produced
locally. It MUST NOT include credential fields, message bodies, or other
sensitive on-screen text.

Implementations MAY include generic sensitivity fields such as
`sensitivity_level: "medium"` and
`sensitivity_reason: "communication_context"`. These fields MUST be generic and
MUST NOT reveal the raw title or content that triggered the sensitivity label.

## `user`

```json
{
  "presence": "active",
  "idle_seconds": 4,
  "input_cadence": "steady",
  "focus_mode": "deep_work",
  "attention": "focused"
}
```

`presence`: `active` | `idle` | `away` | `unknown`.
`input_cadence`: `rapid` | `steady` | `sparse` | `none`.
`attention` (Tier 3 only): `focused` | `distracted` | `away_from_screen` |
`multiple_people_present` | `unknown`.

## `environment`

```json
{
  "location_class": "home_office",
  "noise_class": "quiet",
  "lighting": "normal",
  "battery_percent": 83,
  "power_source": "ac_power",
  "media_playback": "paused",
  "local_time": "14:32",
  "day_segment": "afternoon",
  "daylight_class": "daylight",
  "is_workday": true
}
```

`location_class` is semantic, never coordinates: `home` | `home_office` |
`office` | `cafe` | `transit` | `outdoors` | `unknown`.
`noise_class`: `silent` | `quiet` | `moderate` | `noisy` | `unknown` — derived
from level only; audio content MUST NOT be processed.
`media_playback` is semantic (`playing` | `paused` | `unknown`) and SHOULD NOT
include track, artist, podcast, or episode names by default.
`camera_available`, when present, describes device availability only. It MUST
NOT imply an image was captured.

## `schedule`

```json
{
  "in_meeting": false,
  "next_event_minutes": 18,
  "time_pressure": "moderate"
}
```

`time_pressure`: `none` | `moderate` | `high` — derived
(e.g., event within 15 min ⇒ `high`).

Local Calendar acquisition MUST be policy-gated and headless. The Sense
implementation uses optional `icalBuddy` and MUST NOT activate or launch a GUI
calendar application.

## Context tool responses (normative)

Every context tool returns machine-readable `structuredContent` alongside one
short text line. The structured envelope is:

| Field | Type | Description |
|---|---|---|
| `ok` | boolean | The call produced a usable response. |
| `context_satisfied` | boolean | Every requested domain that had data is present in `context`. |
| `projection` | string | The projection actually used, which MAY be leaner than the one requested. |
| `budget` | object | `max_tokens`, `max_bytes`, `estimated_tokens`, `serialized_bytes`, `truncated`. |
| `context` | object | The filtered ContextFrame. |
| `health` | object | Provider status, source, and diagnostics. |
| `refreshed_domains` | array | Domains the provider actually refreshed. |
| `context_omitted` | object | Present only when `context_satisfied` is false. |
| `error` | object | Present only when `ok` is false. |

`get_relevant_context` returns the same envelope plus its routing fields, and
reports its budgets as `context_budget` (the embedded frame) and `output_budget`
(the complete response).

### `max_tokens`

`max_tokens` is a ceiling on the **complete** serialized response, not on the
frame alone, and it is converted to an enforced byte ceiling at three serialized
bytes per estimated token. Exact model tokenization differs, so the token number
is an estimate and the byte ceiling is the enforced invariant.

Implementations MUST publish a closed accepted range and MUST reject an input
outside it at schema validation. The Sense implementation accepts **320 to
8,192** on every context tool and on the router alike. The floor is the smallest
budget that can still return a domain body rather than a bare envelope; the
ceiling is what the server will ever suggest retrying at, so a suggestion is
always a legal input.

When `max_tokens` is omitted, the projection default applies:

| projection | default `max_tokens` |
| ---------- | -------------------- |
| `compact`  | `1150`               |
| `brief`    | `1500`               |
| `focused`  | `2800`               |
| `debug`    | `5600`               |
| `diff`     | `800`                |

`get_context_frame` and `get_domains` default to `focused`; the single-domain
getters default to `brief`. `get_relevant_context` takes no projection and
defaults to `2800`, because its ceiling has to cover the routing plan, the
guidance, and the planned domains' context together.

These defaults are ceilings, not costs. A larger default never inflates a
response; it only stops one being truncated. Each is the measured cost of that
projection's complete, untruncated output over a realistically full frame plus
roughly 40% headroom, so a stock call still returns the projection's full shape
after a sensor or a diagnostic is added.

### Partial responses

A response that fits its budget but had to leave requested domain data out is
**not** an error. It returns `ok: true`, the context it could fit,
`context_satisfied: false`, and a `context_omitted` block:

```json
{
  "domains": ["screen", "user", "environment", "schedule"],
  "reason": "Some of the requested screen, user, environment, schedule data did not fit the serialized output budget. Retry with max_tokens 1741 for the complete response.",
  "suggested_max_tokens": 1741
}
```

`suggested_max_tokens` is present only when that budget was measured to return
the complete response. It is always larger than the budget the caller sent and
never above the accepted ceiling, so a client MAY retry on it blindly.

`context_satisfied: true` therefore means "every requested domain that has data
is present", and it is measured against the frame the response was built from —
it is not something a caller asserts and not something the server claims
optimistically. Partial truthful context is useful to a model; a hard error on a
context-enrichment tool is not.

An implementation MUST return `ok: false` only when no response at all fits the
requested budget. The Sense implementation uses the machine error code
`context_budget_too_small` for exactly that case. `retryable` is true exactly
when a budget within the accepted range was measured to work, and `fix_hint`
then names it; when no budget in range works, `retryable` is false and the hint
says to request fewer domains or a leaner projection instead. An error that is
retryable in principle but not at any legal input is worse than no hint.

### Tool order

`get_relevant_context` SHOULD be listed first. Clients weight tool order, and
the routing discipline the rest of this spec assumes only holds if the planning
tool is the one a client reaches for before the raw getters.

## Relevance router

Implementations MAY expose `get_relevant_context({ user_request })`. This tool
does not capture media. It classifies the current request and returns:

- `intent`: e.g. `visual_appearance_check`, `screen_debug`, `time_pressure`,
  `no_local_context_needed`.
- `confidence`: `high` | `medium` | `low`.
- `minimum_tool`: the smallest tool that should be sufficient, or `none`.
- `relevant_domains`: the smallest ContextFrame domains likely needed.
- `recommended_tools`: explicit follow-up tools such as `take_camera_snapshot`,
  `take_window_snapshot`, or `take_full_screen_snapshot`.
- `avoided_tools`: tools that should not be called for this request.
- `fallbacks`: what to do if the recommended tool is denied or unavailable.
- `privacy_notes`: constraints the client should preserve in its answer.
- `snapshot_mode`: optional task lens for vision tools.
- `context_plan`: expected context value, token budget, included/excluded
  context, whether this is plan-only, and external connector recommendations.
- `context`: a ContextFrame filtered to the relevant domains, omitted when
  `context_plan.plan_only` is true.

Example `context_plan`:

```json
{
  "expected_value": "high",
  "budget": { "mode": "focused", "max_tokens": 3312 },
  "plan_only": false,
  "include_frame": true,
  "include_situation": true,
  "included_context": ["schedule_domain", "user_domain", "get_schedule_context"],
  "excluded_context": ["camera_snapshot", "window_snapshot", "full_screen_snapshot"],
  "external_context_needed": ["calendar_connector"],
  "reason": "Schedule timing can change the recommendation; account calendar data may need a connector."
}
```

`expected_value` is `none` | `low` | `medium` | `high`. Clients SHOULD treat
`none` plus `plan_only: true` as an instruction to answer normally without
pulling a ContextFrame. Context tool input `max_tokens` sets a hard
complete-response byte ceiling at three serialized bytes per estimated token.
Exact model tokenization can differ.

`context_plan.budget.max_tokens` is advisory, and a client MAY echo it straight
back as the `max_tokens` input of the call the plan recommends. It therefore
MUST be a legal value for that input, and it MUST be large enough for that call
to answer in full. Each mode is the default budget of the projection the
recommended call uses, plus the routing envelope that call carries when it comes
back through `get_relevant_context`, because `max_tokens` is a ceiling on the
complete response and not on the frame alone:

| mode      | recommended call                        | projection | advisory |
| --------- | --------------------------------------- | ---------- | -------- |
| `none`    | none; the plan is the whole answer      | n/a        | `0`      |
| `visual`  | a snapshot tool, which takes no budget  | compact    | `1662`   |
| `brief`   | a single-domain getter                  | brief      | `2012`   |
| `focused` | `get_context_frame`                     | focused    | `3312`   |

These numbers follow the implementation's projection defaults; an implementation
with different defaults will publish different advisories. What is normative is
the two properties: legal input, and sufficient for the recommended call. On a
real four-domain frame the focused projection costs about 2200 estimated tokens
and the routing envelope about 500, so an advisory equal to the projection
default alone would push the router onto a smaller output candidate and silently
drop guidance and privacy notes. Implementations SHOULD verify both properties
against a captured real frame rather than a hand-written one: a minimal test
frame is an order of magnitude smaller and hides the failure.

Clients SHOULD use this before guessing whether camera, screen, schedule, or
environment tools are appropriate.

### Routing a request to a capture

A capture is the one routing decision that cannot be taken back, so the router
MUST NOT recommend `take_camera_snapshot`, `take_window_snapshot`,
`take_full_screen_snapshot` or `take_screen_snapshot` unless the request is
about something the user can see right now. A topic noun is not such a request.
"lighting", "recording", "my desk" and "behind me" are the ordinary subject
matter of general questions ("tips for lighting a video call", "how do I start
recording in Zoom?", "what is a good desk height?"), and a router that keys on
the noun alone answers them by turning on the camera. Two conditions are
therefore required together:

1. the sentence is about this user's own present situation — a first-person or
   demonstrative reference, not a third-person or generic one; and
2. the sentence asks what is there — an identification, inspection or
   appearance question — rather than asking for advice, instructions or prose
   about the same subject.

A request that is a writing task ("draft a post about my desk setup") fails
condition 2 whatever nouns it contains, and implementations SHOULD apply that
gate to every branch that can reach a sensor through a bare noun, not only to
the ones that capture. An implementation's corpus SHOULD assert this directly:
the general-knowledge phrasing of each capture trigger belongs in the negative
corpus, where reaching a capture tool fails the build.

## Access ledger

Implementations MAY keep a local metadata-only access ledger so the user can see
which Sense tools were requested, when, why, and whether media was captured.

Ledger entries MUST NOT store ContextFrames, screenshots, camera pixels, audio,
raw window titles, message text, or file contents. A compliant ledger entry may
include:

```json
{
  "observed_at": "2026-06-15T12:00:00.000Z",
  "tool": "get_relevant_context",
  "status": "planned",
  "reason": "Local context is unlikely to change the answer.",
  "media_captured": false,
  "context_domains": [],
  "expected_value": "none",
  "budget_mode": "none",
  "max_tokens": 0
}
```

The ledger is a transparency aid, not an authorization system. It SHOULD be
local, bounded, and user-inspectable, and it SHOULD allow disabling.

## Explicit snapshot tools

Implementations MAY expose `take_camera_snapshot`, `take_window_snapshot`, and
`take_full_screen_snapshot`. A deprecated `take_screen_snapshot` alias MAY be
retained only if it remains window-only. These tools are outside the
ContextFrame envelope and MUST follow these rules:

1. It is disabled unless the user explicitly opts in.
2. It MUST require a current-reason argument explaining why the user request is
   visual.
3. It MUST NOT be called for general context, proactive suggestions, or
   non-visual tasks.
4. Immediately before acquisition, it MUST obtain and consume a local,
   short-lived, single-use consent receipt bound to media kind, scope, target,
   normalized reason, and expiry. A mismatch or prompt failure MUST stop the
   capture. It MUST recheck the capability policy after consent and before
   acquisition. A caller-supplied app-window id MUST be validated as an
   on-screen normal window, and consent MUST identify and bind its owner app
   and process so an opaque or recycled id cannot silently widen the target.
5. Window capture SHOULD be the default screen operation and SHOULD NOT activate
   the target app. Full-screen capture MUST be a distinct operation with an
   explicit full-screen confirmation.
6. It MUST NOT write images to persistent storage unless the user asks for a
   saved artifact. It MAY write a private temporary image file when needed for a
   local client to inspect pixels, provided the path is returned to the client
   and stale files are cleaned up.
7. It SHOULD return structured metadata (`generated_at`, `device_label`,
   `snapshot_path`, `error`, `fix_hint`) and, on success, one image content
   block.
8. It SHOULD include a mode such as `appearance_check`, `hair_check`,
   `lighting_check`, `screen_debug`, or `ui_feedback` so the client answers with
   the right level of detail.

## `assistive_posture`

A single derived, top-level hint telling the client what kind of help fits the
moment:

`available` | `lightly_available` | `do_not_interrupt` | `urgent_only` |
`unknown`

Reference derivation (implementations MAY refine):

| Condition | Posture |
|---|---|
| `in_meeting` or `attention: focused` with `time_pressure: high` | `urgent_only` |
| `input_cadence: rapid` or sustained `steady` in `coding`/`writing`/`designing` | `do_not_interrupt` |
| `presence: active`, no time pressure | `available` |
| `presence: idle` | `lightly_available` |
| insufficient signal | `unknown` |

This is the social-intelligence layer: it converts state into appropriateness.
Clients SHOULD respect it for proactive behavior (suggestions, notifications)
and ignore it for direct user requests — a user who asks a question always
gets an answer.

## Field classification

Not all fields are equally factual. Clients MUST NOT treat classifications or
derivations as ground truth.

| Class | Meaning | Examples | Client guidance |
|---|---|---|---|
| **observed** | Direct measurement | `idle_seconds`, `active_app`, `local_time`, `in_meeting` | Treat as fact (subject to staleness). |
| **classified** | Local model/heuristic mapping of an observation | `activity_class`, `input_cadence`, `noise_class`, `location_class`, `attention`, `active_window_label` | Treat as probable; phrase accordingly. |
| **derived** | Computed from multiple fields by rule | `time_pressure`, `assistive_posture` | Treat as a hint; never as justification for irreversible action. |
| **summary** | Natural-language distillation | `screen.summary` | Treat as lossy narrative, not source data. |

Implementations SHOULD expose this classification in `quality.fields` when
available. Clients should use it to phrase claims carefully: observed fields can
be treated as facts subject to staleness; classified and derived fields should
be treated as hints.

## Observations (internal model)

Sensors emit **observations**; the per-user broker merges live observations
into a frame.

```json
{
  "sensor": "active-window",
  "domain": "screen",
  "fields": { "active_app": "Figma" },
  "observed_at": "2026-06-11T14:32:07-04:00",
  "ttl_ms": 10000
}
```

An observation past its TTL is dead and MUST be dropped. State is keyed by
sensor and domain. Each field keeps its own expiry, so a partial update cannot
extend an older field. Context providers MAY refresh only requested domains
with `cached`, `if_stale`, or `force` behavior.

## Client behavior guide (normative)

1. Pull a frame only when situational context would change the response.
2. Never echo frame contents back to the user unprompted ("I see you're in
   Figma…") unless it materially helps; ambient awareness should feel like
   good judgment, not surveillance narration.
3. Respect `assistive_posture` for proactive behavior only.
4. Treat `denied` capabilities as not authorized for acquisition — do not probe
   or infer around them. Inspect `capability_states` before explaining whether
   policy or an OS permission is responsible.
5. Do not store frames. If conversation memory persists, persist conclusions
   ("user was heads-down before a deadline"), not frames.

## Conformance

An implementation is conformant if it: produces valid envelopes; declares
`privacy.tier` and capability statuses truthfully; enforces TTL expiry; never
writes raw sensor data to durable storage; makes no hidden network call during
sensor acquisition; discloses that MCP clients may forward returned results to
a model provider; emits only enum states from Tier-3 sensors; redacts raw window
titles when that capability is granted; treats all optional fields as optional
on read.

## Changelog

- **0.2** — Added `privacy` block (tier + capability status), `assistive_posture`,
  formalized Tiers 0–3, replaced default `active_window_title` with
  `active_window_label` (raw titles moved to Tier 3 + redaction), added field
  classification table and client behavior guide. Rejected: per-domain numeric
  confidence (uncalibrated), per-frame `raw_data_*` attestation booleans
  (spec invariants, not data), separate `derived` wire block (flat format wins).
- **0.2 broker addendum** — Added optional `situation`, `context_plan`, and a
  metadata-only local access ledger.
- **0.2 response addendum** — Added the normative context tool response
  envelope: a closed accepted `max_tokens` range (320–8,192, replacing the
  earlier 96/160 floors and 4,096 ceiling), published projection defaults, the
  `context_omitted` block, `context_satisfied` defined as "every requested
  domain that has data is present", partial-not-error semantics, and
  `get_relevant_context` first in tool order.
- **0.2 hardening addendum** — Added shared broker lifecycle, field-level
  expiry, domain refresh, operational capability states, response byte
  ceilings, window-first capture, exact local media consent, and the
  client/provider egress boundary.
- **0.1** — Initial draft.

---
*v0.2 is a draft. Field proposals welcome via issues tagged `spec`.*
