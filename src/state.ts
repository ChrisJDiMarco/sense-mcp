import type { Domain, Observation } from "./types.js";

const HISTORY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Rolling in-memory state store. Holds the latest observation per sensor.
 * Expired observations are dropped on read. Nothing is ever persisted.
 */
export class StateStore {
  private latest = new Map<string, Observation>();
  private historyLog: Observation[] = [];

  ingest(observations: Observation[], now: number = Date.now()): void {
    for (const obs of observations) {
      if (obs.observedAt + obs.ttlMs <= now) continue; // dead on arrival
      this.latest = new Map(this.latest).set(obs.sensor, obs);
      this.historyLog = [...this.historyLog, obs];
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

  clear(): void {
    this.latest = new Map();
    this.historyLog = [];
  }

  private pruneHistory(now: number): void {
    this.historyLog = this.historyLog.filter(
      (obs) => now - obs.observedAt <= HISTORY_WINDOW_MS && obs.observedAt + obs.ttlMs > now,
    );
  }
}
