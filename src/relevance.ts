import type { Domain } from "./types.js";

export type RelevantIntent =
  | "visual_appearance_check"
  | "screen_debug"
  | "time_pressure"
  | "current_work"
  | "focus_state"
  | "environment_check"
  | "general_context";

export type SnapshotMode =
  | "appearance_check"
  | "hair_check"
  | "outfit_check"
  | "lighting_check"
  | "desk_check"
  | "object_identification"
  | "screen_debug"
  | "ui_feedback"
  | "screen_summary"
  | "general_visual";

export interface RelevantContextPlan {
  intent: RelevantIntent;
  confidence: "high" | "medium" | "low";
  relevant_domains: Domain[];
  recommended_tools: string[];
  snapshot_mode?: SnapshotMode;
  guidance: string[];
}

function includesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function planRelevantContext(userRequest: string): RelevantContextPlan {
  const text = userRequest.toLowerCase();

  if (
    includesAny(text, [
      /\bhow do i look\b/,
      /\bdo i look\b/,
      /\bhair\b/,
      /\boutfit\b/,
      /\bfit check\b/,
      /\blook tired\b/,
      /\bmy face\b/,
    ])
  ) {
    const snapshotMode = /\bhair\b/.test(text)
      ? "hair_check"
      : /\boutfit\b|\bfit check\b/.test(text)
        ? "outfit_check"
        : /\blighting\b|\blight\b/.test(text)
          ? "lighting_check"
          : "appearance_check";

    return {
      intent: "visual_appearance_check",
      confidence: "high",
      relevant_domains: ["user", "environment"],
      recommended_tools: ["take_camera_snapshot"],
      snapshot_mode: snapshotMode,
      guidance: [
        "Use an explicit camera snapshot because the user asked about current visual appearance.",
        "Inspect snapshot_path before answering.",
      ],
    };
  }

  if (
    includesAny(text, [
      /\bscreen\b/,
      /\bthis ui\b/,
      /\bthis error\b/,
      /\bwhat am i looking at\b/,
      /\bbutton\b/,
      /\bpage\b/,
      /\bwindow\b/,
    ])
  ) {
    return {
      intent: "screen_debug",
      confidence: "high",
      relevant_domains: ["screen"],
      recommended_tools: ["take_screen_snapshot"],
      snapshot_mode: includesAny(text, [/\bui\b/, /\bdesign\b/, /\blayout\b/])
        ? "ui_feedback"
        : "screen_debug",
      guidance: [
        "Use an explicit screen snapshot because the user referenced current on-screen content.",
        "Inspect snapshot_path before answering.",
      ],
    };
  }

  if (includesAny(text, [/\bdesk\b/, /\bwhat is this\b/, /\bobject\b/])) {
    return {
      intent: "visual_appearance_check",
      confidence: "medium",
      relevant_domains: ["environment"],
      recommended_tools: ["take_camera_snapshot"],
      snapshot_mode: "desk_check",
      guidance: ["Use camera only if the user is referring to the physical room or desk."],
    };
  }

  if (includesAny(text, [/\bbefore my meeting\b/, /\bfast\b/, /\bquick\b/, /\btime\b/, /\bdeadline\b/])) {
    return {
      intent: "time_pressure",
      confidence: "high",
      relevant_domains: ["schedule", "user"],
      recommended_tools: ["get_schedule_context", "get_user_state"],
      guidance: ["Use schedule pressure and presence to size the recommendation."],
    };
  }

  if (includesAny(text, [/\bwhat am i working on\b/, /\bwhat should i do next\b/, /\bcurrent project\b/, /\brepo\b/])) {
    return {
      intent: "current_work",
      confidence: "high",
      relevant_domains: ["screen", "user", "schedule"],
      recommended_tools: ["get_context_frame"],
      guidance: ["Use active app, workspace state, and schedule pressure."],
    };
  }

  if (includesAny(text, [/\bdeep work\b/, /\bfocus\b/, /\bshould i work\b/, /\bstate\b/])) {
    return {
      intent: "focus_state",
      confidence: "medium",
      relevant_domains: ["user", "environment", "schedule"],
      recommended_tools: ["get_context_frame"],
      guidance: ["Use user state, environment, and schedule pressure."],
    };
  }

  if (includesAny(text, [/\bwhere am i\b/, /\bnoise\b/, /\bbattery\b/, /\blighting\b/, /\benvironment\b/])) {
    return {
      intent: "environment_check",
      confidence: "medium",
      relevant_domains: ["environment"],
      recommended_tools: ["get_environment_context"],
      guidance: ["Use ambient context only; avoid snapshots unless explicitly visual."],
    };
  }

  return {
    intent: "general_context",
    confidence: "low",
    relevant_domains: ["screen", "user", "environment", "schedule"],
    recommended_tools: ["get_context_frame"],
    guidance: ["Use the full frame only if the request benefits from local context."],
  };
}
