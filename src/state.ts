import type { Domain, Observation, TimelineEvent } from "./types.js";

const HISTORY_WINDOW_MS = 5 * 60 * 1000;
const TIMELINE_WINDOW_MS = 90 * 60 * 1000;
const MAX_TIMELINE_EVENTS = 240;

function semanticValue(value: unknown): string | number | boolean | undefined {
  if (value === "unknown" || value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.length === 0) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function safeTimelineLabel(obs: Observation): string | null {
  const fields = obs.fields;

  if (obs.domain === "screen") {
    const activity = semanticValue(fields.activity_class);
    const workspace = semanticValue(fields.workspace_name);
    const dirty = semanticValue(fields.git_dirty_count);
    if (workspace && activity) return `Working in ${workspace} (${activity})`;
    if (workspace) return `Workspace ${workspace} active`;
    if (activity) return `Activity looks like ${activity}`;
    if (typeof dirty === "number") return `Workspace has ${dirty} changed items`;
  }

  if (obs.domain === "user") {
    const focus = semanticValue(fields.focus_mode);
    const presence = semanticValue(fields.presence);
    const cadence = semanticValue(fields.input_cadence);
    if (focus) return `Focus mode ${focus}`;
    if (presence) return `Presence ${presence}`;
    if (cadence) return `Input cadence ${cadence}`;
  }

  if (obs.domain === "environment") {
    const power = semanticValue(fields.power_source);
    const displays = semanticValue(fields.external_display_count);
    const noise = semanticValue(fields.noise_class);
    const lighting = semanticValue(fields.lighting);
    const media = semanticValue(fields.media_playback);
    if (power) return `Power ${power}`;
    if (displays !== undefined) {
      return `${displays} external displays`;
    }
    if (noise) return `Noise ${noise}`;
    if (lighting) return `Lighting ${lighting}`;
    if (media) return `Media ${media}`;
  }

  if (obs.domain === "schedule") {
    const pressure = semanticValue(fields.time_pressure);
    if (pressure) return `Schedule pressure ${pressure}`;
    if (fields.in_meeting !== undefined) return fields.in_meeting ? "In meeting" : "Not in meeting";
  }

  return null;
}

/**
 * Rolling in-memory state store. Holds the latest observation per sensor.
 * Expired observations are dropped on read. Nothing is ever persisted.
 */
export class StateStore {
  /** Latest field readings per sensor+domain, preserving each field's own expiry. */
  private latest = new Map<
    string,
    {
      sensor: string;
      domain: Domain;
      fields: Map<string, { value: string | number | boolean; observedAt: number; expiresAt: number }>;
    }
  >();
  private historyLog: Observation[] = [];
  private timelineLog: TimelineEvent[] = [];

  ingest(observations: Observation[], now: number = Date.now()): void {
    for (const obs of observations) {
      if (obs.observedAt + obs.ttlMs <= now) continue; // dead on arrival
      const key = `${obs.sensor}\u0000${obs.domain}`;
      const previous = this.latest.get(key);
      const fields = new Map(previous?.fields ?? []);
      for (const [field, value] of Object.entries(obs.fields)) {
        const current = fields.get(field);
        if (current && current.observedAt > obs.observedAt) continue;
        fields.set(field, {
          value,
          observedAt: obs.observedAt,
          expiresAt: obs.observedAt + obs.ttlMs,
        });
      }
      this.latest = new Map(this.latest).set(key, {
        sensor: obs.sensor,
        domain: obs.domain,
        fields,
      });
      this.historyLog = [...this.historyLog, obs];
      const label = safeTimelineLabel(obs);
      if (label) {
        const previous = this.timelineLog[this.timelineLog.length - 1];
        if (!previous || previous.label !== label || now - previous.observedAt > 60_000) {
          this.timelineLog = [
            ...this.timelineLog,
            {
              observedAt: obs.observedAt,
              domain: obs.domain,
              sensor: obs.sensor,
              label,
            },
          ].slice(-MAX_TIMELINE_EVENTS);
        }
      }
    }
    this.pruneHistory(now);
  }

  /** Live observations, optionally filtered by domain. Prunes expired. */
  live(domain?: Domain, now: number = Date.now()): Observation[] {
    const alive = new Map<string, (typeof this.latest extends Map<string, infer V> ? V : never)>();
    const result: Observation[] = [];
    for (const [key, reading] of this.latest) {
      const fields = new Map(
        [...reading.fields].filter(([, field]) => field.expiresAt > now),
      );
      if (fields.size === 0) continue;
      const next = { ...reading, fields };
      alive.set(key, next);
      if (!domain || reading.domain === domain) {
        const values: Record<string, string | number | boolean> = {};
        let oldest = now;
        let earliestExpiry = Number.POSITIVE_INFINITY;
        for (const [field, value] of fields) {
          values[field] = value.value;
          oldest = Math.min(oldest, value.observedAt);
          earliestExpiry = Math.min(earliestExpiry, value.expiresAt);
        }
        result.push({
          sensor: reading.sensor,
          domain: reading.domain,
          fields: values,
          observedAt: oldest,
          ttlMs: Math.max(1, earliestExpiry - oldest),
        });
      }
    }
    this.latest = alive;
    this.pruneHistory(now);
    return result;
  }

  /** Recent live-ish observations used only for smoothing and provenance. */
  history(domain?: Domain, now: number = Date.now(), windowMs = 60_000): Observation[] {
    this.pruneHistory(now);
    return this.historyLog
      .filter((obs) => now - obs.observedAt <= windowMs)
      .filter((obs) => obs.observedAt + obs.ttlMs > now)
      .filter((obs) => !domain || obs.domain === domain)
      .sort((a, b) => a.observedAt - b.observedAt);
  }

  /** Privacy-safe semantic timeline. In-memory only; no raw titles or content. */
  timeline(now: number = Date.now(), windowMs = 30 * 60 * 1000): TimelineEvent[] {
    this.pruneHistory(now);
    return this.timelineLog
      .filter((event) => now - event.observedAt <= windowMs)
      .sort((a, b) => a.observedAt - b.observedAt);
  }

  /** Immediately forget all cached and historical data from a revoked sensor. */
  removeSensor(sensor: string): void {
    this.latest = new Map([...this.latest].filter(([, reading]) => reading.sensor !== sensor));
    this.historyLog = this.historyLog.filter((observation) => observation.sensor !== sensor);
    this.timelineLog = this.timelineLog.filter((event) => event.sensor !== sensor);
  }

  /** Immediately forget one field while retaining the sensor's non-sensitive fields. */
  removeSensorField(sensor: string, field: string): void {
    const latest = new Map(this.latest);
    for (const [key, reading] of latest) {
      if (reading.sensor !== sensor || !reading.fields.has(field)) continue;
      const fields = new Map(reading.fields);
      fields.delete(field);
      if (fields.size === 0) latest.delete(key);
      else latest.set(key, { ...reading, fields });
    }
    this.latest = latest;
    this.historyLog = this.historyLog
      .map((observation) => {
        if (observation.sensor !== sensor || !(field in observation.fields)) return observation;
        const fields = { ...observation.fields };
        delete fields[field];
        return { ...observation, fields };
      })
      .filter((observation) => Object.keys(observation.fields).length > 0);
  }

  clear(): void {
    this.latest = new Map();
    this.historyLog = [];
    this.timelineLog = [];
  }

  private pruneHistory(now: number): void {
    this.historyLog = this.historyLog.filter(
      (obs) => now - obs.observedAt <= HISTORY_WINDOW_MS && obs.observedAt + obs.ttlMs > now,
    );
    this.timelineLog = this.timelineLog.filter((event) => now - event.observedAt <= TIMELINE_WINDOW_MS);
  }
}
