import type { Domain, Observation, Sensor, SensorDiagnostic, SensorHealth } from "./types.js";
import { StateStore } from "./state.js";
import type { SensorStatus } from "./privacy.js";

export interface DaemonOptions {
  startupTimeoutMs?: number;
  maxBackoffMs?: number;
  jitterRatio?: number;
  random?: () => number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

function abortedError(): Error {
  const error = new Error("Sensor operation aborted");
  error.name = "AbortError";
  return error;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Polls registered sensors on their own intervals and feeds the store.
 * Sensors that report unavailable at startup are skipped entirely.
 * Tracks per-sensor liveness so the privacy block can report capability status.
 */
export class Daemon {
  private timers = new Map<string, NodeJS.Timeout>();
  private inFlight = new Map<string, Promise<void>>();
  private refreshInFlight = new Map<string, Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private active = new Set<string>();
  private yielding = new Set<string>();
  private diagnostics = new Map<string, SensorDiagnostic>();
  private healthBySensor = new Map<string, SensorHealth>();
  private knownDomains = new Map<string, Set<Domain>>();
  private stopping = false;
  private readonly options: Required<DaemonOptions>;

  constructor(
    private readonly store: StateStore,
    private readonly sensors: Sensor[],
    options: DaemonOptions = {},
  ) {
    this.options = {
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      jitterRatio: Math.max(0, Math.min(0.5, options.jitterRatio ?? 0.1)),
      random: options.random ?? Math.random,
    };
    for (const sensor of sensors) {
      this.healthBySensor.set(sensor.name, this.initialHealth(sensor.name));
    }
  }

  async start(): Promise<string[]> {
    this.stopping = false;
    const initialPolls = this.sensors.map((sensor) =>
      sensor.samplingMode === "on_demand"
        ? this.runCycle(sensor, false, false)
        : this.runCycle(sensor, true),
    );
    await Promise.race([
      Promise.allSettled(initialPolls),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.options.startupTimeoutMs);
        timer.unref?.();
      }),
    ]);
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

  /** Detailed operational health, including failure/backoff and cadence counters. */
  health(): Map<string, SensorHealth> {
    return new Map(
      [...this.healthBySensor].map(([name, value]) => [
        name,
        {
          ...value,
          diagnostic: value.diagnostic ? { ...value.diagnostic } : undefined,
        },
      ]),
    );
  }

