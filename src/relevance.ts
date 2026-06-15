import type { Domain } from "./types.js";

export type RelevantIntent =
  | "visual_appearance_check"
  | "screen_debug"
  | "time_pressure"
  | "current_work"
  | "focus_state"
  | "environment_check"
  | "writing_or_general_help"
  | "privacy_boundary"
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
  minimum_tool:
    | "none"
    | "get_context_frame"
    | "get_screen_context"
    | "get_user_state"
    | "get_environment_context"
    | "get_schedule_context"
    | "take_camera_snapshot"
    | "take_screen_snapshot";
  relevant_domains: Domain[];
  recommended_tools: string[];
  avoided_tools: string[];
  requires_explicit_media: boolean;
  snapshot_mode?: SnapshotMode;
  guidance: string[];
  fallbacks: string[];
  privacy_notes: string[];
}

function includesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function withDefaults(plan: Omit<RelevantContextPlan, "avoided_tools" | "fallbacks" | "privacy_notes" | "requires_explicit_media"> & {
  avoided_tools?: string[];
  fallbacks?: string[];
  privacy_notes?: string[];
  requires_explicit_media?: boolean;
}): RelevantContextPlan {
  const usesCamera = plan.recommended_tools.includes("take_camera_snapshot");
  const usesScreen = plan.recommended_tools.includes("take_screen_snapshot");
  return {
    ...plan,
    avoided_tools:
      plan.avoided_tools ??
      [
        ...(usesCamera ? [] : ["take_camera_snapshot"]),
        ...(usesScreen ? [] : ["take_screen_snapshot"]),
      ],
    requires_explicit_media: plan.requires_explicit_media ?? (usesCamera || usesScreen),
    fallbacks:
      plan.fallbacks ??
      ["If a recommended Sense capability is denied or unavailable, say exactly what is missing and answer from non-visual context only."],
    privacy_notes:
      plan.privacy_notes ??
      ["Use the minimum Sense tool needed. Do not capture camera or screen content unless the user made a current visual request."],
  };
}

