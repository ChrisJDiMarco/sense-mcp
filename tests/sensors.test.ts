import { describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyAmbientLight, parseAmbientLight } from "../src/sensors/ambientLight.js";
import { iphoneContextObservation, sanitizeIphoneContextPayload } from "../src/iphoneContext.js";
import {
  classifyNoise,
  createAudioLevelSensor,
  parseAvfoundationAudioDevices,
  parseVolumeDetect,
} from "../src/sensors/audioLevel.js";
import { parsePmsetBattery } from "../src/sensors/battery.js";
import {
  classifyCalendarWindow,
  createCalendarSensor,
} from "../src/sensors/calendar.js";
import {
  createCameraSensor,
  createCameraSnapshotCapture,
  parseAvfoundationDevices,
  persistSnapshotBuffer,
} from "../src/sensors/camera.js";
import { parseDisplayCount, parseNearbyDevices } from "../src/sensors/devices.js";
import { classifyLocation, createLocationSensor } from "../src/sensors/location.js";
import { parseMediaState } from "../src/sensors/media.js";
import {
  createFullScreenSnapshotCapture,
  createWindowSnapshotCapture,
  persistScreenSnapshotBuffer,
} from "../src/sensors/screenSnapshot.js";
import { parseWorkspaceStatus } from "../src/sensors/workspace.js";
import { run } from "../src/sensors/exec.js";
import { parseIdleSeconds } from "../src/sensors/idle.js";
import { createActiveWindowSensor } from "../src/sensors/activeWindow.js";
import { focusModeSensor } from "../src/sensors/focusMode.js";
import { mockSensor } from "../src/sensors/mock.js";
import { timeContextSensor } from "../src/sensors/timeContext.js";

describe("sensor subprocesses", () => {
  test("terminate promptly when their AbortSignal is cancelled", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = run(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      10_000,
      controller.signal,
    );
    controller.abort();

    await expect(pending).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe("portable and explicit bridge sensors", () => {
  test("emits bounded local time context without a subprocess", async () => {
    const observations = await timeContextSensor.sample();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ sensor: "time-context", domain: "environment" });
    expect(observations[0].fields.local_time).toMatch(/^\d{2}:\d{2}$/);
  });

  test("emits deterministic mock screen and user context only when enabled", async () => {
    const previous = process.env.SENSE_MOCK;
    process.env.SENSE_MOCK = "1";
    try {
      await expect(mockSensor.available?.()).resolves.toBe(true);
      const observations = await mockSensor.sample();
      expect(observations.map((observation) => observation.domain)).toEqual(["screen", "user"]);
    } finally {
      if (previous === undefined) delete process.env.SENSE_MOCK;
      else process.env.SENSE_MOCK = previous;
    }
  });

  test("uses an explicit focus-mode override without invoking Shortcuts", async () => {
    const previous = process.env.SENSE_FOCUS_MODE;
    process.env.SENSE_FOCUS_MODE = "Do Not Disturb";
    try {
      await expect(focusModeSensor.available?.()).resolves.toBe(true);
      const observations = await focusModeSensor.sample();
      expect(observations[0].fields).toEqual({
        focus_mode: "do_not_disturb",
        do_not_disturb: true,
      });
    } finally {
      if (previous === undefined) delete process.env.SENSE_FOCUS_MODE;
      else process.env.SENSE_FOCUS_MODE = previous;
    }
  });

  test("reports an actionable no-signal state when no focus bridge is configured", async () => {
    const previousMode = process.env.SENSE_FOCUS_MODE;
    const previousShortcut = process.env.SENSE_FOCUS_SHORTCUT;
    delete process.env.SENSE_FOCUS_MODE;
    delete process.env.SENSE_FOCUS_SHORTCUT;
    try {
      await expect(focusModeSensor.sample()).resolves.toEqual([]);
      expect(focusModeSensor.diagnose?.()?.reason).toBe("missing_focus_bridge");
    } finally {
      if (previousMode === undefined) delete process.env.SENSE_FOCUS_MODE;
      else process.env.SENSE_FOCUS_MODE = previousMode;
      if (previousShortcut === undefined) delete process.env.SENSE_FOCUS_SHORTCUT;
      else process.env.SENSE_FOCUS_SHORTCUT = previousShortcut;
    }
  });
});

describe("active-window acquisition policy", () => {
  test("does not query a window title when raw-title policy is disabled", async () => {
    const runCommand = vi.fn(async () => "Code");
    const sensor = createActiveWindowSensor({
      isMac: true,
      runCommand,
      rawTitlesEnabled: async () => false,
    });

    const observations = await sensor.sample();

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(runCommand.mock.calls)).not.toContain("front window");
    expect(observations[0].fields.active_window_title).toBeUndefined();
  });

  test("queries and redacts a title only after explicit policy enablement", async () => {
    const runCommand = vi
      .fn<typeof import("../src/sensors/exec.js").run>()
      .mockResolvedValueOnce("Code")
      .mockResolvedValueOnce("Secret Project - chris@example.com");
    const sensor = createActiveWindowSensor({
      isMac: true,
      runCommand,
      rawTitlesEnabled: async () => true,
    });

    const observations = await sensor.sample();

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(observations[0].fields.active_window_title).not.toContain("chris@example.com");
  });
});

