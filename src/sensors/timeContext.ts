import type { Observation, Sensor } from "../types.js";

const TTL_MS = 120_000;

function daySegment(hour: number): string {
  if (hour < 5) return "late_night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";
  return "night";
}

function daylightClass(hour: number): string {
  if (hour < 6 || hour >= 21) return "dark";
  if (hour < 8 || hour >= 19) return "low_light";
  return "daylight";
}

/** Pure local-time context (Tier 0). Works on every platform, no permissions. */
export const timeContextSensor: Sensor = {
  name: "time-context",
  intervalMs: 60_000,
  tier: 0,
  async sample(): Promise<Observation[]> {
    const now = new Date();
    const day = now.getDay();
    return [
      {
        sensor: "time-context",
        domain: "environment",
        fields: {
          local_time: now.toTimeString().slice(0, 5),
          day_segment: daySegment(now.getHours()),
          daylight_class: daylightClass(now.getHours()),
          is_workday: day >= 1 && day <= 5,
        },
        observedAt: Date.now(),
        ttlMs: TTL_MS,
      },
    ];
  },
};
