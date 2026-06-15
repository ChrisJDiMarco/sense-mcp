import type { AssistivePosture, ContextFrame } from "./types.js";

const FOCUS_ACTIVITIES = new Set(["coding", "writing", "designing"]);

/**
 * Derive the assistive posture from assembled domains, per SPEC §assistive_posture.
 * This converts raw state into social appropriateness — the one field a client
 * should respect for *proactive* behavior (and ignore for direct requests).
 *
 * Reference derivation (implementations MAY refine):
 *   in_meeting or (focused attention + high time pressure) → urgent_only
 *   rapid input, or sustained steady in a focus activity    → do_not_interrupt
 *   present + active, no time pressure                      → available
 *   idle                                                    → lightly_available
 *   otherwise                                               → unknown
 */
export function derivePosture(frame: ContextFrame): AssistivePosture {
  const user = frame.user ?? {};
  const screen = frame.screen ?? {};
  const schedule = frame.schedule ?? {};

  const presence = user.presence;
  const cadence = user.input_cadence;
  const activity = String(screen.activity_class ?? "");
  const timePressure = schedule.time_pressure;
  const inMeeting = schedule.in_meeting === true;

  if (inMeeting || (user.attention === "focused" && timePressure === "high")) {
    return "urgent_only";
  }
  if (cadence === "rapid" || (cadence === "steady" && FOCUS_ACTIVITIES.has(activity))) {
    return "do_not_interrupt";
  }
  if (presence === "active" && timePressure !== "high") {
    return "available";
  }
  if (presence === "idle") {
    return "lightly_available";
  }
  return "unknown";
}
