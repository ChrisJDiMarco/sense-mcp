import type { ContextFrame, SituationConfidence, SituationSummary, TimelineEvent } from "./types.js";

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0 && value !== "unknown") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function plural(count: number, singular: string, pluralWord = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function powerPhrase(power: string): string {
  if (power === "ac_power") return "plugged in";
  if (power === "battery_power") return "on battery";
  return power;
}

function confidenceFor(evidenceCount: number, unknownCount: number): SituationConfidence {
  if (evidenceCount === 0) return "unknown";
  if (evidenceCount >= 4 && unknownCount <= 1) return "high";
  if (evidenceCount >= 2) return "medium";
  return "low";
}

function recentChanges(events: TimelineEvent[]): string[] {
  const labels: string[] = [];
  for (const event of events.slice().reverse()) {
    if (!labels.includes(event.label)) labels.push(event.label);
    if (labels.length === 5) break;
  }
  return labels;
}

function capabilityUnknowns(frame: ContextFrame): string[] {
  const capabilities = frame.privacy.capabilities;
  const details = frame.privacy.capability_details ?? {};
  const unknowns: string[] = [];
  for (const capability of ["calendar", "focus_mode", "microphone_level", "ambient_light"]) {
    const status = capabilities[capability];
    if (status && status !== "granted") {
      const reason = details[capability]?.reason;
      unknowns.push(reason ? `${capability}: ${reason}` : `${capability}: ${status}`);
    }
  }
  return unknowns;
}

export function deriveSituation(
  frame: ContextFrame,
  timeline: TimelineEvent[] = [],
): SituationSummary | undefined {
  const screen = frame.screen ?? {};
  const user = frame.user ?? {};
  const environment = frame.environment ?? {};
  const schedule = frame.schedule ?? {};

  const evidence: string[] = [];
  const risks: string[] = [];
  const recommendations: string[] = [];

  const activity = asString(screen.activity_class);
  const app = asString(screen.active_app);
  const workspace = asString(screen.workspace_name);
  const branch = asString(screen.git_branch);
  const dirty = typeof screen.git_dirty_count === "number" ? screen.git_dirty_count : undefined;
  const presence = asString(user.presence);
  const cadence = asString(user.input_cadence);
  const focusMode = asString(user.focus_mode);
  const power = asString(environment.power_source);
  const battery = typeof environment.battery_percent === "number" ? environment.battery_percent : undefined;
  const displays =
    typeof environment.external_display_count === "number"
      ? environment.external_display_count
      : undefined;
  const noise = asString(environment.noise_class);
  const lighting = asString(environment.lighting);
  const media = asString(environment.media_playback);
  const timePressure = asString(schedule.time_pressure);
  const nextEvent = typeof schedule.next_event_minutes === "number" ? schedule.next_event_minutes : undefined;
  const inMeeting = schedule.in_meeting === true;

  if (workspace) evidence.push(`workspace ${workspace}`);
  else if (app) evidence.push(`active app ${app}`);
  if (activity) evidence.push(`activity ${activity}`);
  if (branch) evidence.push(`branch ${branch}`);
  if (dirty !== undefined) evidence.push(`${plural(dirty, "changed item")}`);
  if (presence) evidence.push(`presence ${presence}`);
  if (cadence) evidence.push(`input ${cadence}`);
  if (focusMode) evidence.push(`focus ${focusMode}`);
  if (power) evidence.push(`power ${power}`);
  if (battery !== undefined) evidence.push(`battery ${battery}%`);
  if (displays !== undefined) evidence.push(`${plural(displays, "external display")}`);
  if (noise) evidence.push(`noise ${noise}`);
  if (lighting) evidence.push(`lighting ${lighting}`);
  if (media) evidence.push(`media ${media}`);
  if (timePressure) evidence.push(`schedule pressure ${timePressure}`);

  if (dirty !== undefined && dirty >= 20) risks.push("workspace has a large amount of uncommitted local state");
  if (timePressure === "high") risks.push("schedule pressure is high");
  if (inMeeting) risks.push("user appears to be in a meeting");
  if (frame.quality?.overall_freshness === "stale") risks.push("context is stale");

  const unknowns = capabilityUnknowns(frame);
  const calendarStatus = frame.privacy.capabilities.calendar;
  const focusStatus = frame.privacy.capabilities.focus_mode;
  if (calendarStatus && calendarStatus !== "granted") {
    recommendations.push("Use a direct calendar connector for account schedule timing when needed.");
  }
  if (focusStatus && focusStatus !== "granted") {
    recommendations.push("Treat focus mode as unknown unless a focus bridge is configured.");
  }

  const workPhrase = workspace
    ? `working in ${workspace}`
    : app
      ? `using ${app}`
      : activity
        ? `in a ${activity} activity`
        : "active locally";
  const activityPhrase = activity && !workPhrase.includes(activity) ? `, activity looks like ${activity}` : "";
  const dirtyPhrase = dirty !== undefined ? `, with ${plural(dirty, "changed item")}` : "";
  const presencePhrase = presence ? `${presence} ` : "";
  const powerSummary = power ? `, ${powerPhrase(power)}` : "";
  const schedulePhrase =
    timePressure && nextEvent !== undefined
      ? `, schedule pressure ${timePressure} with the next event in ${nextEvent} minutes`
      : timePressure
        ? `, schedule pressure ${timePressure}`
        : "";

  const summary =
    evidence.length === 0
      ? "No fresh local situation signal is available."
      : `User appears ${presencePhrase}${workPhrase}${activityPhrase}${dirtyPhrase}${powerSummary}${schedulePhrase}.`;

  return {
    summary,
    confidence: confidenceFor(evidence.length, unknowns.length),
    evidence: unique(evidence).slice(0, 12),
    unknowns: unique(unknowns).slice(0, 8),
    risks: unique(risks),
    recommendations: unique(recommendations).slice(0, 4),
    recent_changes: recentChanges(timeline),
  };
}
