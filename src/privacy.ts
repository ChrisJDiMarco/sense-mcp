import type {
  CapabilityDetail,
  CapabilityOperationalState,
  CapabilityStatus,
  Privacy,
  Sensor,
  SensorDiagnostic,
} from "./types.js";
import type { StateStore } from "./state.js";

/** What the daemon knows about each sensor right now. */
export interface SensorStatus {
  /** Sensors whose available() passed — the platform supports them. */
  active: Set<string>;
  /** Sensors that produced ≥1 observation on their latest sample. */
  yielding: Set<string>;
  /** Latest diagnostic for active sensors that are not producing observations. */
  diagnostics?: Map<string, SensorDiagnostic>;
}

/** Config toggles that gate higher-tier capabilities. */
export interface PrivacyConfig {
  isMac: boolean;
  /** Policy gates for semantic sensors whose cached fields must disappear on revocation. */
  calendar?: boolean;
  location?: boolean;
  micLevel?: boolean;
  /** Operator opted into raw (redacted) window titles — Tier 3. */
  rawTitles: boolean;
  /** Operator opted into explicit camera snapshot capture — Tier 3. */
  cameraSnapshot: boolean;
  /** Operator opted into explicit screen snapshot capture — Tier 3. */
  screenSnapshot: boolean;
  /** Safer app-window capture policy. Falls back to screenSnapshot for compatibility. */
  windowSnapshot?: boolean;
  /** Separate higher-risk main-display capture policy. */
  fullScreenSnapshot?: boolean;
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
const FULL_SCREEN_SNAPSHOT_TIER = 3;

const STATE_RANK: Record<CapabilityOperationalState, number> = {
  unavailable: 0,
  disabled: 1,
  permission_denied: 2,
  no_signal: 3,
  degraded: 4,
  stale: 5,
  healthy: 6,
};

function mergeState(
  current: CapabilityOperationalState | undefined,
  next: CapabilityOperationalState,
): CapabilityOperationalState {
  return !current || STATE_RANK[next] > STATE_RANK[current] ? next : current;
}

function operationalState(
  active: boolean,
  yielding: boolean,
  diagnostic?: SensorDiagnostic,
): CapabilityOperationalState {
  if (yielding) return "healthy";
  const reason = diagnostic?.reason.toLowerCase() ?? "";
  if (reason.includes("disabled")) return "disabled";
  if (reason.includes("permission") || reason.includes("denied")) return "permission_denied";
  if (reason.includes("stale") || reason.includes("expired")) return "stale";
  if (reason.includes("no_signal") || reason.includes("no_data") || reason.includes("empty")) {
    return "no_signal";
  }
  if (!active) return "unavailable";
  if (
    reason.includes("error") ||
    reason.includes("failed") ||
    reason.includes("timeout") ||
    reason.includes("parse") ||
    reason.includes("missing") ||
    reason.includes("unavailable") ||
    reason.includes("not_exposed")
  ) {
    return "degraded";
  }
  return "no_signal";
}

function compatibilityStatus(state: CapabilityOperationalState): CapabilityStatus {
  if (state === "unavailable") return "unavailable";
  if (state === "disabled" || state === "permission_denied") return "denied";
  return "granted";
}

function applyPolicyGate(
  capability: string,
  enabled: boolean | undefined,
  capabilities: Record<string, CapabilityStatus>,
  states: Record<string, CapabilityOperationalState>,
): void {
  if (enabled !== false || !(capability in states) || states[capability] === "unavailable") return;
  states[capability] = "disabled";
  capabilities[capability] = "denied";
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
  const capabilityStates: Record<string, CapabilityOperationalState> = {};
  const capabilityDetails: Record<string, CapabilityDetail> = {};
  const capTier: Record<string, number> = {};

  for (const sensor of sensors) {
    if (!sensor.capability) continue;
    capTier[sensor.capability] = Math.max(capTier[sensor.capability] ?? 0, sensor.tier);
    const diagnostic = status.diagnostics?.get(sensor.name);
    const nextState = operationalState(
      status.active.has(sensor.name),
      status.yielding.has(sensor.name),
      diagnostic,
    );
    const currentState = capabilityStates[sensor.capability];
    const selectedState = mergeState(currentState, nextState);
    capabilityStates[sensor.capability] = selectedState;
    capabilities[sensor.capability] = compatibilityStatus(capabilityStates[sensor.capability]);
    const selectedThisSensor = !currentState || selectedState !== currentState;
    if (selectedState === "healthy") {
      delete capabilityDetails[sensor.capability];
    } else if (
      diagnostic &&
      nextState === selectedState &&
      (selectedThisSensor || !capabilityDetails[sensor.capability])
    ) {
      capabilityDetails[sensor.capability] = {
        sensor: sensor.name,
        state: nextState,
        reason: diagnostic.reason,
        detail: diagnostic.detail,
        fix_hint: diagnostic.fixHint,
      };
    }
  }

  // Raw window titles: a Tier-3 opt-in, not its own sensor.
  capTier.raw_window_titles = RAW_TITLES_TIER;
  capabilityStates.raw_window_titles = !config.isMac
    ? "unavailable"
    : !config.rawTitles
      ? "disabled"
      : capabilityStates.screen_activity ?? "unavailable";
  capabilities.raw_window_titles = compatibilityStatus(capabilityStates.raw_window_titles);

  if ("camera_snapshot" in capabilities) {
    capTier.camera_snapshot = CAMERA_SNAPSHOT_TIER;
    if (!config.cameraSnapshot && capabilityStates.camera_snapshot !== "unavailable") {
      capabilityStates.camera_snapshot = "disabled";
    }
    capabilities.camera_snapshot = compatibilityStatus(capabilityStates.camera_snapshot);
  }

  applyPolicyGate("calendar", config.calendar, capabilities, capabilityStates);
  applyPolicyGate("location_class", config.location, capabilities, capabilityStates);
  applyPolicyGate("microphone_level", config.micLevel, capabilities, capabilityStates);

  capTier.screen_snapshot = SCREEN_SNAPSHOT_TIER;
  const windowSnapshot = config.windowSnapshot ?? config.screenSnapshot;
  capabilityStates.screen_snapshot = !config.isMac
    ? "unavailable"
    : windowSnapshot
      ? "no_signal"
      : "disabled";
  capabilities.screen_snapshot = compatibilityStatus(capabilityStates.screen_snapshot);

  capTier.window_snapshot = SCREEN_SNAPSHOT_TIER;
  capabilityStates.window_snapshot = capabilityStates.screen_snapshot;
  capabilities.window_snapshot = capabilities.screen_snapshot;

  capTier.full_screen_snapshot = FULL_SCREEN_SNAPSHOT_TIER;
  capabilityStates.full_screen_snapshot = !config.isMac
    ? "unavailable"
    : config.fullScreenSnapshot
      ? "no_signal"
      : "disabled";
  capabilities.full_screen_snapshot = compatibilityStatus(
    capabilityStates.full_screen_snapshot,
  );

  for (const [capability, tier] of UNIMPLEMENTED) {
    if (capability in capabilities) continue;
    capTier[capability] = tier;
    capabilityStates[capability] = "unavailable";
    capabilities[capability] = "unavailable";
  }

  let tier = 0;
  for (const [capability, value] of Object.entries(capabilities)) {
    if (value === "granted") tier = Math.max(tier, capTier[capability] ?? 0);
  }

  return {
    tier,
    capabilities,
    capability_states: capabilityStates,
    ...(Object.keys(capabilityDetails).length > 0
      ? { capability_details: capabilityDetails }
      : {}),
  };
}

function revoked(state: CapabilityOperationalState | undefined): boolean {
  return state === "disabled" || state === "permission_denied" || state === "unavailable";
}

/** Remove cached fields as soon as their acquisition policy or permission is revoked. */
export function enforcePrivacyRevocations(store: StateStore, privacy: Privacy): void {
  const states = privacy.capability_states ?? {};
  if (revoked(states.calendar)) store.removeSensor("calendar");
  if (revoked(states.location_class)) store.removeSensor("location");
  if (revoked(states.microphone_level)) store.removeSensor("audio-level");
  if (revoked(states.camera_snapshot)) store.removeSensor("camera");
  if (revoked(states.raw_window_titles)) {
    store.removeSensorField("active-window", "active_window_title");
  }
}
