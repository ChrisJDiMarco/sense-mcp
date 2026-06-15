import { describe, expect, test } from "vitest";
import { planRelevantContext } from "../src/relevance.js";

describe("planRelevantContext", () => {
  test("routes appearance checks to camera snapshot with appearance mode", () => {
    const plan = planRelevantContext("how do I look right now?");
    expect(plan.intent).toBe("visual_appearance_check");
    expect(plan.minimum_tool).toBe("take_camera_snapshot");
    expect(plan.recommended_tools).toContain("take_camera_snapshot");
    expect(plan.snapshot_mode).toBe("appearance_check");
    expect(plan.relevant_domains).toContain("environment");
    expect(plan.requires_explicit_media).toBe(true);
    expect(plan.privacy_notes.join(" ")).toContain("explicit");
  });

  test("routes hair checks to camera snapshot with hair mode", () => {
    const plan = planRelevantContext("how's my hair?");
    expect(plan.intent).toBe("visual_appearance_check");
    expect(plan.snapshot_mode).toBe("hair_check");
  });

  test("routes screen/UI questions to screen snapshot", () => {
    const plan = planRelevantContext("what is this error on my screen?");
    expect(plan.intent).toBe("screen_debug");
    expect(plan.minimum_tool).toBe("take_screen_snapshot");
    expect(plan.recommended_tools).toContain("take_screen_snapshot");
    expect(plan.snapshot_mode).toBe("screen_debug");
    expect(plan.relevant_domains).toContain("screen");
  });

  test("routes urgency/time prompts to schedule and user state", () => {
    const plan = planRelevantContext("help me knock this out fast before my meeting");
    expect(plan.intent).toBe("time_pressure");
    expect(plan.minimum_tool).toBe("get_schedule_context");
    expect(plan.recommended_tools).toEqual(["get_schedule_context", "get_user_state"]);
    expect(plan.relevant_domains).toEqual(["schedule", "user"]);
    expect(plan.avoided_tools).toContain("take_camera_snapshot");
  });

  test("avoids media tools when prompt asks for non-visual writing help", () => {
    const plan = planRelevantContext("write this email. Do not use camera unless necessary.");
    expect(plan.intent).toBe("writing_or_general_help");
    expect(plan.minimum_tool).toBe("none");
    expect(plan.recommended_tools).toEqual([]);
    expect(plan.avoided_tools).toEqual(["take_camera_snapshot", "take_screen_snapshot"]);
    expect(plan.guidance.join(" ")).toContain("Do not use camera");
  });

  test("treats message-reading requests as a privacy boundary", () => {
    const plan = planRelevantContext("read my messages on screen");
    expect(plan.intent).toBe("privacy_boundary");
    expect(plan.minimum_tool).toBe("none");
    expect(plan.recommended_tools).toEqual([]);
    expect(plan.avoided_tools).toContain("take_screen_snapshot");
    expect(plan.fallbacks.join(" ")).toContain("privacy");
  });
});
