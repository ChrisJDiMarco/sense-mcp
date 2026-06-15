import type { Observation, Sensor, SensorDiagnostic } from "../types.js";
import { isMac, runCapture, type CommandResult } from "./exec.js";

const TTL_MS = 60_000;
const CALENDAR_TIMEOUT_MS = 8_000;
let lastCalendarDiagnostic: SensorDiagnostic | null = null;

type CalendarProbe =
  | { kind: "current"; minutes: number; title?: string }
  | { kind: "upcoming"; minutes: number; title?: string }
  | null;

export type CalendarFields = Record<string, string | number | boolean>;

const CALENDAR_SCRIPT = `
set nowDate to current date
set windowEnd to nowDate + (8 * hours)
set bestStart to missing value
set bestTitle to ""

tell application "Calendar"
  repeat with cal in calendars
    try
      set matches to every event of cal whose end date is greater than nowDate and start date is less than windowEnd
      repeat with ev in matches
        set evStart to start date of ev
        set evEnd to end date of ev
        if evStart is less than or equal to nowDate and evEnd is greater than nowDate then
          return "CURRENT|" & (round ((evEnd - nowDate) / minutes)) & "|" & (summary of ev)
        end if
        if evStart is greater than nowDate then
          if bestStart is missing value or evStart is less than bestStart then
            set bestStart to evStart
            set bestTitle to summary of ev
          end if
        end if
      end repeat
    end try
  end repeat
end tell

if bestStart is not missing value then
  return "UPCOMING|" & (round ((bestStart - nowDate) / minutes)) & "|" & bestTitle
end if
return "NONE"
`;

export function parseCalendarProbe(line: string): CalendarFields | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed === "NONE") return classifyCalendarPressure(null);

  const [kind, minutesRaw, title] = trimmed.split("|");
  const minutes = Number(minutesRaw);
  if (!Number.isFinite(minutes)) return null;

  if (kind === "CURRENT") return classifyCalendarPressure({ kind: "current", minutes, title });
  if (kind === "UPCOMING") return classifyCalendarPressure({ kind: "upcoming", minutes, title });
  return null;
}

export function calendarDiagnosticFromResult(result: CommandResult | null): SensorDiagnostic | null {
  if (!result) {
    return {
      reason: "calendar_query_failed",
      detail: "Calendar query did not return a result.",
      fixHint: "Open Calendar once, then run sense-mcp doctor.",
    };
  }
  if (result.timedOut) {
    return {
      reason: "calendar_query_timeout",
      detail: `Calendar query exceeded ${Math.round(CALENDAR_TIMEOUT_MS / 1000)} seconds.`,
      fixHint:
        "Open Calendar once and check macOS Automation/Calendar permissions for the app running Sense.",
    };
  }
  if (result.exitCode !== 0) {
    return {
      reason: "calendar_permission_or_query_error",
      detail: result.stderr || result.errorMessage || "Calendar query failed.",
      fixHint: "Grant Calendar/Automation access to the app running Sense, then restart the MCP client.",
    };
  }
  return null;
}

function eventKind(title?: string): string {
  const text = (title ?? "").toLowerCase();
  if (/1:1|one.?on.?one/.test(text)) return "one_on_one";
  if (/deep work|focus|block|heads.?down/.test(text)) return "focus_block";
  if (/sales|demo|prospect|client|customer|call/.test(text)) return "external_call";
  if (/doctor|dentist|personal|gym|therapy|health/.test(text)) return "personal";
  if (!text) return "unknown";
  return "meeting";
}

function workWindow(minutes: number): string {
  if (minutes <= 0) return "none";
  if (minutes <= 20) return "short";
  if (minutes <= 60) return "medium";
  return "long";
}

function prepWindow(minutes: number): string {
  if (minutes <= 15) return "now";
  if (minutes <= 45) return "soon";
  return "none";
}

export function classifyCalendarPressure(probe: CalendarProbe): CalendarFields {
  if (!probe) {
    return {
      in_meeting: false,
      time_pressure: "none",
      usable_work_minutes: 120,
      work_window: "long",
      meeting_state: "free",
      prep_window: "none",
    };
  }

  if (probe.kind === "current") {
    return {
      in_meeting: true,
      current_event_label: "calendar event",
      current_event_minutes_remaining: Math.max(0, Math.round(probe.minutes)),
      time_pressure: "high",
      usable_work_minutes: 0,
      work_window: "none",
      meeting_state: "in_meeting",
      event_kind: eventKind(probe.title),
      prep_window: "now",
    };
  }

  const minutes = Math.max(0, Math.round(probe.minutes));
  const usableWorkMinutes = Math.max(0, minutes - 3);
  const pressure = minutes <= 15 ? "high" : minutes <= 45 ? "moderate" : "none";
  return {
    in_meeting: false,
    next_event_label: "calendar event",
    next_event_minutes: minutes,
    time_pressure: pressure,
    usable_work_minutes: usableWorkMinutes,
    work_window: workWindow(usableWorkMinutes),
    meeting_state: "upcoming",
    event_kind: eventKind(probe.title),
    prep_window: prepWindow(minutes),
  };
}

/** Local macOS Calendar timing only. Event titles are never emitted by default. */
export const calendarSensor: Sensor = {
  name: "calendar",
  intervalMs: 60_000,
  tier: 2,
  capability: "calendar",
  available: async () => isMac,
  async sample(): Promise<Observation[]> {
    const result = await runCapture("osascript", ["-e", CALENDAR_SCRIPT], CALENDAR_TIMEOUT_MS);
    lastCalendarDiagnostic = calendarDiagnosticFromResult(result);
    if (lastCalendarDiagnostic || !result?.stdout) return [];

    const fields = parseCalendarProbe(result.stdout);
    if (!fields) {
      lastCalendarDiagnostic = {
        reason: "calendar_parse_failed",
        detail: "Calendar query returned an unexpected response.",
        fixHint: "Run sense-mcp doctor and report the Calendar diagnostic if this persists.",
      };
      return [];
    }
    lastCalendarDiagnostic = null;

    return [
      {
        sensor: "calendar",
        domain: "schedule",
        fields,
        observedAt: Date.now(),
        ttlMs: TTL_MS,
      },
    ];
  },
  diagnose: () => lastCalendarDiagnostic,
};