  /** Force a completion-coalesced refresh for sensors known to cover these domains. */
  async refreshDomains(
    domains: Domain[],
    mode: "if_stale" | "force" = "force",
    maxStalenessMs = 30_000,
  ): Promise<Domain[]> {
    if (this.stopping || domains.length === 0) return [];
    const requested = new Set(domains);
    const relevant = this.sensors.filter((sensor) => {
      const known = sensor.domains ?? [...(this.knownDomains.get(sensor.name) ?? [])];
      if (!known.some((domain) => requested.has(domain))) return false;
      if (mode === "force") return true;
      const lastSuccess = this.healthBySensor.get(sensor.name)?.last_success_at;
      return !lastSuccess || Date.now() - Date.parse(lastSuccess) > maxStalenessMs;
    });

    await Promise.all(relevant.map((sensor) => this.refreshSensor(sensor)));
    return domains.filter((domain) =>
      relevant.some((sensor) =>
        (sensor.domains ?? [...(this.knownDomains.get(sensor.name) ?? [])]).includes(domain),
      ),
    );
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.inFlight.values()]);
    await Promise.allSettled([...this.refreshInFlight.values()]);
    this.inFlight.clear();
    this.refreshInFlight.clear();
    this.controllers.clear();
    for (const [name, current] of this.healthBySensor) {
      this.healthBySensor.set(name, {
        ...current,
        state: "stopped",
        active: false,
        yielding: false,
        next_poll_in_ms: undefined,
      });
    }
  }

  private initialHealth(name: string): SensorHealth {
    return {
      name,
      state: "initializing",
      active: false,
      yielding: false,
      consecutive_failures: 0,
      availability_checks: 0,
      sample_count: 0,
    };
  }

  private runCycle(sensor: Sensor, scheduleNext: boolean, sample = true): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const existing = this.inFlight.get(sensor.name);
    if (existing) return existing;

    const controller = new AbortController();
    this.controllers.set(sensor.name, controller);
    const operation = this.pollSensor(sensor, controller.signal, sample)
      .catch(() => undefined)
      .finally(() => {
        this.inFlight.delete(sensor.name);
        this.controllers.delete(sensor.name);
        if (scheduleNext && !this.stopping) this.schedule(sensor);
      });
    this.inFlight.set(sensor.name, operation);
    return operation;
  }

  private async pollSensor(sensor: Sensor, signal: AbortSignal, shouldSample: boolean): Promise<void> {
    const startedAt = Date.now();
    const previous = this.healthBySensor.get(sensor.name) ?? this.initialHealth(sensor.name);
    this.healthBySensor.set(sensor.name, {
      ...previous,
      availability_checks: previous.availability_checks + 1,
      last_attempt_at: new Date(startedAt).toISOString(),
      next_poll_in_ms: undefined,
    });

    try {
      const available = sensor.available
        ? await abortable(Promise.resolve(sensor.available(signal)), signal)
        : true;
      if (!available) {
        this.active.delete(sensor.name);
        this.yielding.delete(sensor.name);
        const diagnostic = sensor.diagnose?.() ?? undefined;
        if (diagnostic) this.diagnostics.set(sensor.name, diagnostic);
        else this.diagnostics.delete(sensor.name);
        this.updateHealth(sensor.name, {
          state: "unavailable",
          active: false,
          yielding: false,
          consecutive_failures: 0,
          latency_ms: Date.now() - startedAt,
          diagnostic,
        });
        return;
      }

      this.active.add(sensor.name);
      if (!shouldSample) {
        const diagnostic = sensor.diagnose?.() ?? undefined;
        if (diagnostic) this.diagnostics.set(sensor.name, diagnostic);
        else this.diagnostics.delete(sensor.name);
        this.updateHealth(sensor.name, {
          state: "idle",
          active: true,
          yielding: false,
          consecutive_failures: 0,
          latency_ms: Date.now() - startedAt,
          diagnostic,
        });
        return;
      }
      const observations = await abortable(Promise.resolve(sensor.sample(signal)), signal);
      if (signal.aborted) return;
      this.rememberDomains(sensor, observations);
      this.store.ingest(observations);
      if (observations.length > 0) this.yielding.add(sensor.name);
      else this.yielding.delete(sensor.name);
      const diagnostic = sensor.diagnose?.() ?? undefined;
      if (diagnostic) this.diagnostics.set(sensor.name, diagnostic);
      else this.diagnostics.delete(sensor.name);
      const current = this.healthBySensor.get(sensor.name) ?? this.initialHealth(sensor.name);
      this.updateHealth(sensor.name, {
        state: diagnostic ? "degraded" : "healthy",
        active: true,
        yielding: observations.length > 0,
        consecutive_failures: 0,
        sample_count: current.sample_count + 1,
        last_success_at: new Date().toISOString(),
        latency_ms: Date.now() - startedAt,
        diagnostic,
      });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
      this.yielding.delete(sensor.name);
      const diagnostic: SensorDiagnostic = {
        reason: "sample_error",
        detail: "Sensor sample failed; Sense will retry with backoff.",
      };
      this.diagnostics.set(sensor.name, diagnostic);
      const current = this.healthBySensor.get(sensor.name) ?? this.initialHealth(sensor.name);
      this.updateHealth(sensor.name, {
        state: "backing_off",
        active: this.active.has(sensor.name),
        yielding: false,
        consecutive_failures: current.consecutive_failures + 1,
        latency_ms: Date.now() - startedAt,
        diagnostic,
      });
    }
  }

  private rememberDomains(sensor: Sensor, observations: Observation[]): void {
    const domains = new Set(this.knownDomains.get(sensor.name) ?? sensor.domains ?? []);
    for (const observation of observations) domains.add(observation.domain);
    this.knownDomains.set(sensor.name, domains);
  }

  private refreshSensor(sensor: Sensor): Promise<void> {
    const existing = this.refreshInFlight.get(sensor.name);
    if (existing) return existing;
    const refresh = (async () => {
      const timer = this.timers.get(sensor.name);
      if (timer) clearTimeout(timer);
      this.timers.delete(sensor.name);
      const current = this.inFlight.get(sensor.name);
      if (current) await current;
      const newlyScheduled = this.timers.get(sensor.name);
      if (newlyScheduled) clearTimeout(newlyScheduled);
      this.timers.delete(sensor.name);
      await this.runCycle(sensor, sensor.samplingMode !== "on_demand");
    })().finally(() => {
      this.refreshInFlight.delete(sensor.name);
    });
    this.refreshInFlight.set(sensor.name, refresh);
    return refresh;
  }

  private updateHealth(name: string, update: Partial<SensorHealth>): void {
    const current = this.healthBySensor.get(name) ?? this.initialHealth(name);
    this.healthBySensor.set(name, { ...current, ...update });
  }

  private schedule(sensor: Sensor): void {
    const current = this.healthBySensor.get(sensor.name) ?? this.initialHealth(sensor.name);
    const exponent = current.consecutive_failures;
    const base = Math.min(
      this.options.maxBackoffMs,
      sensor.intervalMs * (exponent > 0 ? 2 ** exponent : 1),
    );
    const spread = (this.options.random() * 2 - 1) * this.options.jitterRatio;
    const delay = Math.max(1, Math.round(base * (1 + spread)));
    this.updateHealth(sensor.name, { next_poll_in_ms: delay });
    const timer = setTimeout(() => {
      this.timers.delete(sensor.name);
      void this.runCycle(sensor, true);
    }, delay);
    timer.unref?.();
    this.timers.set(sensor.name, timer);
  }
}
