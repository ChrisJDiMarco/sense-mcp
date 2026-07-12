/** Core types for sense-mcp. Mirrors SPEC.md (context-frame/0.2). */

export type Domain = "screen" | "user" | "environment" | "schedule";
export type FieldClassification = "observed" | "classified" | "derived" | "summary";
export type Freshness = "empty" | "fresh" | "aging" | "stale";
export type Stability = "stable" | "recent_transition" | "unknown";
export type SituationConfidence = "high" | "medium" | "low" | "unknown";

/** Consent status for a single capability. */
export type CapabilityStatus = "granted" | "denied" | "unavailable";

/** Operational state, kept separate from the compatibility consent status. */
export type CapabilityOperationalState =
  | "disabled"
  | "unavailable"
  | "permission_denied"
  | "no_signal"
  | "degraded"
  | "stale"
  | "healthy";

export interface CapabilityDetail {
  sensor: string;
  state: CapabilityOperationalState;
  reason: string;
  detail: string;
  fix_hint?: string;
}

export interface SensorDiagnostic {
  reason: string;
  detail: string;
  fixHint?: string;
}

export type SensorHealthState =
  | "initializing"
  | "idle"
  | "healthy"
  | "degraded"
  | "unavailable"
  | "backing_off"
  | "stopped";

/** Live scheduler state for one sensor. This is operational metadata, not context. */
export interface SensorHealth {
  name: string;
  state: SensorHealthState;
  active: boolean;
  yielding: boolean;
  consecutive_failures: number;
  availability_checks: number;
  sample_count: number;
  last_attempt_at?: string;
  last_success_at?: string;
  latency_ms?: number;
  next_poll_in_ms?: number;
  diagnostic?: SensorDiagnostic;
}

/** Derived hint: what kind of help fits the moment. */
export type AssistivePosture =
  | "available"
  | "lightly_available"
  | "do_not_interrupt"
  | "urgent_only"
  | "unknown";

/** A single semantic reading emitted by a sensor. Ephemeral by design. */
export interface Observation {
  sensor: string;
  domain: Domain;
  fields: Record<string, string | number | boolean>;
  observedAt: number; // epoch ms
  ttlMs: number;
}

export interface TimelineEvent {
  observedAt: number;
  domain: Domain;
  sensor: string;
  label: string;
}

/** The plugin interface. Implement this, register it, done. */
export interface Sensor {
  name: string;
  intervalMs: number;
  /** Privacy tier this sensor belongs to (0=clock .. 3=attention). */
  tier: number;
  /** Domains this sensor can refresh. Older sensors may omit this metadata. */
  domains?: Domain[];
  /** On-demand sensors are sampled only by an explicit domain refresh. */
  samplingMode?: "background" | "on_demand";
  /**
   * Permission-gated capability this sensor provides, if any. Used to build
   * the frame's privacy block. Tier-0 (pure) sensors omit it.
   */
  capability?: string;
  /** Return [] when unavailable or on error. Never throw past this boundary. */
  sample(signal?: AbortSignal): Promise<Observation[]>;
  /** Optional dynamic platform/capability gate, re-checked throughout the lifecycle. */
  available?(signal?: AbortSignal): Promise<boolean>;
  /** Optional latest diagnostic when a sensor is active but not yielding. */
  diagnose?(): SensorDiagnostic | null;
}

/** Consent tier + per-capability status. Required on every frame. */
export interface Privacy {
  tier: number;
  capabilities: Record<string, CapabilityStatus>;
  capability_states?: Record<string, CapabilityOperationalState>;
  capability_details?: Record<string, CapabilityDetail>;
}

export interface ContextFrame {
  spec: "context-frame/0.2";
  generated_at: string;
  staleness_ms: number;
  privacy: Privacy;
  assistive_posture: AssistivePosture;
  situation?: SituationSummary;
  quality?: ContextQuality;
  screen?: Record<string, string | number | boolean>;
  user?: Record<string, string | number | boolean>;
  environment?: Record<string, string | number | boolean>;
  schedule?: Record<string, string | number | boolean>;
}

export interface SituationSummary {
  summary: string;
  confidence: SituationConfidence;
  evidence: string[];
  unknowns: string[];
  risks: string[];
  recommendations: string[];
  recent_changes: string[];
}

export interface FieldQuality {
  source: string;
  classification: FieldClassification;
  observed_at: string;
  staleness_ms: number;
}

export interface DomainQuality {
  source_sensors: string[];
  observation_count: number;
  staleness_ms: number;
  freshness: Freshness;
}

export interface ContextQuality {
  overall_freshness: Freshness;
  domains: Partial<Record<Domain, DomainQuality>>;
  fields: Partial<Record<Domain, Record<string, FieldQuality>>>;
  stability: {
    screen_activity: Stability;
  };
}
