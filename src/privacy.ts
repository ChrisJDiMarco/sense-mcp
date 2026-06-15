import type { CapabilityStatus, Privacy, Sensor } from "./types.js";

/** What the daemon knows about each sensor right now. */
export interface SensorStatus {
  /** Sensors whose available() passed — the platform supports them. */
  active: Set<string>;
  /** Sensors that produced ≥1 observation on their latest sample. */
  yielding: Set<string>;
}

/** Config toggles that gate higher-tier capabilities. */
export interface PrivacyConfig {
  isMac: boolean;
  /** Operator opted into raw (redacted) window titles — Tier 3. */
  rawTitles: boolean;
  /** Operator opted into explicit camera snapshot capture — Tier 3. */
  cameraSnapshot: boolean;
  /** Operator opted into explicit screen snapshot capture — Tier 3. */
  screenSnapshot: boolean;
}

/**
 * Capabilities the spec describes but this build does not implement yet.
 * Listing them as `unavailable` lets a client distinguish "no sensor here"
 * from "the user said no" — the whole point of the privacy block.
 */
const UNIMPLEMENTED: Array<[capability: string, tier: number]> = [
  ["camera_attention", 3],
];

const RAW_TITLES_TIER = 3;
const CAMERA_SNAPSHOT_TIER = 3;
const SCREEN_SNAPSHOT_TIER = 3;

function mergeStatus(
  current: CapabilityStatus | undefined,
  next: CapabilityStatus,
): CapabilityStatus {
  if (current === "granted" || next === "granted") return "granted";
  if (current === "denied" || next === "denied") return "denied";
  return "unavailable";
}

/**
 * Build the privacy block from sensor metadata + live status + config.
 *
 * Per-capability status:
 *   granted     — sensor active and producing data (permission effectively yes)
 *   denied      — sensor active but yielding nothing (proxy for OS permission
 *                 denial, e.g. macOS TCC), or an opt-in capability not enabled
 *   unavailable — no sensor for this capability on this platform
 *
 * tier = the highest tier among granted capabilities (Tier 0 is the floor;
 * the clock always works).
 */
export function computePrivacy(
  sensors: Sensor[],
  status: SensorStatus,
  config: PrivacyConfig,
): Privacy {
  const capabilities: Record<string, CapabilityStatus> = {};
  const capTier: Record<string, number> = {};

  for (const sensor of sensors) {
    if (!sensor.capability) continue;
    capTier[sensor.capability] = Math.max(capTier[sensor.capability] ?? 0, sensor.tier);
    const sensorStatus = status.yielding.has(sensor.name)
      ? "granted"
      : status.active.has(sensor.name)
        ? "denied"
        : "unavailable";
    capabilities[sensor.capability] = mergeStatus(capabilities[sensor.capability], sensorStatus);
  }

  // Raw window titles: a Tier-3 opt-in, not its own sensor.
  capTier.raw_window_titles = RAW_TITLES_TIER;
  capabilities.raw_window_titles = !config.isMac
    ? "unavailable"
    : !config.rawTitles
      ? "denied" // available on platform, but the user hasn't opted in
      : capabilities.screen_activity === "granted"
        ? "granted"
        : "denied";

  if ("camera_snapshot" in capabilities) {
    capTier.camera_snapshot = CAMERA_SNAPSHOT_TIER;
    capabilities.camera_snapshot =
      capabilities.camera_snapshot === "unavailable"
        ? "unavailable"
        : !config.cameraSnapshot
          ? "denied"
          : capabilities.camera_snapshot;
  }

  capTier.screen_snapshot = SCREEN_SNAPSHOT_TIER;
  capabilities.screen_snapshot = !config.isMac
    ? "unavailable"
    : config.screenSnapshot
      ? "granted"
      : "denied";

  for (const [capability, tier] of UNIMPLEMENTED) {
    if (capability in capabilities) continue;
    capTier[capability] = tier;
    capabilities[capability] = "unavailable";
  }

  let tier = 0;
  for (const [capability, value] of Object.entries(capabilities)) {
    if (value === "granted") tier = Math.max(tier, capTier[capability] ?? 0);
  }

  return { tier, capabilities };
}
