import type { Observation, Sensor } from "../types.js";
import { isMac, run } from "./exec.js";

const TTL_MS = 30_000;
const SHORTCUT_NAME = process.env.SENSE_FOCUS_SHORTCUT ?? "Sense Current Focus";

function normalizeMode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function fieldsFromMode(mode: string): Record<string, string | boolean> | null {
  const normalized = normalizeMode(mode);
  if (!normalized || normalized === "none" || normalized === "off") {
    return { focus_mode: "off", do_not_disturb: false };
  }

  return {
    focus_mode: normalized,
    do_not_disturb: normalized.includes("do_not_disturb") || normalized.includes("dnd"),
  };
}

/** Focus mode bridge. Uses env override or an optional Shortcuts bridge. */
export const focusModeSensor: Sensor = {
  name: "focus-mode",
  intervalMs: 30_000,
  tier: 2,
  capability: "focus_mode",
  available: async () => isMac || Boolean(process.env.SENSE_FOCUS_MODE),
  async sample(): Promise<Observation[]> {
    const manual = process.env.SENSE_FOCUS_MODE;
    const mode = manual || (isMac ? await run("shortcuts", ["run", SHORTCUT_NAME], 3000) : null);
    if (!mode) return [];

    const fields = fieldsFromMode(mode);
    if (!fields) return [];

    return [
      {
        sensor: "focus-mode",
        domain: "user",
        fields,
        observedAt: Date.now(),
        ttlMs: TTL_MS,
      },
    ];
  },
};
