import type { Observation, Sensor } from "../types.js";
import { isMac, run } from "./exec.js";

const TTL_MS = 120_000;

interface LocationConfig {
  home: string[];
  office: string[];
}

function listFromEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function parseWifiNetwork(output: string): string | null {
  const match = output.match(/Current Wi-Fi Network:\s*(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

export function classifyLocation(ssid: string | null, config: LocationConfig): string {
  if (!ssid) return "unknown";

  const normalized = normalize(ssid);
  if (config.home.map(normalize).includes(normalized)) return "home_office";
  if (config.office.map(normalize).includes(normalized)) return "office";
  if (/cafe|coffee|starbucks|la colombe|wifi|guest/.test(normalized)) return "cafe";
  return "unknown";
}

/** Coarse location class from Wi-Fi classification. The SSID is never emitted. */
export const locationSensor: Sensor = {
  name: "location",
  intervalMs: 120_000,
  tier: 2,
  capability: "location_class",
  available: async () => isMac,
  async sample(): Promise<Observation[]> {
    const out = await run("networksetup", ["-getairportnetwork", "en0"], 3000);
    if (!out) return [];

    const locationClass = classifyLocation(parseWifiNetwork(out), {
      home: listFromEnv("SENSE_HOME_WIFI_SSIDS"),
      office: listFromEnv("SENSE_OFFICE_WIFI_SSIDS"),
    });

    return [
      {
        sensor: "location",
        domain: "environment",
        fields: {
          location_class: locationClass,
        },
        observedAt: Date.now(),
        ttlMs: TTL_MS,
      },
    ];
  },
};