describe("battery sensor parsing", () => {
  test("extracts charge and power source from pmset", () => {
    expect(
      parsePmsetBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 42%; discharging;"),
    ).toEqual({
      battery_percent: 42,
      power_source: "battery",
      low_power: false,
    });
  });
});

describe("idle sensor parsing", () => {
  test("parses HID idle nanoseconds without invoking a shell pipeline", () => {
    expect(parseIdleSeconds('"HIDIdleTime" = 2500000000')).toBe(3);
    expect(parseIdleSeconds("missing")).toBeNull();
  });
});

describe("iPhone context bridge", () => {
  test("sanitizes self-report payloads into expiring user context", () => {
    const generatedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const payload = sanitizeIphoneContextPayload({
      type: "sense_ios_check_in",
      generated_at: generatedAt,
      expires_at: expiresAt,
      source: "iphone_action_button",
      internal_state: {
        feeling: "Focused",
        energy: 1.2,
        stress: -1,
        focus: 0.88,
        confidence: "medium",
        note: "Ready to work.",
        context_mode: "Deep Work",
        semantic_tags: ["Protect Focus", "direct", 123, "  "],
      },
      iphone_context: {
        generated_at: generatedAt,
        device: {
          battery_percent: 0.82,
          power_state: "charging",
          low_power_mode: false,
          thermal_state: "nominal",
          device_model: "iPhone",
          system_version: "26.5",
        },
        motion: {
          activity_class: "walking",
          activity_confidence: "high",
          steps_today: 1234,
          distance_meters_today: 900.2,
          floors_ascended_today: 2,
        },
        noise: {
          noise_class: "moderate",
          average_dbfs: -41.2,
          peak_dbfs: -29.1,
          sampled_seconds: 0.7,
          audio_retained: false,
        },
        health: {
          health_available: true,
          steps_today: 4321,
          active_energy_kcal_today: 220.5,
          heart_rate_bpm: 72,
          resting_heart_rate_bpm: 58,
          sleep_minutes_last_24h: 420,
        },
      },
      assistive_hint: "protect_focus_and_keep_responses_concise",
      privacy: {
        scope: "semantic_self_report",
        audio_retained: "false",
        iphone_signals: "device_motion_noise_health_summary",
        ignored: "nope",
      },
    });

    expect(payload.internal_state.feeling).toBe("focused");
    expect(payload.internal_state.energy).toBe(1);
    expect(payload.internal_state.stress).toBe(0);
    expect(payload.internal_state.context_mode).toBe("Deep Work");
    expect(payload.internal_state.semantic_tags).toEqual(["protect_focus", "direct"]);
    expect(payload.privacy.ignored).toBeUndefined();

    const observation = iphoneContextObservation(payload, Date.now());
    expect(observation?.sensor).toBe("iphone-context-bridge");
    expect(observation?.domain).toBe("user");
    expect(observation?.fields.self_report_feeling).toBe("focused");
    expect(observation?.fields.self_report_note).toBe("Ready to work.");
    expect(observation?.fields.self_report_context_mode).toBe("Deep Work");
    expect(observation?.fields.self_report_semantic_tags).toBe("protect_focus,direct");
    expect(observation?.fields.iphone_power_state).toBe("charging");
    expect(observation?.fields.iphone_activity_class).toBe("walking");
    expect(observation?.fields.iphone_noise_class).toBe("moderate");
    expect(observation?.fields.iphone_health_steps_today).toBe(4321);
  });
});

