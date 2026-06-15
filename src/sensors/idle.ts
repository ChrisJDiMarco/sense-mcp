import type { Observation, Sensor } from "../types.js";
import { isMac, run } from "./exec.js";

const TTL_MS = 20_000;
const IDLE_THRESHOLD_S = 60;
const AWAY_THRESHOLD_S = 300;

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
  capability: "presence",
  available: async () => isMac,
  async sample(): Promise<Observation[]> {
    const out = await run("sh", [
      "-c",
      "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1000000000; exit}'",
    ]);
    if (out === null || out === "") return [];

    const idleSeconds = Math.round(Number(out));
    if (!Number.isFinite(idleSeconds)) return [];

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
