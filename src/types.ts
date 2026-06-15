/** Core types for sense-mcp. Mirrors SPEC.md (context-frame/0.2). */

export type Domain = "screen" | "user" | "environment" | "schedule";
export type FieldClassification = "observed" | "classified" | "derived" | "summary";
export type Freshness = "empty" | "fresh" | "aging" | "stale";
export type Stability = "stable" | "recent_transition" | "unknown";

/** Consent status for a single capability. */
export type CapabilityStatus = "granted" | "denied" | "unavailable";

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

/** The plugin interface. Implement this, register it, done. */
export interface Sensor {
  name: string;
  intervalMs: number;
  /** Privacy tier this sensor belongs to (0=clock .. 3=attention). */
  tier: number;
  /**
   * Permission-gated capability this sensor provides, if any. Used to build
   * the frame's privacy block. Tier-0 (pure) sensors omit it.
   */
  capability?: string;
  /** Return [] when unavailable or on error. Never throw past this boundary. */
  sample(): Promise<Observation[]>;
  /** Optional platform gate, checked once at startup. */
  available?(): Promise<boolean>;
}

/** Consent tier + per-capability status. Required on every frame. */
export interface Privacy {
  tier: number;
  capabilities: Record<string, CapabilityStatus>;
}

export interface ContextFrame {
  spec: "context-frame/0.2";
  generated_at: string;
  staleness_ms: number;
  privacy: Privacy;
  assistive_posture: AssistivePosture;
  quality?: ContextQuality;
  screen?: Record<string, string | number | boolean>;
  user?: Record<string, string | number | boolean>;
  environment?: Record<string, string | number | boolean>;
  schedule?: Record<string, string | number | boolean>;
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
