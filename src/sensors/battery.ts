import type { Observation, Sensor } from "../types.js";
import { isMac, run } from "./exec.js";

const TTL_MS = 60_000;

export type BatteryFields = Record<string, string | number | boolean>;

export function parsePmsetBattery(input: string): BatteryFields | null {
  const percent = input.match(/(\d+)%/)?.[1];
  if (!percent) return null;

  const batteryPercent = Number(percent);
  if (!Number.isFinite(batteryPercent)) return null;

  const source = input.includes("Battery Power")
    ? "battery"
    : input.includes("AC Power")
      ? "ac_power"
      : "unknown";

  return {
    battery_percent: batteryPercent,
    power_source: source,
    low_power: source === "battery" && batteryPercent <= 20,
  };
}

/** Battery and power context via pmset. Emits no device identifiers. */
export const batterySensor: Sensor = {
  name: "battery",
  intervalMs: 60_000,
  tier: 1,
  capability: "power",
  available: async () => isMac,
  async sample(): Promise<Observation[]> {
    const out = await run("pmset", ["-g", "batt"]);
    if (!out) return [];

    const fields = parsePmsetBattery(out);
    if (!fields) return [];

    return [
      {
        sensor: "battery",
        domain: "environment",
        fields,
        observedAt: Date.now(),
        ttlMs: TTL_MS,
      },
    ];
  },
};
