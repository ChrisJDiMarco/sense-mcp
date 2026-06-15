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
  | "no_local_context_needed"
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

function isWritingRequest(text: string): boolean {
  return includesAny(text, [
    /\bwrite\b/,
    /\bdraft\b/,
    /\brewrite\b/,
    /\bedit\b/,
    /\bemail\b/,
    /\bpost\b/,
    /\barticle\b/,
  ]);
}

function isCurrentAppearanceRequest(text: string): boolean {
  return includesAny(text, [
    /\bhow do i look\b/,
    /\bdo i look\b/,
    /\bhow'?s my hair\b/,
    /\bdoes my hair\b/,
    /\bis my hair\b/,
    /\bmy hair look\b/,
    /\boutfit check\b/,
    /\bfit check\b/,
    /\bdo i look tired\b/,
    /\bmy face\b/,
    /\bready (for|to).*(call|meeting|recording|video)\b/,
    /\b(before i start|before recording|start recording)\b/,
    /\b(my|me|i).*\blighting\b.*\b(call|meeting|recording|video|camera)\b/,
    /\blighting\b.*\b(my|me|call|meeting|recording|video|camera)\b/,
  ]);
}

function isCurrentScreenRequest(text: string): boolean {
  return includesAny(text, [
    /\bon my screen\b/,
    /\bmy screen\b/,
    /\bthis screen\b/,
    /\bcurrent screen\b/,
    /\bthis ui\b/,
    /\bthis interface\b/,
    /\bthis layout\b/,
    /\bthis error\b/,
    /\bthis page\b/,
    /\bcurrent page\b/,
    /\bthis window\b/,
    /\bcurrent window\b/,
    /\bcurrent app\b/,
    /\bcurrent app state\b/,
    /\bwhat am i looking at\b/,
    /\bwhat'?s visible\b/,
    /\bvisible on (the|my) screen\b/,
    /\bwhat should i click\b/,
    /\bwhat to click next\b/,
    /\bdecide what to click next\b/,
    /\bpage readable\b/,
    /\breview this\b.*\b(screen|ui|page|layout)\b/,
    /\bsummarize this\b.*\b(screen|page|ui)\b/,
  ]);
}

function isPhysicalDeicticRequest(text: string): boolean {
  return includesAny(text, [
    /\bon my desk\b/,
    /\bmy desk\b/,
    /\bin my room\b/,
    /\bbehind me\b/,
    /\bthis thing\b/,
    /\bthis object\b/,
    /\bwhat is this\b.*\b(thing|object|on my desk|in my room|behind me)\b/,
  ]);
}

function isTimePressureRequest(text: string): boolean {
  return includesAny(text, [
    /\bbefore my (next )?meeting\b/,
    /\bbefore (the|a|my) (call|meeting|deadline)\b/,
    /\bnext meeting\b/,
    /\bdeadline\b/,
    /\btime pressure\b/,
    /\brunning out of time\b/,
    /\bhow much can i .*before\b/,
    /\b(5|10|15|20|30|45|60)[ -]?minute\b/,
    /\bten[ -]?minute\b/,
    /\bin \d+ minutes?\b/,
    /\bknock this out fast\b/,
    /\bget this done fast\b/,
    /\bdo this fast\b/,
    /\bquick plan\b/,
    /\bprep for anything coming up\b/,
    /\bdo i need to prep\b/,
    /\bsend this now or wait\b/,
    /\bstart a big refactor right now\b/,
  ]);
}

function isCurrentWorkRequest(text: string): boolean {
  return includesAny(text, [
    /\bwhat am i working on\b/,
    /\bwhat should i work on next\b/,
    /\bwhat should i do next\b/,
    /\bcurrent project\b/,
    /\bcurrent repo\b/,
    /\bwhat project\b/,
    /\bworkspace\b/,
    /\brepo\b/,
    /\bchoose between debugging\b/,
    /\bdebugging, writing, or admin\b/,
    /\brun tests now\b/,
    /\bshould i run tests\b/,
    /\bshould i commit\b/,
    /\bcommit before\b/,
    /\bwork mode\b/,
    /\bhandoff note\b/,
    /\bsafest next engineering step\b/,
  ]);
}

