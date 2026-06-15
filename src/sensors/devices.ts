import type { Observation, Sensor } from "../types.js";
import { isMac, run } from "./exec.js";

const TTL_MS = 120_000;

export function parseDisplayCount(output: string): number {
  let count = 0;
  for (const line of output.split("\n")) {
    const name = line.trim();
    if (!name.endsWith(":")) continue;
    if (name === "Displays:") continue;
    if (/color lcd|built-in|display controller/i.test(name)) continue;
    count += 1;
  }
  return count;
}

export function parseNearbyDevices(output: string): {
  airpods_connected: boolean;
  bluetooth_input_connected: boolean;
} {
  const blocks = output.split(/\n(?=\s{4,}\S)/);
  let airpodsConnected = false;
  let inputConnected = false;

  for (const block of blocks) {
    if (!/Connected:\s*Yes/i.test(block)) continue;
    if (/AirPods/i.test(block)) airpodsConnected = true;
    if (/Keyboard|Mouse|Trackpad/i.test(block)) inputConnected = true;
  }

  return {
    airpods_connected: airpodsConnected,
    bluetooth_input_connected: inputConnected,
  };
}

/** Coarse local device setup: displays and broad Bluetooth classes only. */
export const devicesSensor: Sensor = {
  name: "devices",
  intervalMs: 120_000,
  tier: 1,
  capability: "device_context",
  available: async () => isMac,
  async sample(): Promise<Observation[]> {
    const [displayOut, bluetoothOut] = await Promise.all([
      run("system_profiler", ["SPDisplaysDataType"], 5000),
      run("system_profiler", ["SPBluetoothDataType"], 7000),
    ]);

    const fields: Record<string, string | number | boolean> = {};

    if (displayOut) {
      const externalDisplayCount = parseDisplayCount(displayOut);
      fields.external_display_count = externalDisplayCount;
      fields.multi_display = externalDisplayCount > 0;
    }

    if (bluetoothOut) {
      Object.assign(fields, parseNearbyDevices(bluetoothOut));
    }

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
};
