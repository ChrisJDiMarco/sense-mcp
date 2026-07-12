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
  test("reports consent compatibility separately from operational state", () => {
    const p = computePrivacy(
      [screenSensor, presenceSensor],
      { active: new Set(["active-window", "idle"]), yielding: new Set(["active-window"]) },
      { isMac: true, rawTitles: false, cameraSnapshot: false, screenSnapshot: false },
    );
    expect(p.capabilities.screen_activity).toBe("granted");
    expect(p.capabilities.presence).toBe("granted");
    expect(p.capability_states?.screen_activity).toBe("healthy");
    expect(p.capability_states?.presence).toBe("no_signal");
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
    expect(p.capability_states?.presence).toBe("permission_denied");
    expect(p.capability_details?.presence).toEqual({
      sensor: "idle",
      state: "permission_denied",
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
    expect(p.capability_states?.screen_activity).toBe("unavailable");
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
    expect(denied.capability_states?.raw_window_titles).toBe("disabled");

    const granted = computePrivacy([screenSensor], status, {
      isMac: true,
      rawTitles: true,
      cameraSnapshot: false,
      screenSnapshot: false,
    });
    expect(granted.capabilities.raw_window_titles).toBe("granted");
    expect(granted.capability_states?.raw_window_titles).toBe("healthy");
    expect(granted.tier).toBe(3);
  });

  test("lists unimplemented capabilities as unavailable", () => {
    const p = computePrivacy(
      [],
      { active: new Set<string>(), yielding: new Set<string>() },
      { isMac: true, rawTitles: false, cameraSnapshot: false, screenSnapshot: false },
    );
    expect(p.capabilities.camera_attention).toBe("unavailable");
    expect(p.capability_states?.camera_attention).toBe("unavailable");
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
    expect(denied.capability_states?.camera_snapshot).toBe("disabled");

    const granted = computePrivacy([cameraSensor], status, {
      isMac: true,
      rawTitles: false,
      cameraSnapshot: true,
      screenSnapshot: false,
    });
    expect(granted.capabilities.camera_snapshot).toBe("granted");
    expect(granted.capability_states?.camera_snapshot).toBe("healthy");
    expect(granted.tier).toBe(3);
  });

  test("merges duplicate capability sensors without downgrading granted status", () => {
    const p = computePrivacy(
      [screenSensor, mockScreenSensor],
      {
        active: new Set(["active-window", "mock"]),
        yielding: new Set(["active-window"]),
        diagnostics: new Map([
          ["mock", { reason: "sample_error", detail: "Mock sensor failed." }],
        ]),
      },
      { isMac: true, rawTitles: false, cameraSnapshot: false, screenSnapshot: false },
    );
    expect(p.capabilities.screen_activity).toBe("granted");
    expect(p.capability_states?.screen_activity).toBe("healthy");
    expect(p.capability_details?.screen_activity).toBeUndefined();
  });

  test("screen snapshot is explicit opt-in", () => {
    const denied = computePrivacy([], { active: new Set(), yielding: new Set() }, {
      isMac: true,
      rawTitles: false,
      cameraSnapshot: false,
      screenSnapshot: false,
    });
    expect(denied.capabilities.screen_snapshot).toBe("denied");
    expect(denied.capability_states?.screen_snapshot).toBe("disabled");

    const granted = computePrivacy([], { active: new Set(), yielding: new Set() }, {
      isMac: true,
      rawTitles: false,
      cameraSnapshot: false,
      screenSnapshot: true,
    });
    expect(granted.capabilities.screen_snapshot).toBe("granted");
    expect(granted.capability_states?.screen_snapshot).toBe("no_signal");
    expect(granted.tier).toBe(3);
  });

  test("full-screen capture remains disabled when only window capture is enabled", () => {
    const privacy = computePrivacy([], { active: new Set(), yielding: new Set() }, {
      isMac: true,
      rawTitles: false,
      cameraSnapshot: false,
      screenSnapshot: true,
      windowSnapshot: true,
      fullScreenSnapshot: false,
    });

    expect(privacy.capabilities.window_snapshot).toBe("granted");
    expect(privacy.capability_states?.full_screen_snapshot).toBe("disabled");
    expect(privacy.capabilities.full_screen_snapshot).toBe("denied");
  });
});