function isFocusStateRequest(text: string): boolean {
  return includesAny(text, [
    /\bdeep work\b/,
    /\bfocus\b/,
    /\bshould i work\b/,
    /\bgood state\b.*\b(work|focus)\b/,
    /\bmy state\b.*\b(work|focus|deep)\b/,
    /\bcurrent state\b.*\b(work|focus|deep)\b/,
    /\bactive or away\b/,
  ]);
}

function isExplicitContextRequest(text: string): boolean {
  return includesAny(text, [
    /\bwhat context\b/,
    /\bwhat can you see\b/,
    /\bwhat do you know about me right now\b/,
    /\bmy situation\b/,
    /\bmy current context\b/,
    /\bfit my situation\b/,
    /\bcapabilities\b.*\b(granted|denied|unavailable)\b/,
    /\bminimum sense tool\b/,
  ]);
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
      /\b(read|copy|extract|show|tell me).*\b(password|passcode|2fa|otp|security code|credit card|ssn|api key|secret)\b/,
      /\bprivate messages?\b/,
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
    isWritingRequest(text) &&
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

  if (isCurrentAppearanceRequest(text)) {
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

  if (isCurrentScreenRequest(text)) {
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

  if (isPhysicalDeicticRequest(text)) {
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
      /\bwhere am i\b/,
      /\bnoise\b/,
      /\bbattery\b/,
      /\bplugged in\b/,
      /\bpower\b/,
      /\blighting\b/,
      /\benvironment\b/,
      /\bmedia playing\b/,
      /\bmedia\b/,
      /\bsetup\b.*\b(long|work|block|call)\b/,
      /\blong work block\b/,
    ])
  ) {
    return withDefaults({
      intent: "environment_check",
      confidence: "medium",
      minimum_tool: "get_environment_context",
      relevant_domains: ["environment"],
      recommended_tools: ["get_environment_context"],
      guidance: ["Use ambient context only; avoid snapshots unless explicitly visual."],
    });
  }

  if (isTimePressureRequest(text)) {
    return withDefaults({
      intent: "time_pressure",
      confidence: "high",
      minimum_tool: "get_schedule_context",
      relevant_domains: ["schedule", "user"],
      recommended_tools: ["get_schedule_context", "get_user_state"],
      guidance: ["Use schedule pressure and presence to size the recommendation."],
    });
  }

  if (isCurrentWorkRequest(text)) {
    return withDefaults({
      intent: "current_work",
      confidence: "high",
      minimum_tool: "get_context_frame",
      relevant_domains: ["screen", "user", "schedule"],
      recommended_tools: ["get_context_frame"],
      guidance: ["Use active app, workspace state, and schedule pressure."],
    });
  }

  if (isFocusStateRequest(text)) {
    return withDefaults({
      intent: "focus_state",
      confidence: "medium",
      minimum_tool: "get_context_frame",
      relevant_domains: ["user", "environment", "schedule"],
      recommended_tools: ["get_context_frame"],
      guidance: ["Use user state, environment, and schedule pressure."],
    });
  }

  if (isWritingRequest(text)) {
    return withDefaults({
      intent: "writing_or_general_help",
      confidence: "medium",
      minimum_tool: "none",
      relevant_domains: [],
      recommended_tools: [],
      guidance: ["Do not use Sense tools for ordinary writing unless the user references current local context."],
      fallbacks: ["Proceed from the text the user supplied and ask for pasted context only if needed."],
      privacy_notes: ["No current local context was required for this writing request."],
    });
  }

  if (isExplicitContextRequest(text)) {
    return withDefaults({
      intent: "general_context",
      confidence: "medium",
      minimum_tool: "get_context_frame",
      relevant_domains: ["screen", "user", "environment", "schedule"],
      recommended_tools: ["get_context_frame"],
      guidance: ["Use semantic context only; avoid camera and screen snapshots unless separately justified."],
    });
  }

  return withDefaults({
    intent: "no_local_context_needed",
    confidence: "low",
    minimum_tool: "none",
    relevant_domains: [],
    recommended_tools: [],
    guidance: ["No local Sense context is needed for this request."],
    fallbacks: ["Answer normally without calling additional Sense tools."],
    privacy_notes: ["Avoid collecting local context when the request is not about the user's current situation."],
  });
}
