import { policyEnabled } from "../policy.js";
import type { Observation, Sensor, SensorDiagnostic } from "../types.js";
import { type CommandResult, isMac, run, runCapture } from "./exec.js";

const TTL_MS = 120_000;
/** The Wi-Fi port on Apple silicon Macs; the same name is an Ethernet port on some models. */
const WIFI_INTERFACE = "en0";

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
  /**
   * Both streams and the exit status, which the Wi-Fi power probe needs: `networksetup
   * -getairportpower` prints "enX is not a Wi-Fi interface." to stdout and then exits 10, so a
   * stdout-only runner that discards non-zero exits cannot tell that answer from no answer at all.
   */
  captureCommand: (
    command: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<CommandResult | null>;
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

/**
 * Classify an SSID the caller has already established is present. The absent-
 * SSID case is not a classification outcome: `sample` returns early with the
 * `location_ssid_withheld` diagnostic, so a null branch here would be
 * unreachable and would suggest "unknown" is a location rather than a fault.
 * The non-nullable parameter keeps that guarantee at the type level.
 */
export function classifyLocation(ssid: string, config: LocationConfig): string {
  const normalized = normalize(ssid);
  if (config.home.map(normalize).includes(normalized)) return "home_office";
  if (config.office.map(normalize).includes(normalized)) return "office";
  if (/cafe|coffee|starbucks|la colombe|wifi|guest/.test(normalized)) return "cafe";
  return "unknown";
}

/**
 * `networksetup -getairportnetwork` prints the identical "You are not associated with an AirPort
 * network." line for causes that need opposite responses: a withheld SSID (Location Services is
 * not granted), Wi-Fi switched off, no Wi-Fi interface at this device name at all, and simply not
 * being joined to a network. Asserting the permission cause for all of them told users on Ethernet
 * — or with Wi-Fi off — to go grant a permission that would change nothing. So ask the interface
 * what it is first, and where the answer still cannot separate the two remaining causes, say both.
 *
 * Every branch below is entered only on a line the power probe actually printed. A probe that
 * answered nothing establishes nothing, and gets its own reason: treating silence as "enX is not a
 * Wi-Fi interface" reintroduced the wrong-cause bug from the other side, telling a user with Wi-Fi
 * on that their Wi-Fi port is an Ethernet port.
 */
async function diagnoseMissingSsid(
  dependencies: LocationDependencies,
  signal?: AbortSignal,
): Promise<SensorDiagnostic> {
  const probe = await dependencies.captureCommand(
    "networksetup",
    ["-getairportpower", WIFI_INTERFACE],
    3_000,
    signal,
  );
  // The not-a-Wi-Fi-interface answer arrives on stdout with a non-zero exit and an accompanying
  // stderr line, so read both streams and ignore the status.
  const answer = probe ? `${probe.stdout}\n${probe.stderr}` : "";

  // "enX is not a Wi-Fi interface." — a Mac on Ethernet, or one whose Wi-Fi lives elsewhere.
  if (/is not a Wi-Fi interface/i.test(answer)) {
    return {
      reason: "location_wifi_interface_absent",
      detail: `${WIFI_INTERFACE} is not a Wi-Fi interface on this Mac, so there is no Wi-Fi network to classify.`,
      fixHint:
        "Sense classifies location from the Wi-Fi network name only; on a wired-only Mac there is nothing to read. Disable location classification in the Sense policy to stop this check.",
    };
  }

  if (/Wi-Fi Power\s*\([^)]*\):\s*Off/i.test(answer)) {
    return {
      reason: "location_wifi_powered_off",
      detail: "Wi-Fi is turned off, so there is no network name to classify.",
      fixHint:
        "Turn Wi-Fi on if you want coarse location classification. No privacy permission is involved.",
    };
  }

  // Wi-Fi is on and still nameless. Both remaining causes are live and we cannot tell them apart
  // from this command, so the message carries both rather than picking the one that sounds fixable.
  if (/Wi-Fi Power\s*\([^)]*\):\s*On/i.test(answer)) {
    return {
      reason: "location_ssid_withheld",
      detail:
        "Wi-Fi is on but networksetup reported no network name. Either this Mac is not joined to a " +
        "Wi-Fi network, or macOS is withholding the SSID until Location Services is granted.",
      fixHint:
        "If you are on Wi-Fi, grant Location Services to the terminal or host app in System Settings > Privacy & Security. If you are not on Wi-Fi, nothing is wrong and location classification stays absent. Disable it in the Sense policy to stop this check.",
    };
  }

  // The probe said nothing usable — it timed out, was cancelled, or printed a line no branch above
  // recognises. Name that plainly instead of picking whichever cause sounds most likely.
  const because = probe?.timedOut ? "timed out" : "returned nothing this check recognises";
  return {
    reason: "location_wifi_probe_failed",
    detail:
      `networksetup reported no Wi-Fi network name, and the follow-up power probe on ${WIFI_INTERFACE} ` +
      `${because}, so the cause is not established. It could be that this Mac is not joined to a ` +
      "network, that Wi-Fi is off, that this port is not a Wi-Fi interface, or that macOS is " +
      "withholding the SSID.",
    fixHint:
      `Run \`networksetup -getairportpower ${WIFI_INTERFACE}\` to see which applies. Location classification stays absent until the cause is known; disable it in the Sense policy to stop this check.`,
  };
}

export function createLocationSensor(
  overrides: Partial<LocationDependencies> = {},
): Sensor {
  const dependencies: LocationDependencies = {
    isMac,
    policyEnabled: () => policyEnabled("location"),
    runCommand: run,
    captureCommand: runCapture,
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
        ["-getairportnetwork", WIFI_INTERFACE],
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

      // Modern macOS withholds the SSID behind a location-permission gate but
      // still exits 0, printing "You are not associated with an AirPort
      // network." The `!out` check above never fires for that, so detect the
      // missing SSID explicitly instead of reporting healthy forever.
      const ssid = parseWifiNetwork(out);
      if (!ssid) {
        diagnostic = await diagnoseMissingSsid(dependencies, signal);
        return [];
      }

      const locationClass = classifyLocation(ssid, {
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
