import type { Observation, Sensor } from "../types.js";
import { isMac, run } from "./exec.js";

const TTL_MS = 30_000;

export function parseAmbientLight(output: string): number | null {
  const match = output.match(/"?(?:ALSValue|AmbientLightSensor)"?\s*=\s*(\d+)/i);
  if (!match) return null;

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function classifyAmbientLight(value: number | null): string {
  if (value === null) return "unknown";
  if (value < 5) return "dark";
  if (value < 40) return "dim";
  if (value < 250) return "normal";
  return "bright";
}

/** Ambient light sensor, when macOS exposes one. Emits brightness class only. */
export const ambientLightSensor: Sensor = {
  name: "ambient-light",
  intervalMs: 30_000,
  tier: 2,
  capability: "ambient_light",
  available: async () => isMac,
  async sample(): Promise<Observation[]> {
    const out = await run("ioreg", ["-r", "-c", "AppleLMUController", "-d", "1"], 3000);
    if (!out) return [];

    const value = parseAmbientLight(out);
    if (value === null) return [];

    return [
      {
        sensor: "ambient-light",
        domain: "environment",
        fields: {
          lighting: classifyAmbientLight(value),
          ambient_light_value: value,
        },
        observedAt: Date.now(),
        ttlMs: TTL_MS,
      },
    ];
  },
};
