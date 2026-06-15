import type { Domain, Observation } from "./types.js";

/**
 * Rolling in-memory state store. Holds the latest observation per sensor.
 * Expired observations are dropped on read. Nothing is ever persisted.
 */
export class StateStore {
  private latest = new Map<string, Observation>();

  ingest(observations: Observation[], now: number = Date.now()): void {
    for (const obs of observations) {
      if (obs.observedAt + obs.ttlMs <= now) continue; // dead on arrival
      this.latest = new Map(this.latest).set(obs.sensor, obs);
    }
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
    return result;
  }

  clear(): void {
    this.latest = new Map();
  }
}
