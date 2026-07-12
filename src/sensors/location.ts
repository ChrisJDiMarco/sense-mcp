import { policyEnabled } from "../policy.js";
import type { Observation, Sensor, SensorDiagnostic } from "../types.js";
import { isMac, run } from "./exec.js";

const TTL_MS = 120_000;

interface LocationConfig {
  home: string[];
  office: string[];
}

interface LocationDependencies {
  isMac: boolean;
  policyEnabled: () => Promise<boolean>;
  runCommand: (
    command: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<string | null>;
  env: Record<string, string | undefined>;
}

function listFromEnv(env: Record<string, string | undefined>, name: string): string[] {
  return (env[name] ?? "")
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

export function createLocationSensor(
  overrides: Partial<LocationDependencies> = {},
): Sensor {
  const dependencies: LocationDependencies = {
    isMac,
    policyEnabled: () => policyEnabled("location"),
    runCommand: run,
    env: process.env,
    ...overrides,
  };
  let diagnostic: SensorDiagnostic | null = null;

  return {
    name: "location",
    intervalMs: 120_000,
    tier: 2,
    capability: "location_class",
    domains: ["environment"],
    async available(): Promise<boolean> {
      const allowed = dependencies.isMac && (await dependencies.policyEnabled());
      diagnostic = allowed
        ? null
        : {
            reason: "disabled_by_policy",
            detail: "Wi-Fi location classification is disabled in the Sense policy.",
            fixHint: "Run sense-mcp enable location to allow coarse local classification.",
          };
      return allowed;
    },
    async sample(signal): Promise<Observation[]> {
      if (!(await dependencies.policyEnabled())) {
        diagnostic = {
          reason: "disabled_by_policy",
          detail: "Wi-Fi location classification is disabled in the Sense policy.",
          fixHint: "Run sense-mcp enable location to allow coarse local classification.",
        };
        return [];
      }
      const out = await dependencies.runCommand(
        "networksetup",
        ["-getairportnetwork", "en0"],
        3_000,
        signal,
      );
      if (!out) {
        diagnostic = {
          reason: "location_signal_unavailable",
          detail: "No local Wi-Fi classification signal is available.",
          fixHint: "Check Wi-Fi status or disable location classification in the Sense policy.",
        };
        return [];
      }

      const locationClass = classifyLocation(parseWifiNetwork(out), {
        home: listFromEnv(dependencies.env, "SENSE_HOME_WIFI_SSIDS"),
        office: listFromEnv(dependencies.env, "SENSE_OFFICE_WIFI_SSIDS"),
      });
      diagnostic = null;
      return [
        {
          sensor: "location",
          domain: "environment",
          fields: { location_class: locationClass },
          observedAt: Date.now(),
          ttlMs: TTL_MS,
        },
      ];
    },
    diagnose: () => diagnostic,
  };
}

/** Coarse, opt-in Wi-Fi classification. The SSID is never emitted. */
export const locationSensor = createLocationSensor();
