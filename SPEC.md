# ContextFrame Specification — v0.2 (draft)

A **ContextFrame** is a small, normalized JSON document describing a human's
current situation, assembled on demand from local sensors. It is the unit of
exchange between a presence daemon and an AI client.

> AI should understand your moment, not surveil your life.

Design invariants:

1. **Ephemeral.** A frame describes *now*. Observations carry a TTL and expire.
   Implementations MUST NOT persist frames or raw sensor data to disk.
2. **Semantic, never raw.** Frames contain distilled states (`"present"`,
   `"noisy"`, `"in_meeting"`), never images, audio, or keystroke content.
   Raw media, if implemented, MUST live behind a separate explicit tool and
   MUST NOT be part of a ContextFrame.
3. **Pull-based.** Frames are produced when a client asks. Sensors may sample
   continuously, but nothing is pushed or uploaded.
4. **Degrade gracefully.** Every field is optional. A frame with one sensor's
   data is valid. Missing means unknown, not false.
5. **Consent is tiered and legible.** Capability comes in numbered tiers the
   user opts into. A frame declares its tier and per-capability status, so a
   client can distinguish *denied* from *unavailable* from *unknown*.

## Privacy tiers

| Tier | Name | Adds | Sensors involved |
|---|---|---|---|
| 0 | Clock | local time, day segment, user-set mode | none (pure) |
| 1 | Activity | active app, activity class, window label, idle/presence, power, device/workspace state | OS APIs, no content capture |
| 2 | Surroundings | calendar/meeting state, noise *level* class, location *class*, media state, light/weather/health bridges | calendar, mic level (never audio content), coarse location |
| 3 | Attention | camera availability/snapshot consent, camera-derived discrete attention states, raw window titles (redacted) | camera explicit snapshot or on-device inference only |

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
    "calendar": "unavailable",
    "location_class": "granted",
    "microphone_level": "denied",
    "camera_snapshot": "denied",
    "camera_attention": "denied",
    "raw_window_titles": "denied"
  }
}
```

Capability status enum: `granted` | `denied` | `unavailable`.
`denied` = the user said no. `unavailable` = no sensor on this platform.
This lets a client read `"attention": absent` correctly: at
`camera_attention: "denied"` the right behavior is *don't ask, don't infer*,
not "data missing, try harder."

Confidence scores are deliberately excluded from v0.2: no current sensor
produces calibrated confidence, and uncalibrated numbers are worse than none.
May be revisited when a sensor class can justify them.

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
  "next_event_label": "calendar event",
  "next_event_minutes": 18,
  "time_pressure": "moderate"
}
```

`time_pressure`: `none` | `moderate` | `high` — derived
(e.g., event within 15 min ⇒ `high`).
Event labels SHOULD default to generic labels such as `"calendar event"` unless
the user has explicitly opted into event title exposure.

## Relevance router

Implementations MAY expose `get_relevant_context({ user_request })`. This tool
does not capture media. It classifies the current request and returns:

- `intent`: e.g. `visual_appearance_check`, `screen_debug`, `time_pressure`.
- `confidence`: `high` | `medium` | `low`.
- `minimum_tool`: the smallest tool that should be sufficient, or `none`.
- `relevant_domains`: the smallest ContextFrame domains likely needed.
- `recommended_tools`: explicit follow-up tools such as `take_camera_snapshot`
  or `take_screen_snapshot`.
- `avoided_tools`: tools that should not be called for this request.
- `fallbacks`: what to do if the recommended tool is denied or unavailable.
- `privacy_notes`: constraints the client should preserve in its answer.
- `snapshot_mode`: optional task lens for vision tools.
- `context`: a ContextFrame filtered to the relevant domains.

Clients SHOULD use this before guessing whether camera, screen, schedule, or
environment tools are appropriate.

## Explicit snapshot tools

Implementations MAY expose separate `take_camera_snapshot` and
`take_screen_snapshot` tools. These tools are outside the ContextFrame envelope
and MUST follow these rules:

1. It is disabled unless the user explicitly opts in.
2. It MUST require a current-reason argument explaining why the user request is
   visual.
3. It MUST NOT be called for general context, proactive suggestions, or
   non-visual tasks.
4. It MUST NOT write images to persistent storage unless the user asks for a
   saved artifact. It MAY write a private temporary image file when needed for a
   local client to inspect pixels, provided the path is returned to the client
   and stale files are cleaned up.
5. It SHOULD return structured metadata (`generated_at`, `device_label`,
   `snapshot_path`, `error`, `fix_hint`) and, on success, one image content
   block.
6. It SHOULD include a mode such as `appearance_check`, `hair_check`,
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
| **classified** | Local model/heuristic mapping of an observation | `activity_class`, `noise_class`, `location_class`, `attention`, `active_window_label` | Treat as probable; phrase accordingly. |
| **derived** | Computed from multiple fields by rule | `time_pressure`, `assistive_posture`, `input_cadence` | Treat as a hint; never as justification for irreversible action. |
| **summary** | Natural-language distillation | `screen.summary` | Treat as lossy narrative, not source data. |

Implementations SHOULD expose this classification in `quality.fields` when
available. Clients should use it to phrase claims carefully: observed fields can
be treated as facts subject to staleness; classified and derived fields should
be treated as hints.

## Observations (internal model)

Sensors emit **observations**; the daemon merges live observations into a
frame.

```json
{
  "sensor": "active-window",
  "domain": "screen",
  "fields": { "active_app": "Figma" },
  "observed_at": "2026-06-11T14:32:07-04:00",
  "ttl_ms": 10000
}
```

An observation past its TTL is dead and MUST be dropped. Later observations
from the same sensor replace earlier ones, field-wise within their domain.

## Client behavior guide (normative)

1. Pull a frame only when situational context would change the response.
2. Never echo frame contents back to the user unprompted ("I see you're in
   Figma…") unless it materially helps; ambient awareness should feel like
   good judgment, not surveillance narration.
3. Respect `assistive_posture` for proactive behavior only.
4. Treat `denied` capabilities as a user decision — do not probe or infer
   around them.
5. Do not store frames. If conversation memory persists, persist conclusions
   ("user was heads-down before a deadline"), not frames.

## Conformance

An implementation is conformant if it: produces valid envelopes; declares
`privacy.tier` and capability statuses truthfully; enforces TTL expiry; never
writes raw sensor data to durable storage; never transmits raw sensor data
off-device; emits only enum states from Tier-3 sensors; redacts raw window
titles when that capability is granted; treats all optional fields as optional
on read.

## Changelog

- **0.2** — Added `privacy` block (tier + capability status), `assistive_posture`,
  formalized Tiers 0–3, replaced default `active_window_title` with
  `active_window_label` (raw titles moved to Tier 3 + redaction), added field
  classification table and client behavior guide. Rejected: per-domain numeric
  confidence (uncalibrated), per-frame `raw_data_*` attestation booleans
  (spec invariants, not data), separate `derived` wire block (flat format wins).
- **0.1** — Initial draft.

---
*v0.2 is a draft. Field proposals welcome via issues tagged `spec`.*
