import { describe, expect, test } from "vitest";
import { derivePosture } from "../src/posture.js";
import type { ContextFrame } from "../src/types.js";

const frame = (over: Partial<ContextFrame>): ContextFrame => ({
  spec: "context-frame/0.2",
  generated_at: "",
  staleness_ms: 0,
  privacy: { tier: 0, capabilities: {} },
  assistive_posture: "unknown",
  ...over,
});

describe("derivePosture", () => {
  test("active with no time pressure → available", () => {
    expect(
      derivePosture(frame({ user: { presence: "active", input_cadence: "sparse" } })),
    ).toBe("available");
  });

  test("steady input in a focus activity → do_not_interrupt", () => {
    expect(
      derivePosture(
        frame({
          user: { presence: "active", input_cadence: "steady" },
          screen: { activity_class: "coding" },
        }),
      ),
    ).toBe("do_not_interrupt");
  });

  test("idle → lightly_available", () => {
    expect(derivePosture(frame({ user: { presence: "idle" } }))).toBe("lightly_available");
  });

  test("in a meeting → urgent_only", () => {
    expect(derivePosture(frame({ schedule: { in_meeting: true } }))).toBe("urgent_only");
  });

  test("insufficient signal → unknown", () => {
    expect(derivePosture(frame({}))).toBe("unknown");
  });
});
