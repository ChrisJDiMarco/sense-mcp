import type { Observation, Sensor } from "../types.js";
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

/** Seconds since last keyboard/mouse input via IOKit HIDIdleTime. */
export const idleSensor: Sensor = {
  name: "idle",
  intervalMs: 10_000,
  tier: 1,
  domains: ["user"],
  capability: "presence",
  available: async () => isMac,
  async sample(signal): Promise<Observation[]> {
    const out = await run("ioreg", ["-c", "IOHIDSystem"], 3000, signal);
    if (!out) return [];

    const idleSeconds = parseIdleSeconds(out);
    if (idleSeconds === null) return [];

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
};
