import type { Observation, Sensor } from "../types.js";
import { isMac, run } from "./exec.js";
import { classifyWindowLabel, classifyWindowSensitivity, redactTitle } from "../redact.js";

const TTL_MS = 15_000;

/** Tier 3, opt-in: include the (redacted) raw window title. Off by default. */
const RAW_TITLES = process.env.SENSE_RAW_TITLES === "1";

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
 * System Events. The raw window title is read locally only to classify it;
 * it never crosses the MCP boundary unless SENSE_RAW_TITLES=1 (Tier 3), and
 * even then it is redacted first.
 */
export const activeWindowSensor: Sensor = {
  name: "active-window",
  intervalMs: 5_000,
  tier: 1,
  capability: "screen_activity",
  available: async () => isMac,
  async sample(): Promise<Observation[]> {
    const app = await run("osascript", ["-e", FRONTMOST_SCRIPT]);
    if (!app) return [];

    const activityClass = ACTIVITY_BY_APP[app] ?? "unknown";
    const title = await run("osascript", ["-e", TITLE_SCRIPT]);

    const label = classifyWindowLabel(activityClass, title ?? undefined);
    const sensitivity = classifyWindowSensitivity(label);

    const fields: Record<string, string> = {
      active_app: app,
      activity_class: activityClass,
      active_window_label: label,
      sensitivity_level: sensitivity.level,
    };
    if (sensitivity.reason) fields.sensitivity_reason = sensitivity.reason;
    if (RAW_TITLES && title) fields.active_window_title = redactTitle(title);

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
