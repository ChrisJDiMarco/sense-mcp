import type { Observation, Sensor } from "../types.js";
import { isMac, run } from "./exec.js";
import { classifyWindowLabel, classifyWindowSensitivity, redactTitle } from "../redact.js";
import { policyEnabled } from "../policy.js";

const TTL_MS = 15_000;

const ACTIVITY_BY_APP: Record<string, string> = {
  Code: "coding",
  Terminal: "coding",
  iTerm2: "coding",
  Xcode: "coding",
  Figma: "designing",
  Sketch: "designing",
  Pages: "writing",
  Notes: "writing",
  Obsidian: "writing",
  Notion: "writing",
  Safari: "browsing",
  "Google Chrome": "browsing",
  Arc: "browsing",
  Firefox: "browsing",
  Preview: "reading",
  Books: "reading",
  Slack: "communicating",
  Messages: "communicating",
  Mail: "communicating",
  Discord: "communicating",
  zoom_us: "meeting",
  FaceTime: "meeting",
  Spotify: "media",
  Music: "media",
  QuickTime_Player: "media",
};

const FRONTMOST_SCRIPT =
  'tell application "System Events" to get name of first application process whose frontmost is true';

const TITLE_SCRIPT = `
tell application "System Events"
  set frontProc to first application process whose frontmost is true
  try
    return name of front window of frontProc
  on error
    return ""
  end try
end tell`;

/**
 * Frontmost app + activity class + a privacy-safe window label via macOS
 * System Events. Raw window-title acquisition is skipped entirely unless the
 * central Tier-3 policy enables it; enabled titles are redacted before output.
 */
export interface ActiveWindowDependencies {
  isMac: boolean;
  runCommand: typeof run;
  rawTitlesEnabled: () => Promise<boolean>;
}

export function createActiveWindowSensor(
  dependencies: ActiveWindowDependencies = {
    isMac,
    runCommand: run,
    rawTitlesEnabled: () => policyEnabled("raw_titles"),
  },
): Sensor {
  return {
    name: "active-window",
    intervalMs: 5_000,
    tier: 1,
    domains: ["screen"],
    capability: "screen_activity",
    available: async () => dependencies.isMac,
    async sample(signal): Promise<Observation[]> {
      const app = await dependencies.runCommand("osascript", ["-e", FRONTMOST_SCRIPT], 3000, signal);
      if (!app) return [];

      const rawTitles = await dependencies.rawTitlesEnabled();
      const title = rawTitles
        ? await dependencies.runCommand("osascript", ["-e", TITLE_SCRIPT], 3000, signal)
        : null;
      const activityClass = ACTIVITY_BY_APP[app] ?? "unknown";
      const label = classifyWindowLabel(activityClass, title ?? undefined);
      const sensitivity = classifyWindowSensitivity(label);

      const fields: Record<string, string> = {
        active_app: app,
        activity_class: activityClass,
        active_window_label: label,
        sensitivity_level: sensitivity.level,
      };
      if (sensitivity.reason) fields.sensitivity_reason = sensitivity.reason;
      if (rawTitles && title) {
        // The classifier's own verdict gates the title, not just the policy.
        // redactTitle only strips emails, URLs and long digit runs, so it can
        // only help when the sensitive part is a *substring*. Above "normal"
        // the sensitive part IS the whole title — an email subject line, a
        // Messages thread name, a Slack DM title — and SPEC.md names exactly
        // those three as things that must not cross. Nothing is left to strip,
        // so medium and high are both withheld outright; only "normal" titles
        // are redacted and emitted.
        if (sensitivity.level === "normal") fields.active_window_title = redactTitle(title);
        else fields.title_withheld = "sensitivity";
      }

      return [
        {
          sensor: "active-window",
          domain: "screen",
          fields,
          observedAt: Date.now(),
          ttlMs: TTL_MS,
        },
      ];
    },
  };
}

export const activeWindowSensor = createActiveWindowSensor();