describe("audio level classification", () => {
  test("parses ffmpeg volume output into semantic noise", () => {
    const db = parseVolumeDetect("[Parsed_volumedetect_0] mean_volume: -31.5 dB");
    expect(db).toBe(-31.5);
    expect(classifyNoise(db)).toBe("moderate");
  });

  test("parses audio devices and classifies virtual inputs", () => {
    expect(
      parseAvfoundationAudioDevices(`
[AVFoundation indev] AVFoundation video devices:
[AVFoundation indev] [0] FaceTime HD Camera
[AVFoundation indev] AVFoundation audio devices:
[AVFoundation indev] [0] BoomAudio
[AVFoundation indev] [1] BlackHole 2ch
[AVFoundation indev] [2] MacBook Pro Microphone
`),
    ).toEqual([
      { index: 0, label: "virtual_audio_device" },
      { index: 1, label: "virtual_audio_device" },
      { index: 2, label: "built_in_microphone" },
    ]);
  });

  test("does not enumerate or sample a microphone while policy is disabled", async () => {
    const runCommand = vi.fn();
    const sensor = createAudioLevelSensor({
      isMac: true,
      policyEnabled: async () => false,
      runCommand,
    });

    await expect(sensor.available?.()).resolves.toBe(false);
    await expect(sensor.sample()).resolves.toEqual([]);
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("calendar pressure", () => {
  test("classifies an upcoming event only as a coarse time window", () => {
    expect(classifyCalendarWindow("within_15")).toEqual({
      in_meeting: false,
      next_event_minutes: 15,
      time_pressure: "high",
      usable_work_minutes: 12,
      work_window: "short",
      meeting_state: "upcoming",
      prep_window: "now",
    });
  });

  test("classifies no event as no pressure", () => {
    expect(classifyCalendarWindow("none")).toEqual({
      in_meeting: false,
      time_pressure: "none",
      usable_work_minutes: 120,
      work_window: "long",
      meeting_state: "free",
      prep_window: "none",
    });
  });

  test("does not execute any calendar command while policy is disabled", async () => {
    const runCommand = vi.fn();
    const sensor = createCalendarSensor({
      isMac: true,
      policyEnabled: async () => false,
      runCommand,
    });

    await expect(sensor.available?.()).resolves.toBe(false);
    await expect(sensor.sample()).resolves.toEqual([]);
    expect(runCommand).not.toHaveBeenCalled();
    expect(sensor.diagnose?.()?.reason).toBe("disabled_by_policy");
  });

  test("uses only a headless date-time query and never emits raw event data", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "/opt/homebrew/bin/icalBuddy", stderr: "", exitCode: 0, timedOut: false })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0, timedOut: false })
      .mockResolvedValueOnce({ stdout: "Jul 11, 2026 at 3:00 PM", stderr: "", exitCode: 0, timedOut: false });
    const sensor = createCalendarSensor({
      isMac: true,
      policyEnabled: async () => true,
      runCommand,
      now: () => new Date(2026, 6, 11, 14, 50, 0),
    });

    const observations = await sensor.sample();

    expect(observations[0].fields.next_event_minutes).toBe(15);
    expect(JSON.stringify(observations)).not.toContain("Jul 11");
    const calls = JSON.stringify(runCommand.mock.calls);
    expect(calls).toContain("icalBuddy");
    expect(calls).toContain("datetime");
    expect(calls).not.toContain("osascript");
    expect(calls).not.toContain("summary");
    expect(calls).not.toContain("title");
  });
});

