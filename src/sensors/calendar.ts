import type { Observation, Sensor, SensorDiagnostic } from "../types.js";
import { policyEnabled } from "../policy.js";
import { isMac, runCapture, type CommandResult } from "./exec.js";

const TTL_MS = 60_000;
const CALENDAR_TIMEOUT_MS = 2_000;

export type CalendarFields = Record<string, string | number | boolean>;

interface CalendarSensorDependencies {
  isMac: boolean;
  policyEnabled: () => Promise<boolean>;
  runCommand: (
    command: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<CommandResult | null>;
  now: () => Date;
}

function disabledDiagnostic(): SensorDiagnostic {
  return {
    reason: "disabled_by_policy",
    detail: "Calendar timing is disabled in the Sense policy.",
    fixHint: "Run sense-mcp enable calendar if coarse local schedule pressure is wanted.",
  };
}

function missingProviderDiagnostic(): SensorDiagnostic {
  return {
    reason: "headless_calendar_provider_missing",
    detail: "The optional headless calendar helper is not installed.",
    fixHint: "Install icalBuddy or use a direct calendar connector for account calendar data.",
  };
}

function queryDiagnostic(result: CommandResult | null): SensorDiagnostic | null {
  if (result?.timedOut) {
    return {
      reason: "calendar_query_timeout",
      detail: "The headless calendar query timed out.",
      fixHint: "Run sense-mcp doctor and check the optional icalBuddy installation.",
    };
  }
  if (!result || result.exitCode !== 0) {
    return {
      reason: "calendar_query_failed",
      detail: "The headless calendar query failed without exposing calendar data.",
      fixHint: "Run sense-mcp doctor or use a direct calendar connector.",
    };
  }
  return null;
}

function formatLocalDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds()),
  ].join("");
}

function eventQueryArgs(command: string): string[] {
  // Include only date/time metadata. Sense checks whether output exists and
  // never returns the helper's raw output.
  return ["-cf", "", "-nc", "-npn", "-nrd", "-iep", "datetime", "-li", "1", "-b", "", "-ss", "", command];
}

function containsEvent(result: CommandResult | null): boolean {
  return result?.exitCode === 0 && result.stdout.trim().length > 0;
}

async function resolveIcalBuddy(
  dependencies: CalendarSensorDependencies,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await dependencies.runCommand("/usr/bin/which", ["icalBuddy"], 1_000, signal);
  if (!result || result.exitCode !== 0) return null;
  const executable = result.stdout.trim();
  return executable.startsWith("/") && !executable.includes("\n") ? executable : null;
}

export function classifyCalendarWindow(
  window: "current" | "within_15" | "within_45" | "none",
): CalendarFields {
  if (window === "current") {
    return {
      in_meeting: true,
      time_pressure: "high",
      usable_work_minutes: 0,
      work_window: "none",
      meeting_state: "in_meeting",
      prep_window: "now",
    };
  }
  if (window === "within_15") {
    return {
      in_meeting: false,
      next_event_minutes: 15,
      time_pressure: "high",
      usable_work_minutes: 12,
      work_window: "short",
      meeting_state: "upcoming",
      prep_window: "now",
    };
  }
  if (window === "within_45") {
    return {
      in_meeting: false,
      next_event_minutes: 45,
      time_pressure: "moderate",
      usable_work_minutes: 42,
      work_window: "medium",
      meeting_state: "upcoming",
      prep_window: "soon",
    };
  }
  return {
    in_meeting: false,
    time_pressure: "none",
    usable_work_minutes: 120,
    work_window: "long",
    meeting_state: "free",
    prep_window: "none",
  };
}

export function createCalendarSensor(
  overrides: Partial<CalendarSensorDependencies> = {},
): Sensor {
  const dependencies: CalendarSensorDependencies = {
    isMac,
    policyEnabled: () => policyEnabled("calendar"),
    runCommand: runCapture,
    now: () => new Date(),
    ...overrides,
  };
  let diagnostic: SensorDiagnostic | null = null;

  return {
    name: "calendar",
    intervalMs: 60_000,
    tier: 2,
    capability: "calendar",
    domains: ["schedule"],
    samplingMode: "on_demand",
    async available(signal): Promise<boolean> {
      if (!dependencies.isMac) return false;
      if (!(await dependencies.policyEnabled())) {
        diagnostic = disabledDiagnostic();
        return false;
      }
      const executable = await resolveIcalBuddy(dependencies, signal);
      diagnostic = executable ? null : missingProviderDiagnostic();
      return Boolean(executable);
    },
    async sample(signal): Promise<Observation[]> {
      if (!(await dependencies.policyEnabled())) {
        diagnostic = disabledDiagnostic();
        return [];
      }
      const executable = await resolveIcalBuddy(dependencies, signal);
      if (!executable) {
        diagnostic = missingProviderDiagnostic();
        return [];
      }

      const now = dependencies.now();
      const in15 = new Date(now.getTime() + 15 * 60_000);
      const currentCommand = "eventsNow";
      const soonCommand = `eventsFrom:${formatLocalDate(now)} to:${formatLocalDate(in15)}`;
      const [current, soon] = await Promise.all([
        dependencies.runCommand(executable, eventQueryArgs(currentCommand), CALENDAR_TIMEOUT_MS, signal),
        dependencies.runCommand(executable, eventQueryArgs(soonCommand), CALENDAR_TIMEOUT_MS, signal),
      ]);
      diagnostic = queryDiagnostic(current) ?? queryDiagnostic(soon);
      if (diagnostic) return [];

      let window: "current" | "within_15" | "within_45" | "none";
      if (containsEvent(current)) {
        window = "current";
      } else if (containsEvent(soon)) {
        window = "within_15";
      } else {
        const in45 = new Date(now.getTime() + 45 * 60_000);
        const laterCommand = `eventsFrom:${formatLocalDate(in15)} to:${formatLocalDate(in45)}`;
        const later = await dependencies.runCommand(
          executable,
          eventQueryArgs(laterCommand),
          CALENDAR_TIMEOUT_MS,
          signal,
        );
        diagnostic = queryDiagnostic(later);
        if (diagnostic) return [];
        window = containsEvent(later) ? "within_45" : "none";
      }

      diagnostic = null;
      return [
        {
          sensor: "calendar",
          domain: "schedule",
          fields: classifyCalendarWindow(window),
          observedAt: Date.now(),
          ttlMs: TTL_MS,
        },
      ];
    },
    diagnose: () => diagnostic,
  };
}

/** Coarse, opt-in schedule pressure from a headless helper. */
export const calendarSensor = createCalendarSensor();
