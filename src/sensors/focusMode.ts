import type { Observation, Sensor, SensorDiagnostic } from "../types.js";
import { isMac, runCapture } from "./exec.js";

const TTL_MS = 30_000;
const SHORTCUT_NAME = process.env.SENSE_FOCUS_SHORTCUT ?? "Sense Current Focus";
let lastFocusDiagnostic: SensorDiagnostic | null = null;

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
    let mode = manual;
    if (!mode && isMac) {
      const result = await runCapture("shortcuts", ["run", SHORTCUT_NAME], 3000);
      if (result && result.exitCode === 0 && result.stdout) {
        mode = result.stdout;
      } else {
        lastFocusDiagnostic = {
          reason: "missing_focus_bridge",
          detail: `No SENSE_FOCUS_MODE env value and Shortcut "${SHORTCUT_NAME}" did not return a mode.`,
          fixHint:
            "Set SENSE_FOCUS_MODE=deep_work or create a macOS Shortcut named Sense Current Focus that returns text.",
        };
        return [];
      }
    }
    if (!mode) {
      lastFocusDiagnostic = {
        reason: "missing_focus_bridge",
        detail: "No focus-mode bridge is configured.",
        fixHint: "Set SENSE_FOCUS_MODE=deep_work to provide a manual focus mode.",
      };
      return [];
    }

    const fields = fieldsFromMode(mode);
    if (!fields) {
      lastFocusDiagnostic = {
        reason: "focus_mode_parse_failed",
        detail: "Focus bridge returned an empty or invalid mode.",
        fixHint: "Return a short text value such as deep_work, do_not_disturb, or off.",
      };
      return [];
    }
    lastFocusDiagnostic = null;

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
  diagnose: () => lastFocusDiagnostic,
};
