import { describe, expect, test } from "vitest";
import { planRelevantContext } from "../src/relevance.js";

describe("planRelevantContext", () => {
  test("routes appearance checks to camera snapshot with appearance mode", () => {
    const plan = planRelevantContext("how do I look right now?");
    expect(plan.intent).toBe("visual_appearance_check");
    expect(plan.recommended_tools).toContain("take_camera_snapshot");
    expect(plan.snapshot_mode).toBe("appearance_check");
    expect(plan.relevant_domains).toContain("environment");
  });

  test("routes hair checks to camera snapshot with hair mode", () => {
    const plan = planRelevantContext("how's my hair?");
    expect(plan.intent).toBe("visual_appearance_check");
    expect(plan.snapshot_mode).toBe("hair_check");
  });

  test("routes screen/UI questions to screen snapshot", () => {
    const plan = planRelevantContext("what is this error on my screen?");
    expect(plan.intent).toBe("screen_debug");
    expect(plan.recommended_tools).toContain("take_screen_snapshot");
    expect(plan.snapshot_mode).toBe("screen_debug");
    expect(plan.relevant_domains).toContain("screen");
  });

  test("routes urgency/time prompts to schedule and user state", () => {
    const plan = planRelevantContext("help me knock this out fast before my meeting");
    expect(plan.intent).toBe("time_pressure");
    expect(plan.recommended_tools).toEqual(["get_schedule_context", "get_user_state"]);
    expect(plan.relevant_domains).toEqual(["schedule", "user"]);
  });
});
