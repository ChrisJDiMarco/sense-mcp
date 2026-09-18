import type { Observation, Sensor, SensorDiagnostic } from "../types.js";
import { isMac, run } from "./exec.js";

const TTL_MS = 20_000;
const IDLE_THRESHOLD_S = 60;
const AWAY_THRESHOLD_S = 300;

export function parseIdleSeconds(output: string): number | null {
  const nanoseconds = output.match(/"?HIDIdleTime"?\s*=\s*(\d+)/)?.[1];
  if (!nanoseconds) return null;
  const seconds = Number(nanoseconds) / 1_000_000_000;
  return Number.isFinite(seconds) ? Math.round(seconds) : null;
}

function presenceFor(idleSeconds: number): string {
  if (idleSeconds >= AWAY_THRESHOLD_S) return "away";
  if (idleSeconds >= IDLE_THRESHOLD_S) return "idle";
  return "active";
}

function cadenceFor(idleSeconds: number): string {
  if (idleSeconds < 2) return "steady";
  if (idleSeconds < 30) return "sparse";
  return "none";
}

export interface IdleDependencies {
  isMac: boolean;
  runCommand: typeof run;
}

/**
 * Seconds since last keyboard/mouse input via IOKit HIDIdleTime.
 *
 * `-r -d 1` keeps the dump to the IOHIDSystem entry itself. An unrestricted
 * `ioreg -c IOHIDSystem` walks the whole registry — hundreds of kilobytes on a
 * normal Mac — and silently overruns the exec buffer, which cost this sensor
 * every sample. The ambient-light sensor uses the same flag form.
 */
export function createIdleSensor(
  dependencies: IdleDependencies = { isMac, runCommand: run },
): Sensor {
  let diagnostic: SensorDiagnostic | null = null;

  return {
    name: "idle",
    intervalMs: 10_000,
    tier: 1,
    domains: ["user"],
    capability: "presence",
    available: async () => dependencies.isMac,
    async sample(signal): Promise<Observation[]> {
      const out = await dependencies.runCommand(
        "ioreg",
        ["-r", "-c", "IOHIDSystem", "-d", "1"],
        3000,
        signal,
      );
      if (!out) {
        diagnostic = {
          reason: "idle_signal_unavailable",
          detail: "macOS returned no IOHIDSystem registry entry, so presence is unknown.",
          fixHint: "Check that ioreg runs from this shell; presence and input cadence stay absent until it does.",
        };
        return [];
      }

      const idleSeconds = parseIdleSeconds(out);
      if (idleSeconds === null) {
        diagnostic = {
          reason: "idle_parse_failed",
          detail: "The IOHIDSystem entry carried no HIDIdleTime value.",
          fixHint: "Presence and input cadence stay absent rather than being guessed.",
        };
        return [];
      }
      diagnostic = null;

      return [
        {
          sensor: "idle",
          domain: "user",
          fields: {
            idle_seconds: idleSeconds,
            presence: presenceFor(idleSeconds),
            input_cadence: cadenceFor(idleSeconds),
          },
          observedAt: Date.now(),
          ttlMs: TTL_MS,
        },
      ];
    },
    diagnose: () => diagnostic,
  };
}

export const idleSensor: Sensor = createIdleSensor();
