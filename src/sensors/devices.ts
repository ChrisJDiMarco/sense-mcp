import type { Observation, Sensor, SensorDiagnostic } from "../types.js";
import { isMac, run } from "./exec.js";

const TTL_MS = 120_000;

interface DisplayEntry {
  spdisplays_connection_type?: string;
  spdisplays_display_type?: string;
}

interface DisplayAdapter {
  spdisplays_ndrvs?: DisplayEntry[];
}

interface BluetoothDeviceDetail {
  device_minorType?: string;
  /** Legacy shape only: "attrib_Yes" / "attrib_No" on each entry of a flat `device_title` list. */
  device_isconnected?: string;
}

/** Each entry is a single-key object whose key is the device name macOS shows. */
type BluetoothDeviceEntry = Record<string, unknown>;

interface BluetoothSection {
  /** Ventura and later. */
  device_connected?: BluetoothDeviceEntry[];
  /** Ventura and later; present on its own when nothing is connected. */
  device_not_connected?: BluetoothDeviceEntry[];
  /** Monterey and earlier: one flat list, connection state carried per device. */
  device_title?: BluetoothDeviceEntry[];
}

function profilerEntries<T>(output: string, key: string): T[] | null {
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed !== "object" || parsed === null) return null;
    const entries = (parsed as Record<string, unknown>)[key];
    return Array.isArray(entries) ? (entries as T[]) : null;
  } catch {
    return null;
  }
}

/**
 * External displays from `system_profiler -json SPDisplaysDataType`.
 *
 * Returns null when the payload cannot be trusted. The count is rendered into
 * prose the model reads as fact, so an omitted field beats a wrong number —
 * the previous line-counting parser read the "Graphics/Displays:" and GPU-name
 * headers as displays and reported 2 on a machine with none.
 */
export function parseDisplayCount(output: string): number | null {
  const adapters = profilerEntries<DisplayAdapter>(output, "SPDisplaysDataType");
  if (!adapters) return null;

  let sawDisplayList = false;
  let count = 0;
  for (const adapter of adapters) {
    const displays = adapter?.spdisplays_ndrvs;
    if (!Array.isArray(displays)) continue;
    // An empty list is a real answer — a GPU with nothing attached — so it counts as having been
    // asked. Only the absence of any list at all leaves the question unanswered.
    sawDisplayList = true;
    for (const display of displays) {
      if (display?.spdisplays_connection_type === "spdisplays_internal") continue;
      // Older macOS omits the connection type on the built-in panel.
      if (!display?.spdisplays_connection_type && display?.spdisplays_display_type?.startsWith("spdisplays_built-in")) {
        continue;
      }
      count += 1;
    }
  }

  // A payload that parsed but carried no display list anywhere — `"SPDisplaysDataType": []`, or
  // adapters with no `spdisplays_ndrvs` key — never said how many displays there are. Returning 0
  // for it asserts "no external displays" on the strength of a payload this parser could not read,
  // which is the same confident-wrong-number failure the JSON parser replaced. Say "could not
  // tell" instead and let the sensor emit its diagnostic.
  return sawDisplayList ? count : null;
}

function deviceDetail(value: unknown): BluetoothDeviceDetail {
  return typeof value === "object" && value !== null ? (value as BluetoothDeviceDetail) : {};
}

/** "attrib_Yes" on the shapes that carry it; older builds shortened it to "Yes". */
function isConnectedFlag(value: string | undefined): boolean {
  return /^(?:attrib_)?yes$/i.test(value ?? "");
}

/**
 * Broad Bluetooth classes from `system_profiler -json SPBluetoothDataType`.
 *
 * Two payload shapes are in the wild and they disagree about where connection state lives:
 * Ventura and later group devices under `device_connected` / `device_not_connected`, while
 * Monterey and earlier emit one flat `device_title` list with a per-device `device_isconnected`
 * flag. Reading only the modern keys made the legacy shape look like a Mac with nothing connected
 * — two confident `false` fields and no diagnostic — which is worse than saying nothing, because
 * the model downstream reads the fields as measured fact.
 *
 * So each section must be recognised before it is trusted. If no section carried a device list
 * this parser knows, the whole payload returns null and the sensor reports a parse failure rather
 * than a false.
 */
