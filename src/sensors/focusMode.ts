import type { Observation, Sensor, SensorDiagnostic } from "../types.js";
import { isMac, runCapture } from "./exec.js";

const TTL_MS = 30_000;
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
  domains: ["user"],
  capability: "focus_mode",
  available: async () => Boolean(process.env.SENSE_FOCUS_MODE || (isMac && process.env.SENSE_FOCUS_SHORTCUT)),
  async sample(signal): Promise<Observation[]> {
    const manual = process.env.SENSE_FOCUS_MODE;
    const shortcutName = process.env.SENSE_FOCUS_SHORTCUT;
    let mode = manual;
    if (!mode && isMac && shortcutName) {
      const result = await runCapture("shortcuts", ["run", shortcutName], 3000, signal);
      if (result && result.exitCode === 0 && result.stdout) {
        mode = result.stdout;
      } else {
        lastFocusDiagnostic = {
          reason: "missing_focus_bridge",
          detail: `Configured Shortcut "${shortcutName}" did not return a focus mode.`,
          fixHint:
            "Set SENSE_FOCUS_MODE=deep_work or verify SENSE_FOCUS_SHORTCUT names a Shortcut that returns text.",
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