export function planRelevantContext(userRequest: string): RelevantContextPlan {
  const text = userRequest.toLowerCase();

  if (
    includesAny(text, [
      /\bread my messages?\b/,
      /\bread.*\b(dm|dms|slack|email|mail|inbox)\b/,
      /\bwatch me\b/,
      /\bmonitor me\b/,
      /\binfer what i am typing\b/,
    ])
  ) {
    return withDefaults({
      intent: "privacy_boundary",
      confidence: "high",
      minimum_tool: "none",
      relevant_domains: [],
      recommended_tools: [],
      avoided_tools: ["take_camera_snapshot", "take_screen_snapshot"],
      guidance: [
        "Do not capture or read private messages, keystrokes, or ongoing screen content.",
        "Explain the privacy boundary and offer a safer alternative such as asking the user to paste selected text.",
      ],
      fallbacks: ["Use privacy-preserving guidance only; do not try a different Sense tool to bypass the boundary."],
      privacy_notes: ["Message contents, keystrokes, and background monitoring are outside the Sense privacy model."],
    });
  }

  if (
    includesAny(text, [
      /\bwrite\b/,
      /\bdraft\b/,
      /\brewrite\b/,
      /\bedit\b/,
      /\bemail\b/,
      /\bpost\b/,
      /\barticle\b/,
    ]) &&
    includesAny(text, [/\bdo not use camera\b/, /\bno camera\b/, /\bwithout (a )?screenshot\b/])
  ) {
    return withDefaults({
      intent: "writing_or_general_help",
      confidence: "high",
      minimum_tool: "none",
      relevant_domains: [],
      recommended_tools: [],
      avoided_tools: ["take_camera_snapshot", "take_screen_snapshot"],
      guidance: ["Do not use camera or screen tools for this writing request unless the user changes the request."],
      fallbacks: ["Proceed from the text the user supplied and ask for pasted context only if needed."],
      privacy_notes: ["The user explicitly constrained media use; honor that constraint."],
    });
  }

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

    return withDefaults({
      intent: "visual_appearance_check",
      confidence: "high",
      minimum_tool: "take_camera_snapshot",
      relevant_domains: ["user", "environment"],
      recommended_tools: ["take_camera_snapshot"],
      snapshot_mode: snapshotMode,
      guidance: [
        "Use an explicit camera snapshot because the user asked about current visual appearance.",
        "Inspect snapshot_path before answering.",
      ],
      fallbacks: [
        "If camera is disabled, tell the user to enable SENSE_CAMERA_SNAPSHOT=1 or use the Sense panel.",
        "If capture is denied, point to macOS Camera privacy permissions.",
      ],
      privacy_notes: ["explicit camera use is justified only because this is a current visual appearance request."],
    });
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
    return withDefaults({
      intent: "screen_debug",
      confidence: "high",
      minimum_tool: "take_screen_snapshot",
      relevant_domains: ["screen"],
      recommended_tools: ["take_screen_snapshot"],
      snapshot_mode: includesAny(text, [/\bui\b/, /\bdesign\b/, /\blayout\b/])
        ? "ui_feedback"
        : "screen_debug",
      guidance: [
        "Use an explicit screen snapshot because the user referenced current on-screen content.",
        "Inspect snapshot_path before answering.",
      ],
      fallbacks: [
        "If screen capture is disabled, tell the user to enable SENSE_SCREEN_SNAPSHOT=1 or use the Sense panel.",
        "If capture is denied, point to macOS Screen Recording permissions.",
      ],
      privacy_notes: ["Avoid reading private messages or secrets from the screenshot; summarize only what is needed for the request."],
    });
  }

  if (includesAny(text, [/\bdesk\b/, /\bwhat is this\b/, /\bobject\b/])) {
    return withDefaults({
      intent: "visual_appearance_check",
      confidence: "medium",
      minimum_tool: "take_camera_snapshot",
      relevant_domains: ["environment"],
      recommended_tools: ["take_camera_snapshot"],
      snapshot_mode: "desk_check",
      guidance: ["Use camera only if the user is referring to the physical room or desk."],
      privacy_notes: ["Camera use is only appropriate if the referent is physical, not on-screen/private content."],
    });
  }

  if (
    includesAny(text, [
      /\bbefore my (next )?meeting\b/,
      /\bnext meeting\b/,
      /\bfast\b/,
      /\bquick\b/,
      /\btime\b/,
      /\bdeadline\b/,
    ])
  ) {
    return withDefaults({
      intent: "time_pressure",
      confidence: "high",
      minimum_tool: "get_schedule_context",
      relevant_domains: ["schedule", "user"],
      recommended_tools: ["get_schedule_context", "get_user_state"],
      guidance: ["Use schedule pressure and presence to size the recommendation."],
    });
  }

  if (includesAny(text, [/\bwhat am i working on\b/, /\bwhat should i do next\b/, /\bcurrent project\b/, /\brepo\b/])) {
    return withDefaults({
      intent: "current_work",
      confidence: "high",
      minimum_tool: "get_context_frame",
      relevant_domains: ["screen", "user", "schedule"],
      recommended_tools: ["get_context_frame"],
      guidance: ["Use active app, workspace state, and schedule pressure."],
    });
  }

  if (includesAny(text, [/\bdeep work\b/, /\bfocus\b/, /\bshould i work\b/, /\bstate\b/])) {
    return withDefaults({
      intent: "focus_state",
      confidence: "medium",
      minimum_tool: "get_context_frame",
      relevant_domains: ["user", "environment", "schedule"],
      recommended_tools: ["get_context_frame"],
      guidance: ["Use user state, environment, and schedule pressure."],
    });
  }

  if (includesAny(text, [/\bwhere am i\b/, /\bnoise\b/, /\bbattery\b/, /\blighting\b/, /\benvironment\b/])) {
    return withDefaults({
      intent: "environment_check",
      confidence: "medium",
      minimum_tool: "get_environment_context",
      relevant_domains: ["environment"],
      recommended_tools: ["get_environment_context"],
      guidance: ["Use ambient context only; avoid snapshots unless explicitly visual."],
    });
  }

  return withDefaults({
    intent: "general_context",
    confidence: "low",
    minimum_tool: "get_context_frame",
    relevant_domains: ["screen", "user", "environment", "schedule"],
    recommended_tools: ["get_context_frame"],
    guidance: ["Use the full frame only if the request benefits from local context."],
  });
}