describe("camera device parsing", () => {
  test("extracts only video devices from ffmpeg device listing", () => {
    const devices = parseAvfoundationDevices(`
[AVFoundation indev] AVFoundation video devices:
[AVFoundation indev] [0] FaceTime HD Camera
[AVFoundation indev] [1] OBS Virtual Camera
[AVFoundation indev] AVFoundation audio devices:
[AVFoundation indev] [0] MacBook Pro Microphone
`);
    expect(devices).toEqual([
      { index: 0, label: "built_in_camera" },
      { index: 1, label: "virtual_camera" },
    ]);
  });

  test("persists explicit snapshots to a private local PNG path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-camera-test-"));
    const previous = process.env.SENSE_SNAPSHOT_DIR;
    process.env.SENSE_SNAPSHOT_DIR = dir;

    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const saved = await persistSnapshotBuffer(png, "2026-06-15T10:52:06.000Z");
      const info = await stat(saved.path);

      expect(saved.path.startsWith(dir)).toBe(true);
      expect(saved.path.endsWith(".png")).toBe(true);
      expect(saved.markdown_image).toContain(saved.path);
      expect(saved.size_bytes).toBe(8);
      expect(info.mode & 0o077).toBe(0);
      expect(await readFile(saved.path)).toEqual(png);
    } finally {
      if (previous === undefined) delete process.env.SENSE_SNAPSHOT_DIR;
      else process.env.SENSE_SNAPSHOT_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("requires policy and consumes exact allow-once consent before camera acquisition", async () => {
    const order: string[] = [];
    const receipt = {
      version: 1 as const,
      id: "00000000-0000-4000-8000-000000000001",
      media_kind: "camera" as const,
      scope: "single_capture" as const,
      target: "device:2",
      reason_hash: "a".repeat(64),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "b".repeat(64),
    };
    const capture = createCameraSnapshotCapture({
      isMac: true,
      policyEnabled: async () => {
        order.push("policy");
        return true;
      },
      requestConsent: async (request) => {
        order.push(`request:${request.target}`);
        return { granted: true, receipt };
      },
      consumeConsent: async (_id, request) => {
        order.push(`consume:${request.target}`);
        return { granted: true, receipt };
      },
      listDevices: async () => {
        order.push("enumerate");
        return [{ index: 2, label: "built_in_camera" }];
      },
      captureBuffer: async () => {
        order.push("acquire");
        return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      },
      persist: async () => {
        order.push("persist");
        return { path: "/tmp/test.png", markdown_image: "![test](/tmp/test.png)", size_bytes: 4 };
      },
    });

    await expect(capture(2, "general_visual", "Check the local camera view")).resolves.toMatchObject({ ok: true });
    expect(order).toEqual([
      "policy",
      "request:device:2",
      "consume:device:2",
      "policy",
      "enumerate",
      "policy",
      "acquire",
      "policy",
      "persist",
      "policy",
    ]);
  });

  test("does not enumerate a camera when capture policy is disabled", async () => {
    const listDevices = vi.fn();
    const requestConsent = vi.fn();
    const capture = createCameraSnapshotCapture({
      isMac: true,
      policyEnabled: async () => false,
      listDevices,
      requestConsent,
    });

    await expect(capture(0, "general_visual", "Check the camera")).resolves.toMatchObject({
      ok: false,
      error: "camera_snapshot_not_enabled",
    });
    expect(listDevices).not.toHaveBeenCalled();
    expect(requestConsent).not.toHaveBeenCalled();
  });

  test("stops camera acquisition when policy is revoked during local consent", async () => {
    let policyChecks = 0;
    const listDevices = vi.fn();
    const receipt = {
      version: 1 as const,
      id: "00000000-0000-4000-8000-000000000011",
      media_kind: "camera" as const,
      scope: "single_capture" as const,
      target: "device:0",
      reason_hash: "a".repeat(64),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "b".repeat(64),
    };
    const capture = createCameraSnapshotCapture({
      isMac: true,
      policyEnabled: async () => ++policyChecks === 1,
      requestConsent: async () => ({ granted: true, receipt }),
      consumeConsent: async () => ({ granted: true, receipt }),
      listDevices,
    });

    await expect(capture(0, "general_visual", "Check this camera view")).resolves.toMatchObject({
      ok: false,
      error: "camera_policy_revoked",
    });
    expect(listDevices).not.toHaveBeenCalled();
  });

  test("stops camera acquisition when policy is revoked during device enumeration", async () => {
    let policyChecks = 0;
    const captureBuffer = vi.fn();
    const receipt = {
      version: 1 as const,
      id: "00000000-0000-4000-8000-000000000021",
      media_kind: "camera" as const,
      scope: "single_capture" as const,
      target: "device:0",
      reason_hash: "a".repeat(64),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "b".repeat(64),
    };
    const capture = createCameraSnapshotCapture({
      isMac: true,
      policyEnabled: async () => ++policyChecks < 3,
      requestConsent: async () => ({ granted: true, receipt }),
      consumeConsent: async () => ({ granted: true, receipt }),
      listDevices: async () => [{ index: 0, label: "built_in_camera" }],
      captureBuffer,
    });

    await expect(capture(0, "general_visual", "Check this camera view")).resolves.toMatchObject({
      ok: false,
      error: "camera_policy_revoked",
    });
    expect(captureBuffer).not.toHaveBeenCalled();
  });

  test("discards camera media when policy is revoked during acquisition", async () => {
    let policyChecks = 0;
    const persist = vi.fn();
    const receipt = {
      version: 1 as const,
      id: "00000000-0000-4000-8000-000000000022",
      media_kind: "camera" as const,
      scope: "single_capture" as const,
      target: "device:0",
      reason_hash: "a".repeat(64),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "b".repeat(64),
    };
    const capture = createCameraSnapshotCapture({
      isMac: true,
      policyEnabled: async () => ++policyChecks < 4,
      requestConsent: async () => ({ granted: true, receipt }),
      consumeConsent: async () => ({ granted: true, receipt }),
      listDevices: async () => [{ index: 0, label: "built_in_camera" }],
      captureBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      persist,
    });

    await expect(capture(0, "general_visual", "Check this camera view")).resolves.toMatchObject({
      ok: false,
      error: "camera_policy_revoked",
    });
    expect(persist).not.toHaveBeenCalled();
  });

  test("removes persisted camera media when policy is revoked during persistence", async () => {
    let enabled = true;
    const cleanup = vi.fn(async () => undefined);
    const receipt = {
      version: 1 as const,
      id: "00000000-0000-4000-8000-000000000027",
      media_kind: "camera" as const,
      scope: "single_capture" as const,
      target: "device:0",
      reason_hash: "a".repeat(64),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "b".repeat(64),
    };
    const capture = createCameraSnapshotCapture({
      isMac: true,
      policyEnabled: async () => enabled,
      requestConsent: async () => ({ granted: true, receipt }),
      consumeConsent: async () => ({ granted: true, receipt }),
      listDevices: async () => [{ index: 0, label: "built_in_camera" }],
      captureBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      persist: async () => {
        enabled = false;
        return { path: "/tmp/camera-persist-revoked.png", markdown_image: "![test](/tmp/camera-persist-revoked.png)", size_bytes: 4 };
      },
      cleanup,
    });

    await expect(capture(0, "general_visual", "Check this camera view")).resolves.toMatchObject({
      ok: false,
      error: "camera_policy_revoked",
    });
    expect(cleanup).toHaveBeenCalledWith("/tmp/camera-persist-revoked.png");
  });

  test("reports policy readiness without opening camera hardware", async () => {
    const sensor = createCameraSensor({
      isMac: true,
      policyEnabled: async () => true,
    });

    await expect(sensor.available?.()).resolves.toBe(true);
    await expect(sensor.sample()).resolves.toMatchObject([
      {
        fields: {
          camera_capture_enabled: true,
          camera_requires_local_consent: true,
        },
      },
    ]);

    const disabled = createCameraSensor({
      isMac: true,
      policyEnabled: async () => false,
    });
    await expect(disabled.sample()).resolves.toEqual([]);
    expect(disabled.diagnose?.()?.reason).toBe("disabled_by_policy");
  });
});

