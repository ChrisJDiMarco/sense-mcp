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
  private latest = new Map<string, Observation>();
  private historyLog: Observation[] = [];
  private timelineLog: TimelineEvent[] = [];

  ingest(observations: Observation[], now: number = Date.now()): void {
    for (const obs of observations) {
      if (obs.observedAt + obs.ttlMs <= now) continue; // dead on arrival
      this.latest = new Map(this.latest).set(obs.sensor, obs);
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
    const alive = new Map<string, Observation>();
    const result: Observation[] = [];
    for (const [key, obs] of this.latest) {
      if (obs.observedAt + obs.ttlMs <= now) continue;
      alive.set(key, obs);
      if (!domain || obs.domain === domain) result.push(obs);
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
