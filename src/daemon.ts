import type { Sensor, SensorDiagnostic } from "./types.js";
import { StateStore } from "./state.js";
import type { SensorStatus } from "./privacy.js";

/**
 * Polls registered sensors on their own intervals and feeds the store.
 * Sensors that report unavailable at startup are skipped entirely.
 * Tracks per-sensor liveness so the privacy block can report capability status.
 */
export class Daemon {
  private timers: NodeJS.Timeout[] = [];
  private active = new Set<string>();
  private yielding = new Set<string>();
  private diagnostics = new Map<string, SensorDiagnostic>();

  constructor(
    private readonly store: StateStore,
    private readonly sensors: Sensor[],
  ) {}

  async start(): Promise<string[]> {
    for (const sensor of this.sensors) {
      const ok = sensor.available ? await sensor.available() : true;
      if (!ok) continue;
      this.active.add(sensor.name);

      const poll = async () => {
        try {
          const observations = await sensor.sample();
          if (observations.length > 0) this.yielding.add(sensor.name);
          else this.yielding.delete(sensor.name);
          const diagnostic = sensor.diagnose?.();
          if (diagnostic) this.diagnostics.set(sensor.name, diagnostic);
          else this.diagnostics.delete(sensor.name);
          this.store.ingest(observations);
        } catch {
          // Sensors must fail silent; a broken sensor never kills the daemon.
          this.yielding.delete(sensor.name);
          this.diagnostics.set(sensor.name, {
            reason: "sample_error",
            detail: "Sensor sample failed; Sense will retry on the next interval.",
          });
        }
      };
      void poll(); // prime immediately
      const timer = setInterval(poll, sensor.intervalMs);
      timer.unref?.();
      this.timers.push(timer);
    }
    return [...this.active];
  }

  /** Snapshot of which sensors are platform-available and currently yielding. */
  status(): SensorStatus {
    return {
      active: new Set(this.active),
      yielding: new Set(this.yielding),
      diagnostics: new Map(this.diagnostics),
    };
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}
