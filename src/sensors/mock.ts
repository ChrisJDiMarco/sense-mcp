import type { Observation, Sensor } from "../types.js";

/**
 * Deterministic mock sensor for tests and non-macOS smoke runs.
 * Enabled when SENSE_MOCK=1.
 */
export const mockSensor: Sensor = {
  name: "mock",
  intervalMs: 5_000,
  tier: 1,
  capability: "screen_activity",
  available: async () => process.env.SENSE_MOCK === "1",
  async sample(): Promise<Observation[]> {
    const now = Date.now();
    return [
      {
        sensor: "mock-screen",
        domain: "screen",
        fields: {
          active_app: "Figma",
          active_window_label: "design file",
          activity_class: "designing",
        },
        observedAt: now,
        ttlMs: 30_000,
      },
      {
        sensor: "mock-user",
        domain: "user",
        fields: { presence: "active", idle_seconds: 3, input_cadence: "steady" },
        observedAt: now,
        ttlMs: 30_000,
      },
    ];
  },
};
