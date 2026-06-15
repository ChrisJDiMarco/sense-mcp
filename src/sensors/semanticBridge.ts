import { access, readFile } from "node:fs/promises";
import type { Domain, Observation, Sensor } from "../types.js";

const TTL_MS = 60_000;

type Primitive = string | number | boolean;

interface BridgeConfig {
  name: string;
  envPath: string;
  capability: string;
  domain: Domain;
  allowedFields: Set<string>;
}

const HEALTH_FIELDS = new Set([
  "readiness_class",
  "recovery_class",
  "stress_class",
  "sleep_debt",
  "readiness_score",
]);

const WEATHER_FIELDS = new Set([
  "weather_class",
  "temperature_f",
  "precipitation_class",
  "wind_class",
  "uv_class",
  "daylight_class",
]);

function isPrimitive(value: unknown): value is Primitive {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

async function readBridgeFields(config: BridgeConfig): Promise<Record<string, Primitive> | null> {
  const file = process.env[config.envPath];
  if (!file) return null;

  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const fields: Record<string, Primitive> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (config.allowedFields.has(key) && isPrimitive(value)) fields[key] = value;
    }
    return Object.keys(fields).length > 0 ? fields : null;
  } catch {
    return null;
  }
}

function bridgeSensor(config: BridgeConfig): Sensor {
  return {
    name: config.name,
    intervalMs: 60_000,
    tier: 2,
    capability: config.capability,
    available: async () => {
      const file = process.env[config.envPath];
      if (!file) return false;
      try {
        await access(file);
        return true;
      } catch {
        return false;
      }
    },
    async sample(): Promise<Observation[]> {
      const fields = await readBridgeFields(config);
      if (!fields) return [];

      return [
        {
          sensor: config.name,
          domain: config.domain,
          fields,
          observedAt: Date.now(),
          ttlMs: TTL_MS,
        },
      ];
    },
  };
}

/** Optional local semantic bridge for Oura/Whoop/Health exports. */
export const healthBridgeSensor = bridgeSensor({
  name: "health-bridge",
  envPath: "SENSE_HEALTH_CONTEXT_PATH",
  capability: "health_context",
  domain: "user",
  allowedFields: HEALTH_FIELDS,
});

/** Optional local semantic bridge for weather/daylight summaries. */
export const weatherBridgeSensor = bridgeSensor({
  name: "weather-bridge",
  envPath: "SENSE_WEATHER_CONTEXT_PATH",
  capability: "weather",
  domain: "environment",
  allowedFields: WEATHER_FIELDS,
});
