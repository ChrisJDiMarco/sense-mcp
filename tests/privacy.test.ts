import { describe, expect, test } from "vitest";
import { computePrivacy } from "../src/privacy.js";
import type { Sensor } from "../src/types.js";

const sensor = (name: string, capability: string, tier: number): Sensor => ({
  name,
  intervalMs: 1,
  tier,
  capability,
  sample: async () => [],
});

const screenSensor = sensor("active-window", "screen_activity", 1);
const presenceSensor = sensor("idle", "presence", 1);
const mockScreenSensor = sensor("mock", "screen_activity", 1);

describe("computePrivacy", () => {
  test("granted when active+yielding, denied when active but silent", () => {
    const p = computePrivacy(
      [screenSensor, presenceSensor],
      { active: new Set(["active-window", "idle"]), yielding: new Set(["active-window"]) },
      { isMac: true, rawTitles: false, cameraSnapshot: false, screenSnapshot: false },
    );
    expect(p.capabilities.screen_activity).toBe("granted");
    expect(p.capabilities.presence).toBe("denied");
    expect(p.tier).toBe(1);
  });

  test("includes capability details for silent sensors with diagnostics", () => {
    const p = computePrivacy(
      [presenceSensor],
      {
        active: new Set(["idle"]),
        yielding: new Set<string>(),
        diagnostics: new Map([
          [
            "idle",
            {
              reason: "permission_denied",
              detail: "Presence sensor is not yielding.",
              fixHint: "Grant permission.",
            },
          ],
        ]),
      },
      { isMac: true, rawTitles: false, cameraSnapshot: false, screenSnapshot: false },
    );

    expect(p.capabilities.presence).toBe("denied");
    expect(p.capability_details?.presence).toEqual({
      sensor: "idle",
      reason: "permission_denied",
      detail: "Presence sensor is not yielding.",
      fix_hint: "Grant permission.",
    });
  });

  test("unavailable when no sensor is active on this platform", () => {
    const p = computePrivacy(
      [screenSensor],
      { active: new Set<string>(), yielding: new Set<string>() },
      { isMac: false, rawTitles: false, cameraSnapshot: false, screenSnapshot: false },
    );
    expect(p.capabilities.screen_activity).toBe("unavailable");
    expect(p.capabilities.raw_window_titles).toBe("unavailable");
    expect(p.tier).toBe(0);
  });

  test("raw titles: denied until opt-in, granted with opt-in (tier 3)", () => {
    const status = {
      active: new Set(["active-window"]),
      yielding: new Set(["active-window"]),
    };
    const denied = computePrivacy([screenSensor], status, {
      isMac: true,
      rawTitles: false,
      cameraSnapshot: false,
      screenSnapshot: false,
    });
    expect(denied.capabilities.raw_window_titles).toBe("denied");

    const granted = computePrivacy([screenSensor], status, {
      isMac: true,
      rawTitles: true,
      cameraSnapshot: false,
      screenSnapshot: false,
    });
    expect(granted.capabilities.raw_window_titles).toBe("granted");
    expect(granted.tier).toBe(3);
  });

  test("lists unimplemented capabilities as unavailable", () => {
    const p = computePrivacy(
      [],
      { active: new Set<string>(), yielding: new Set<string>() },
      { isMac: true, rawTitles: false, cameraSnapshot: false, screenSnapshot: false },
    );
    expect(p.capabilities.camera_attention).toBe("unavailable");
  });

  test("camera snapshot is denied until explicit opt-in", () => {
    const cameraSensor = sensor("camera", "camera_snapshot", 3);
    const status = { active: new Set(["camera"]), yielding: new Set(["camera"]) };

    const denied = computePrivacy([cameraSensor], status, {
      isMac: true,
      rawTitles: false,
      cameraSnapshot: false,
      screenSnapshot: false,
    });
    expect(denied.capabilities.camera_snapshot).toBe("denied");

    const granted = computePrivacy([cameraSensor], status, {
      isMac: true,
      rawTitles: false,
      cameraSnapshot: true,
      screenSnapshot: false,
    });
    expect(granted.capabilities.camera_snapshot).toBe("granted");
    expect(granted.tier).toBe(3);
  });

  test("merges duplicate capability sensors without downgrading granted status", () => {
    const p = computePrivacy(
      [screenSensor, mockScreenSensor],
      { active: new Set(["active-window"]), yielding: new Set(["active-window"]) },
      { isMac: true, rawTitles: false, cameraSnapshot: false, screenSnapshot: false },
    );
    expect(p.capabilities.screen_activity).toBe("granted");
  });

  test("screen snapshot is explicit opt-in", () => {
    const denied = computePrivacy([], { active: new Set(), yielding: new Set() }, {
      isMac: true,
      rawTitles: false,
      cameraSnapshot: false,
      screenSnapshot: false,
    });
    expect(denied.capabilities.screen_snapshot).toBe("denied");

    const granted = computePrivacy([], { active: new Set(), yielding: new Set() }, {
      isMac: true,
      rawTitles: false,
      cameraSnapshot: false,
      screenSnapshot: true,
    });
    expect(granted.capabilities.screen_snapshot).toBe("granted");
    expect(granted.tier).toBe(3);
  });
});