export function parseNearbyDevices(output: string): {
  airpods_connected: boolean;
  bluetooth_input_connected: boolean;
} | null {
  const sections = profilerEntries<BluetoothSection>(output, "SPBluetoothDataType");
  if (!sections) return null;

  let recognized = false;
  let airpodsConnected = false;
  let inputConnected = false;

  const classify = (name: string, detail: BluetoothDeviceDetail): void => {
    if (/AirPods/i.test(name)) airpodsConnected = true;
    if (/Keyboard|Mouse|Trackpad/i.test(`${name} ${detail.device_minorType ?? ""}`)) {
      inputConnected = true;
    }
  };

  for (const section of sections) {
    if (typeof section !== "object" || section === null) continue;

    // Modern: membership of the `device_connected` group *is* the connection state. The sibling
    // `device_not_connected` group is what identifies the shape when nothing is connected, since
    // macOS drops the connected key entirely rather than emitting it empty.
    if (Array.isArray(section.device_connected) || Array.isArray(section.device_not_connected)) {
      recognized = true;
      for (const device of section.device_connected ?? []) {
        for (const [name, detail] of Object.entries(device ?? {})) {
          classify(name, deviceDetail(detail));
        }
      }
      continue;
    }

    // Legacy: one list, state per device.
    if (Array.isArray(section.device_title)) {
      recognized = true;
      for (const device of section.device_title) {
        for (const [name, value] of Object.entries(device ?? {})) {
          const detail = deviceDetail(value);
          if (!isConnectedFlag(detail.device_isconnected)) continue;
          classify(name, detail);
        }
      }
    }
  }

  if (!recognized) return null;

  return {
    airpods_connected: airpodsConnected,
    bluetooth_input_connected: inputConnected,
  };
}

export interface DevicesDependencies {
  isMac: boolean;
  runCommand: typeof run;
}

/** Coarse local device setup: displays and broad Bluetooth classes only. */
export function createDevicesSensor(
  dependencies: DevicesDependencies = { isMac, runCommand: run },
): Sensor {
  let diagnostic: SensorDiagnostic | null = null;

  return {
    name: "devices",
    intervalMs: 120_000,
    tier: 1,
    domains: ["environment"],
    capability: "device_context",
    available: async () => dependencies.isMac,
    async sample(signal): Promise<Observation[]> {
      const [displayOut, bluetoothOut] = await Promise.all([
        dependencies.runCommand("system_profiler", ["-json", "SPDisplaysDataType"], 5000, signal),
        dependencies.runCommand("system_profiler", ["-json", "SPBluetoothDataType"], 7000, signal),
      ]);

      const fields: Record<string, string | number | boolean> = {};
      // Two distinct ways to end up with no fields, and neither may pass for
      // health: the command can produce nothing at all, or produce something
      // this parser cannot read. Reporting only the second is the silent-
      // failure pattern diagnose() exists to prevent.
      const failures: string[] = [];
      let silent = false;
      let parseFailed = false;

      if (displayOut) {
        const externalDisplayCount = parseDisplayCount(displayOut);
        if (externalDisplayCount === null) {
          failures.push("system_profiler returned display data in an unexpected format");
          parseFailed = true;
        } else {
          fields.external_display_count = externalDisplayCount;
          fields.multi_display = externalDisplayCount > 0;
        }
      } else {
        failures.push("system_profiler -json SPDisplaysDataType produced no output");
        silent = true;
      }

      if (bluetoothOut) {
        const nearby = parseNearbyDevices(bluetoothOut);
        if (nearby === null) {
          failures.push("system_profiler returned Bluetooth data in an unexpected format");
          parseFailed = true;
        } else {
          Object.assign(fields, nearby);
        }
      } else {
        failures.push("system_profiler -json SPBluetoothDataType produced no output");
        silent = true;
      }

      // The two probes fail independently, so a run can hit both at once. Collapsing that into the
      // silent reason hid the parse failure entirely — and the two want different responses: a
      // silent probe is an environment problem, an unreadable payload is a shape this parser has
      // not caught up with. A mixed run gets its own reason rather than being filed under either.
      diagnostic =
        failures.length === 0
          ? null
          : {
              reason:
                silent && parseFailed
                  ? "device_profile_unavailable_and_parse_failed"
                  : silent
                    ? "device_profile_unavailable"
                    : "device_profile_parse_failed",
              detail: `${failures.join("; ")}.`,
              fixHint: "The affected fields are omitted rather than guessed; check that system_profiler -json runs on this Mac.",
            };

      if (Object.keys(fields).length === 0) return [];

      return [
        {
          sensor: "devices",
          domain: "environment",
          fields,
          observedAt: Date.now(),
          ttlMs: TTL_MS,
        },
      ];
    },
    diagnose: () => diagnostic,
  };
}

export const devicesSensor: Sensor = createDevicesSensor();