describe("screen snapshot persistence", () => {
  test("persists explicit screen snapshots to a private local PNG path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-screen-test-"));
    const previous = process.env.SENSE_SNAPSHOT_DIR;
    process.env.SENSE_SNAPSHOT_DIR = dir;

    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const saved = await persistScreenSnapshotBuffer(png, "2026-06-15T10:52:06.000Z");
      const info = await stat(saved.path);

      expect(saved.path.startsWith(dir)).toBe(true);
      expect(saved.path).toContain("sense-screen-");
      expect(saved.markdown_image).toContain(saved.path);
      expect(saved.size_bytes).toBe(8);
      expect(info.mode & 0o077).toBe(0);
      expect(await readFile(saved.path)).toEqual(png);
    } finally {
      if (previous === undefined) delete process.env.SENSE_SNAPSHOT_DIR;
      else process.env.SENSE_SNAPSHOT_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("captures one resolved window only after exact window consent is consumed", async () => {
    const order: string[] = [];
    const receipt = {
      version: 1 as const,
      id: "00000000-0000-4000-8000-000000000002",
      media_kind: "screen" as const,
      scope: "window_only" as const,
      target: "window:72:pid:660:app:Codex:bounds:10,20,1200,800",
      reason_hash: "a".repeat(64),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "b".repeat(64),
    };
    const capture = createWindowSnapshotCapture({
      isMac: true,
      policyEnabled: async () => true,
      resolveWindowTarget: async (requestedWindowId) => {
        order.push(`resolve:${requestedWindowId ?? "front"}`);
        return {
          window_id: 72,
          owner_pid: 660,
          app: "Codex",
          x: 10,
          y: 20,
          width: 1200,
          height: 800,
        };
      },
      requestConsent: async (request) => {
        order.push(`request:${request.target}`);
        return { granted: true, receipt };
      },
      consumeConsent: async (_id, request) => {
        order.push(`consume:${request.target}`);
        return { granted: true, receipt };
      },
      createPath: async () => "/tmp/sense-window-test.png",
      runCommand: async (_command, args) => {
        order.push(`capture:${args.join(" ")}`);
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      },
      readSnapshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      finalize: async () => ({ path: "/tmp/sense-window-test.png", markdown_image: "![test](/tmp/sense-window-test.png)", size_bytes: 4 }),
    });

    await expect(capture(undefined, "screen_debug", "Inspect the foreground app window")).resolves.toMatchObject({
      ok: true,
      window_id: 72,
    });
    expect(order.slice(0, 4)).toEqual([
      "resolve:front",
      "request:window:72:pid:660:app:Codex:bounds:10,20,1200,800",
      "consume:window:72:pid:660:app:Codex:bounds:10,20,1200,800",
      "resolve:72",
    ]);
    expect(order[4]).toContain("-l 72");
    expect(order[4]).not.toContain("-m");
    expect(order[5]).toBe("resolve:72");
  });

  test("full-screen capture has a distinct policy, consent scope, and main-display flag", async () => {
    const order: string[] = [];
    const receipt = {
      version: 1 as const,
      id: "00000000-0000-4000-8000-000000000003",
      media_kind: "screen" as const,
      scope: "full_screen" as const,
      target: "main-display",
      reason_hash: "a".repeat(64),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "b".repeat(64),
    };
    const capture = createFullScreenSnapshotCapture({
      isMac: true,
      policyEnabled: async () => true,
      requestConsent: async (request) => {
        order.push(`request:${request.scope}:${request.target}`);
        return { granted: true, receipt };
      },
      consumeConsent: async (_id, request) => {
        order.push(`consume:${request.scope}:${request.target}`);
        return { granted: true, receipt };
      },
      createPath: async () => "/tmp/sense-full-test.png",
      runCommand: async (_command, args) => {
        order.push(`capture:${args.join(" ")}`);
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      },
      readSnapshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      finalize: async () => ({ path: "/tmp/sense-full-test.png", markdown_image: "![test](/tmp/sense-full-test.png)", size_bytes: 4 }),
    });

    await expect(capture("screen_summary", "Inspect my entire main screen")).resolves.toMatchObject({ ok: true });
    expect(order.slice(0, 2)).toEqual([
      "request:full_screen:main-display",
      "consume:full_screen:main-display",
    ]);
    expect(order[2]).toContain("-m");
    expect(order[2]).not.toContain("-l");
  });

  test("stops window and full-screen acquisition when policy is revoked during consent", async () => {
    const windowReceipt = {
      version: 1 as const,
      id: "00000000-0000-4000-8000-000000000012",
      media_kind: "screen" as const,
      scope: "window_only" as const,
      target: "window:72:pid:660:app:Codex:bounds:10,20,1200,800",
      reason_hash: "a".repeat(64),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "b".repeat(64),
    };
    let windowPolicyChecks = 0;
    const windowCreatePath = vi.fn(async () => "/tmp/window-revoked.png");
    const windowCleanup = vi.fn(async () => undefined);
    const windowCapture = createWindowSnapshotCapture({
      isMac: true,
      policyEnabled: async () => ++windowPolicyChecks === 1,
      resolveWindowTarget: async () => ({
        window_id: 72,
        owner_pid: 660,
        app: "Codex",
        x: 10,
        y: 20,
        width: 1200,
        height: 800,
      }),
      requestConsent: async () => ({ granted: true, receipt: windowReceipt }),
      consumeConsent: async () => ({ granted: true, receipt: windowReceipt }),
      createPath: windowCreatePath,
      cleanup: windowCleanup,
    });
    await expect(
      windowCapture(undefined, "screen_debug", "Inspect this app window"),
    ).resolves.toMatchObject({ ok: false, error: "window_policy_revoked" });
    expect(windowCreatePath).toHaveBeenCalledOnce();
    expect(windowCleanup).toHaveBeenCalledWith("/tmp/window-revoked.png");

    const fullReceipt = {
      ...windowReceipt,
      id: "00000000-0000-4000-8000-000000000013",
      scope: "full_screen" as const,
      target: "main-display",
    };
    let fullPolicyChecks = 0;
    const fullCreatePath = vi.fn(async () => "/tmp/full-revoked.png");
    const fullCleanup = vi.fn(async () => undefined);
    const fullCapture = createFullScreenSnapshotCapture({
      isMac: true,
      policyEnabled: async () => ++fullPolicyChecks === 1,
      requestConsent: async () => ({ granted: true, receipt: fullReceipt }),
      consumeConsent: async () => ({ granted: true, receipt: fullReceipt }),
      createPath: fullCreatePath,
      cleanup: fullCleanup,
    });
    await expect(
      fullCapture("screen_summary", "Inspect the main display"),
    ).resolves.toMatchObject({ ok: false, error: "full_screen_policy_revoked" });
    expect(fullCreatePath).toHaveBeenCalledOnce();
    expect(fullCleanup).toHaveBeenCalledWith("/tmp/full-revoked.png");
  });

  test("stops capture when a consented window id is recycled by another app", async () => {
    const receipt = {
      version: 1 as const,
      id: "00000000-0000-4000-8000-000000000014",
      media_kind: "screen" as const,
      scope: "window_only" as const,
      target: "window:72:pid:660:app:Codex:bounds:10,20,1200,800",
      reason_hash: "a".repeat(64),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "b".repeat(64),
    };
    const createPath = vi.fn(async () => "/tmp/window-recycled.png");
    const cleanup = vi.fn(async () => undefined);
    const resolveWindowTarget = vi
      .fn()
      .mockResolvedValueOnce({ window_id: 72, owner_pid: 660, app: "Codex", x: 10, y: 20, width: 1200, height: 800 })
      .mockResolvedValueOnce({ window_id: 72, owner_pid: 991, app: "Messages", x: 10, y: 20, width: 1200, height: 800 });
    const capture = createWindowSnapshotCapture({
      isMac: true,
      policyEnabled: async () => true,
      resolveWindowTarget,
      requestConsent: async () => ({ granted: true, receipt }),
      consumeConsent: async () => ({ granted: true, receipt }),
      createPath,
      cleanup,
    });

    await expect(capture(72, "screen_debug", "Inspect the Codex window")).resolves.toMatchObject({
      ok: false,
      error: "window_target_changed",
    });
    expect(createPath).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith("/tmp/window-recycled.png");
  });

  test("discards a captured window if policy is revoked before return", async () => {
    const receipt = {
      version: 1 as const,
      id: "00000000-0000-4000-8000-000000000023",
      media_kind: "screen" as const,
      scope: "window_only" as const,
      target: "window:72:pid:660:app:Codex:bounds:10,20,1200,800",
      reason_hash: "a".repeat(64),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "b".repeat(64),
    };
    let policyChecks = 0;
    const cleanup = vi.fn(async () => undefined);
    const finalize = vi.fn();
    const capture = createWindowSnapshotCapture({
      isMac: true,
      policyEnabled: async () => ++policyChecks < 3,
      resolveWindowTarget: async () => ({
        window_id: 72,
        owner_pid: 660,
        app: "Codex",
        x: 10,
        y: 20,
        width: 1200,
        height: 800,
      }),
      requestConsent: async () => ({ granted: true, receipt }),
      consumeConsent: async () => ({ granted: true, receipt }),
      createPath: async () => "/tmp/window-post-capture-revoked.png",
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
      cleanup,
      finalize,
    });

    await expect(capture(72, "screen_debug", "Inspect the Codex window")).resolves.toMatchObject({
      ok: false,
      error: "window_policy_revoked",
    });
    expect(cleanup).toHaveBeenCalledWith("/tmp/window-post-capture-revoked.png");
    expect(finalize).not.toHaveBeenCalled();
  });

  test("discards a captured window if its identity or bounds change before return", async () => {
    const receipt = {
      version: 1 as const,
      id: "00000000-0000-4000-8000-000000000024",
      media_kind: "screen" as const,
      scope: "window_only" as const,
      target: "window:72:pid:660:app:Codex:bounds:10,20,1200,800",
      reason_hash: "a".repeat(64),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "b".repeat(64),
    };
    const target = { window_id: 72, owner_pid: 660, app: "Codex", x: 10, y: 20, width: 1200, height: 800 };
    const resolveWindowTarget = vi
      .fn()
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce({ ...target, width: 1180 });
    const cleanup = vi.fn(async () => undefined);
    const finalize = vi.fn();
    const capture = createWindowSnapshotCapture({
      isMac: true,
      policyEnabled: async () => true,
      resolveWindowTarget,
      requestConsent: async () => ({ granted: true, receipt }),
      consumeConsent: async () => ({ granted: true, receipt }),
      createPath: async () => "/tmp/window-post-capture-changed.png",
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
      cleanup,
      finalize,
    });

    await expect(capture(72, "screen_debug", "Inspect the Codex window")).resolves.toMatchObject({
      ok: false,
      error: "window_target_changed",
    });
    expect(cleanup).toHaveBeenCalledWith("/tmp/window-post-capture-changed.png");
    expect(finalize).not.toHaveBeenCalled();
  });

  test("discards a full-screen capture if policy is revoked before return", async () => {
    const receipt = {
      version: 1 as const,
      id: "00000000-0000-4000-8000-000000000025",
      media_kind: "screen" as const,
      scope: "full_screen" as const,
      target: "main-display",
      reason_hash: "a".repeat(64),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "b".repeat(64),
    };
    let policyChecks = 0;
    const cleanup = vi.fn(async () => undefined);
    const finalize = vi.fn();
    const capture = createFullScreenSnapshotCapture({
      isMac: true,
      policyEnabled: async () => ++policyChecks < 3,
      requestConsent: async () => ({ granted: true, receipt }),
      consumeConsent: async () => ({ granted: true, receipt }),
      createPath: async () => "/tmp/full-post-capture-revoked.png",
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
      cleanup,
      finalize,
    });

    await expect(capture("screen_summary", "Inspect the main display")).resolves.toMatchObject({
      ok: false,
      error: "full_screen_policy_revoked",
    });
    expect(cleanup).toHaveBeenCalledWith("/tmp/full-post-capture-revoked.png");
    expect(finalize).not.toHaveBeenCalled();
  });

  test("removes an empty screen artifact instead of returning it", async () => {
    const receipt = {
      version: 1 as const,
      id: "00000000-0000-4000-8000-000000000026",
      media_kind: "screen" as const,
      scope: "full_screen" as const,
      target: "main-display",
      reason_hash: "a".repeat(64),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "b".repeat(64),
    };
    const cleanup = vi.fn(async () => undefined);
    const finalize = vi.fn();
    const capture = createFullScreenSnapshotCapture({
      isMac: true,
      policyEnabled: async () => true,
      requestConsent: async () => ({ granted: true, receipt }),
      consumeConsent: async () => ({ granted: true, receipt }),
      createPath: async () => "/tmp/full-empty.png",
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
      readSnapshot: async () => Buffer.alloc(0),
      cleanup,
      finalize,
    });

    await expect(capture("screen_summary", "Inspect the main display")).resolves.toMatchObject({
      ok: false,
      error: "screen_capture_empty",
    });
    expect(cleanup).toHaveBeenCalledWith("/tmp/full-empty.png");
    expect(finalize).not.toHaveBeenCalled();
  });

  test("removes finalized screen media when policy is revoked during finalization", async () => {
    const windowReceipt = {
      version: 1 as const,
      id: "00000000-0000-4000-8000-000000000028",
      media_kind: "screen" as const,
      scope: "window_only" as const,
      target: "window:72:pid:660:app:Codex:bounds:10,20,1200,800",
      reason_hash: "a".repeat(64),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "b".repeat(64),
    };
    const target = { window_id: 72, owner_pid: 660, app: "Codex", x: 10, y: 20, width: 1200, height: 800 };
    let windowEnabled = true;
    const windowCleanup = vi.fn(async () => undefined);
    const windowCapture = createWindowSnapshotCapture({
      isMac: true,
      policyEnabled: async () => windowEnabled,
      resolveWindowTarget: async () => target,
      requestConsent: async () => ({ granted: true, receipt: windowReceipt }),
      consumeConsent: async () => ({ granted: true, receipt: windowReceipt }),
      createPath: async () => "/tmp/window-finalize-revoked.png",
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
      readSnapshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      finalize: async () => {
        windowEnabled = false;
        return { path: "/tmp/window-finalize-revoked.png", markdown_image: "![test](/tmp/window-finalize-revoked.png)", size_bytes: 4 };
      },
      cleanup: windowCleanup,
    });
    await expect(windowCapture(72, "screen_debug", "Inspect the Codex window")).resolves.toMatchObject({
      ok: false,
      error: "window_policy_revoked",
    });
    expect(windowCleanup).toHaveBeenCalledWith("/tmp/window-finalize-revoked.png");

    const fullReceipt = {
      ...windowReceipt,
      id: "00000000-0000-4000-8000-000000000029",
      scope: "full_screen" as const,
      target: "main-display",
    };
    let fullEnabled = true;
    const fullCleanup = vi.fn(async () => undefined);
    const fullCapture = createFullScreenSnapshotCapture({
      isMac: true,
      policyEnabled: async () => fullEnabled,
      requestConsent: async () => ({ granted: true, receipt: fullReceipt }),
      consumeConsent: async () => ({ granted: true, receipt: fullReceipt }),
      createPath: async () => "/tmp/full-finalize-revoked.png",
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
      readSnapshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      finalize: async () => {
        fullEnabled = false;
        return { path: "/tmp/full-finalize-revoked.png", markdown_image: "![test](/tmp/full-finalize-revoked.png)", size_bytes: 4 };
      },
      cleanup: fullCleanup,
    });
    await expect(fullCapture("screen_summary", "Inspect the main display")).resolves.toMatchObject({
      ok: false,
      error: "full_screen_policy_revoked",
    });
    expect(fullCleanup).toHaveBeenCalledWith("/tmp/full-finalize-revoked.png");
  });

  test("cleans window and full-screen files when finalization throws", async () => {
    const windowReceipt = {
      version: 1 as const,
      id: "00000000-0000-4000-8000-000000000030",
      media_kind: "screen" as const,
      scope: "window_only" as const,
      target: "window:72:pid:660:app:Codex:bounds:10,20,1200,800",
      reason_hash: "a".repeat(64),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "b".repeat(64),
    };
    const target = { window_id: 72, owner_pid: 660, app: "Codex", x: 10, y: 20, width: 1200, height: 800 };
    const windowCleanup = vi.fn(async () => undefined);
    const windowCapture = createWindowSnapshotCapture({
      isMac: true,
      policyEnabled: async () => true,
      resolveWindowTarget: async () => target,
      requestConsent: async () => ({ granted: true, receipt: windowReceipt }),
      consumeConsent: async () => ({ granted: true, receipt: windowReceipt }),
      createPath: async () => "/tmp/window-finalize-failed.png",
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
      readSnapshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      finalize: async () => { throw new Error("invalid PNG"); },
      cleanup: windowCleanup,
    });
    await expect(windowCapture(72, "screen_debug", "Inspect the Codex window")).resolves.toMatchObject({
      ok: false,
      error: "screen_capture_finalize_failed",
    });
    expect(windowCleanup).toHaveBeenCalledWith("/tmp/window-finalize-failed.png");

    const fullReceipt = {
      ...windowReceipt,
      id: "00000000-0000-4000-8000-000000000031",
      scope: "full_screen" as const,
      target: "main-display",
    };
    const fullCleanup = vi.fn(async () => undefined);
    const fullCapture = createFullScreenSnapshotCapture({
      isMac: true,
      policyEnabled: async () => true,
      requestConsent: async () => ({ granted: true, receipt: fullReceipt }),
      consumeConsent: async () => ({ granted: true, receipt: fullReceipt }),
      createPath: async () => "/tmp/full-finalize-failed.png",
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
      readSnapshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      finalize: async () => { throw new Error("invalid PNG"); },
      cleanup: fullCleanup,
    });
    await expect(fullCapture("screen_summary", "Inspect the main display")).resolves.toMatchObject({
      ok: false,
      error: "screen_capture_finalize_failed",
    });
    expect(fullCleanup).toHaveBeenCalledWith("/tmp/full-finalize-failed.png");
  });
});

