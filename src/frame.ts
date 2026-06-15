import type {
  ContextQuality,
  ContextFrame,
  Domain,
  FieldClassification,
  FieldQuality,
  Freshness,
  Privacy,
  Stability,
} from "./types.js";
import { StateStore } from "./state.js";
import { derivePosture } from "./posture.js";

const DOMAINS: Domain[] = ["screen", "user", "environment", "schedule"];
const TIER_ZERO: Privacy = { tier: 0, capabilities: {} };
const FRESH_MS = 30_000;
const AGING_MS = 120_000;

const OBSERVED_FIELDS = new Set([
  "active_app",
  "active_window_title",
  "idle_seconds",
  "battery_percent",
  "power_source",
  "low_power_mode",
  "external_display_count",
  "bluetooth_audio_connected",
  "git_branch",
  "git_dirty_count",
  "local_time",
  "is_workday",
  "in_meeting",
  "next_event_minutes",
  "camera_available",
  "camera_device_count",
  "microphone_level_db",
  "microphone_level_sample_ms",
]);

const CLASSIFIED_FIELDS = new Set([
  "activity_class",
  "active_window_label",
  "sensitivity_level",
  "sensitivity_reason",
  "presence",
  "input_cadence",
  "focus_mode",
  "day_segment",
  "daylight_class",
  "location_class",
  "noise_class",
  "lighting",
  "media_playback",
  "camera_default_label",
]);

const DERIVED_FIELDS = new Set(["time_pressure", "workspace_name", "next_event_label"]);

function fieldClassification(field: string): FieldClassification {
  if (field.includes("summary")) return "summary";
  if (OBSERVED_FIELDS.has(field)) return "observed";
  if (CLASSIFIED_FIELDS.has(field)) return "classified";
  if (DERIVED_FIELDS.has(field)) return "derived";
  return "classified";
}

function freshnessFor(stalenessMs: number, empty = false): Freshness {
  if (empty) return "empty";
  if (stalenessMs <= FRESH_MS) return "fresh";
  if (stalenessMs <= AGING_MS) return "aging";
  return "stale";
}

function screenActivityStability(store: StateStore, now: number): Stability {
  const observations = store
    .history("screen", now, 60_000)
    .filter((obs) => obs.fields.active_app || obs.fields.activity_class);
  if (observations.length < 2) return "unknown";

  const signatures = new Set(
    observations.map((obs) => `${obs.fields.active_app ?? ""}:${obs.fields.activity_class ?? ""}`),
  );
  return signatures.size <= 1 ? "stable" : "recent_transition";
}

/**
 * Assemble a ContextFrame from live observations.
 * Later observations win field-wise within a domain. Empty domains are omitted.
 * `assistive_posture` is derived from the assembled domains.
 */
export function buildFrame(
  store: StateStore,
  domains: Domain[] = DOMAINS,
  now: number = Date.now(),
  privacy: Privacy = TIER_ZERO,
): ContextFrame {
  const quality: ContextQuality = {
    overall_freshness: "empty",
    domains: {},
    fields: {},
    stability: {
      screen_activity: screenActivityStability(store, now),
    },
  };
  const frame: ContextFrame = {
    spec: "context-frame/0.2",
    generated_at: new Date(now).toISOString(),
    staleness_ms: 0,
    privacy,
    assistive_posture: "unknown",
    quality,
  };

  let oldest = now;
  let included = 0;
  for (const domain of domains) {
    const observations = store
      .live(domain, now)
      .sort((a, b) => a.observedAt - b.observedAt);
    if (observations.length === 0) continue;

    let merged: Record<string, string | number | boolean> = {};
    const fieldQuality: Record<string, FieldQuality> = {};
    for (const obs of observations) {
      merged = { ...merged, ...obs.fields };
      for (const field of Object.keys(obs.fields)) {
        fieldQuality[field] = {
          source: obs.sensor,
          classification: fieldClassification(field),
          observed_at: new Date(obs.observedAt).toISOString(),
          staleness_ms: now - obs.observedAt,
        };
      }
      if (obs.observedAt < oldest) oldest = obs.observedAt;
    }
    frame[domain] = merged;
    included += observations.length;
    const domainStaleness = now - Math.min(...observations.map((obs) => obs.observedAt));
    quality.domains[domain] = {
      source_sensors: [...new Set(observations.map((obs) => obs.sensor))],
      observation_count: observations.length,
      staleness_ms: domainStaleness,
      freshness: freshnessFor(domainStaleness),
    };
    quality.fields[domain] = fieldQuality;
  }

  frame.staleness_ms = now - oldest;
  quality.overall_freshness = freshnessFor(frame.staleness_ms, included === 0);
  frame.assistive_posture = derivePosture(frame);
  return frame;
}