describe("device context parsing", () => {
  test("counts external displays and classifies nearby devices", () => {
    expect(parseDisplayCount("Displays:\n Color LCD:\n Studio Display:\n")).toBe(1);
    expect(parseNearbyDevices("AirPods Pro:\n Connected: Yes\n Magic Trackpad:\n Connected: Yes")).toEqual({
      airpods_connected: true,
      bluetooth_input_connected: true,
    });
  });
});

describe("ambient light parsing", () => {
  test("classifies ALS readings", () => {
    expect(parseAmbientLight('"ALSValue" = 12')).toBe(12);
    expect(classifyAmbientLight(12)).toBe("dim");
  });
});

describe("location classification", () => {
  test("uses configured wifi names without exposing the SSID", () => {
    expect(classifyLocation("HomeNet", { home: ["HomeNet"], office: [] })).toBe("home_office");
    expect(classifyLocation("Guest Cafe", { home: [], office: [] })).toBe("cafe");
  });

  test("does not read the Wi-Fi network while location policy is disabled", async () => {
    const runCommand = vi.fn();
    const sensor = createLocationSensor({
      isMac: true,
      policyEnabled: async () => false,
      runCommand,
    });

    await expect(sensor.available?.()).resolves.toBe(false);
    await expect(sensor.sample()).resolves.toEqual([]);
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("media state parsing", () => {
  test("keeps now-playing semantic by default", () => {
    expect(parseMediaState("Spotify|playing|artist|title")).toEqual({
      media_app: "Spotify",
      media_playback: "playing",
      media_type: "music",
    });
  });

  test("production acquisition asks only for playback state", async () => {
    const source = await readFile(new URL("../src/sensors/media.ts", import.meta.url), "utf8");
    expect(source).not.toContain("artist of current track");
    expect(source).not.toContain("name of current track");
  });
});

describe("workspace status parsing", () => {
  test("extracts branch and dirty count without file names", () => {
    expect(
      parseWorkspaceStatus("sense-mcp", "## main...origin/main\n M src/server.ts\n?? tmp.txt", {
        packageJson: JSON.stringify({ scripts: { test: "vitest", build: "tsc", dev: "tsx" } }),
        packageManager: "npm",
      }),
    ).toEqual({
      workspace_name: "sense-mcp",
      git_branch: "main",
      git_dirty_count: 2,
      git_has_uncommitted_changes: true,
      git_dirty_severity: "light",
      package_manager: "npm",
      project_type: "node",
      has_test_script: true,
      has_build_script: true,
      has_dev_script: true,
      available_scripts: "build,dev,test",
      work_mode: "implementation",
    });
  });
});
