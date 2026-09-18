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
import { createDevicesSensor, parseDisplayCount, parseNearbyDevices } from "../src/sensors/devices.js";
import { classifyLocation, createLocationSensor } from "../src/sensors/location.js";
import { parseMediaState } from "../src/sensors/media.js";
import {
  createFullScreenSnapshotCapture,
  createWindowSnapshotCapture,
  persistScreenSnapshotBuffer,
} from "../src/sensors/screenSnapshot.js";
import { parseWorkspaceStatus } from "../src/sensors/workspace.js";
import { run } from "../src/sensors/exec.js";
import { createIdleSensor, parseIdleSeconds } from "../src/sensors/idle.js";
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
      .mockResolvedValueOnce("sense-mcp — frame.ts — user@example.com");
    const sensor = createActiveWindowSensor({
      isMac: true,
      runCommand,
      rawTitlesEnabled: async () => true,
    });

    const observations = await sensor.sample();

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(observations[0].fields.sensitivity_level).toBe("normal");
    expect(observations[0].fields.active_window_title).toBe("sense-mcp — frame.ts — [email]");
    expect(observations[0].fields.title_withheld).toBeUndefined();
  });

  test("withholds a title its own classifier rated high-sensitivity", async () => {
    const highSensitivityTitles = [
      "1Password — Chase Bank",
      "Epic — Patient Chart — J. Smith",
      ".env — SENSE_API_KEY",
    ];

    for (const title of highSensitivityTitles) {
      const runCommand = vi
        .fn<typeof import("../src/sensors/exec.js").run>()
        .mockResolvedValueOnce("Code")
        .mockResolvedValueOnce(title);
      const sensor = createActiveWindowSensor({
        isMac: true,
        runCommand,
        rawTitlesEnabled: async () => true,
      });

      const observations = await sensor.sample();

      expect(observations[0].fields.sensitivity_level).toBe("high");
      expect(observations[0].fields.active_window_title).toBeUndefined();
      expect(observations[0].fields.title_withheld).toBe("sensitivity");
      expect(JSON.stringify(observations[0].fields)).not.toContain(title);
    }
  });

  /**
   * SPEC.md:215-219 names email subjects and message-thread names as things a
   * raw title must not carry. Those rate *medium*, not high, and redactTitle
   * strips only emails, URLs and 6+ digit runs — so on a medium title there is
   * no substring to strip and the payload crossed intact.
   *
   * Shapes below mirror titles captured live on this machine via the sensor's
   * own TITLE_SCRIPT (names replaced): Messages' front window is a bare thread
   * name, Slack's is "<Person> (DM) - <Workspace> - Slack". Mail was not
   * running, so its subject-line shape is the one case not live-captured.
   */
  test("withholds a title its own classifier rated medium-sensitivity", async () => {
    const mediumSensitivityTitles: Array<{ app: string; title: string }> = [
      { app: "Mail", title: "Re: Q3 payroll adjustments — final numbers" },
      { app: "Messages", title: "Weekend Crew" },
      { app: "Slack", title: "Dana Kim (DM) - Northwind - Slack" },
    ];

    for (const { app, title } of mediumSensitivityTitles) {
      const runCommand = vi
        .fn<typeof import("../src/sensors/exec.js").run>()
        .mockResolvedValueOnce(app)
        .mockResolvedValueOnce(title);
      const sensor = createActiveWindowSensor({
        isMac: true,
        runCommand,
        rawTitlesEnabled: async () => true,
      });

      const observations = await sensor.sample();

      expect(observations[0].fields.sensitivity_level).toBe("medium");
      expect(observations[0].fields.active_window_title).toBeUndefined();
      expect(observations[0].fields.title_withheld).toBe("sensitivity");
      expect(JSON.stringify(observations[0].fields)).not.toContain(title);
    }
  });
});

describe("idle sensor acquisition", () => {
  test("bounds the IOHIDSystem dump so presence cannot be lost to the exec buffer", async () => {
    const runCommand = vi
      .fn<typeof import("../src/sensors/exec.js").run>()
      .mockResolvedValue('"HIDIdleTime" = 2500000000');
    const sensor = createIdleSensor({ isMac: true, runCommand });

    const observations = await sensor.sample();

    expect(runCommand.mock.calls[0]?.[1]).toEqual(["-r", "-c", "IOHIDSystem", "-d", "1"]);
    expect(observations[0].fields.presence).toBe("active");
    expect(sensor.diagnose?.()).toBeNull();
  });

  test("reports a diagnostic instead of looking healthy when ioreg yields nothing", async () => {
    const sensor = createIdleSensor({
      isMac: true,
      runCommand: vi.fn<typeof import("../src/sensors/exec.js").run>().mockResolvedValue(null),
    });

    await expect(sensor.sample()).resolves.toEqual([]);
    expect(sensor.diagnose?.()?.reason).toBe("idle_signal_unavailable");
  });

  test("reports a diagnostic when IOHIDSystem carries no HIDIdleTime", async () => {
    const sensor = createIdleSensor({
      isMac: true,
      runCommand: vi
        .fn<typeof import("../src/sensors/exec.js").run>()
        .mockResolvedValue('+-o IOHIDSystem  <class IOHIDSystem>\n  "IOClass" = "IOHIDSystem"'),
    });

    await expect(sensor.sample()).resolves.toEqual([]);
    expect(sensor.diagnose?.()?.reason).toBe("idle_parse_failed");
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

/**
 * Captured verbatim from `system_profiler SPDisplaysDataType` on an Apple
 * silicon laptop with one internal display and no external displays. The
 * "Graphics/Displays:" and GPU-name headers are what real output always
 * carries, and what the old line-counting parser mistook for displays.
 */
const REAL_DISPLAY_TEXT = `Graphics/Displays:

    Apple M3 Max:

      Chipset Model: Apple M3 Max
      Type: GPU
      Bus: Built-In
      Total Number of Cores: 40
      Vendor: Apple (0x106b)
      Metal Support: Metal 4
      Displays:
        Color LCD:
          Display Type: Built-in Liquid Retina XDR Display
          Resolution: 3456 x 2234 Retina
          Main Display: Yes
          Mirror: Off
          Online: Yes
          Automatically Adjust Brightness: No
          Connection Type: Internal
`;

/** The same machine, via `system_profiler -json SPDisplaysDataType`. */
const REAL_DISPLAY_JSON = JSON.stringify({
  SPDisplaysDataType: [
    {
      _name: "Apple M3 Max",
      spdisplays_ndrvs: [
        {
          _name: "Color LCD",
          spdisplays_connection_type: "spdisplays_internal",
          spdisplays_display_type: "spdisplays_built-in-liquid-retina-xdr",
          spdisplays_main: "spdisplays_yes",
        },
      ],
      sppci_device_type: "spdisplays_gpu",
    },
  ],
});

const DISPLAY_JSON_WITH_EXTERNAL = JSON.stringify({
  SPDisplaysDataType: [
    {
      _name: "Apple M3 Max",
      spdisplays_ndrvs: [
        { _name: "Color LCD", spdisplays_connection_type: "spdisplays_internal" },
        { _name: "Studio Display", spdisplays_connection_type: "spdisplays_displayport_dongle" },
      ],
    },
  ],
});

/**
 * (c) Structurally valid, and silent about displays: the key parses to an array, but nothing in it
 * ever lists a display. That is not the same fact as "no external displays are attached".
 */
const DISPLAY_JSON_NO_ADAPTERS = JSON.stringify({ SPDisplaysDataType: [] });
const DISPLAY_JSON_ADAPTER_WITHOUT_DISPLAY_LIST = JSON.stringify({
  SPDisplaysDataType: [{ _name: "Apple M3 Max", sppci_device_type: "spdisplays_gpu" }],
});
/** A GPU that really does list its displays and has none attached — a genuine zero. */
const DISPLAY_JSON_EMPTY_DISPLAY_LIST = JSON.stringify({
  SPDisplaysDataType: [{ _name: "Apple M3 Max", spdisplays_ndrvs: [] }],
});

/**
 * Modern `system_profiler SPBluetoothDataType` text: devices are grouped under
 * "Connected:" / "Not Connected:" section headers. macOS no longer emits the
 * per-device "Connected: Yes" line the old parser looked for.
 */
const BLUETOOTH_TEXT_WITH_CONNECTED = `Bluetooth:

      Bluetooth Controller:
          State: On
      Connected:
          Example AirPods Pro:
              Address: 00:00:00:00:00:00
              Minor Type: Headphones
          Magic Keyboard with Numeric Keypad:
              Address: 00:00:00:00:00:00
              Minor Type: Keyboard
      Not Connected:
          Example Soundbar:
              Address: 00:00:00:00:00:00
              Minor Type: Speaker
`;

/**
 * Captured on this Mac from `system_profiler -json SPBluetoothDataType` with AirPods Pro genuinely
 * connected, so the `device_connected` true path is exercised against a payload macOS really
 * emitted — nested single-key objects, the full per-device attribute set, and a sibling
 * `device_not_connected` group alongside it. The previous true-path fixture for this branch was
 * hand-written from the shape of the false-path one, which is how a fixture ends up agreeing with
 * a parser instead of testing it.
 *
 * Sanitized for a public repository: Bluetooth addresses are zeroed, serial numbers masked, and
 * the owner's personal device names ("<first name>'s iPad", a soundbar's brand and model) replaced
 * with "Example ..." equivalents. All of those identify the machine or its owner and none of them
 * is read by the parser — except the device *name*, whose only load-bearing property is whether it
 * matches /AirPods/i or the input-device pattern, which the replacements preserve. Every other
 * value is verbatim.
 */
const REAL_BLUETOOTH_JSON_AIRPODS_CONNECTED = JSON.stringify({
  "SPBluetoothDataType": [
    {
      "controller_properties": {
        "controller_address": "00:00:00:00:00:00",
        "controller_chipset": "BCM_4388",
        "controller_discoverable": "attrib_off",
        "controller_firmwareVersion": "24.1.584.4713",
        "controller_productID": "0x4A2F",
        "controller_state": "attrib_on",
        "controller_supportedServices": "0x1390039 < HFP AVRCP A2DP HID LEA AACP GATT SerialPort SCO >",
        "controller_transport": "PCIe",
        "controller_vendorID": "0x004C (Apple)"
      },
      "device_connected": [
        {
          "AirPods Pro": {
            "device_address": "00:00:00:00:00:00",
            "device_batteryLevelCase": "80%",
            "device_batteryLevelLeft": "100%",
            "device_batteryLevelRight": "100%",
            "device_caseVersion": "9A348",
            "device_firmwareVersion": "9A348",
            "device_minorType": "Headphones",
            "device_productID": "0x2014",
            "device_rssi": "-67",
            "device_serialNumber": "XXXXXXXXXXXX",
            "device_serialNumberLeft": "XXXXXXXXXXXX",
            "device_serialNumberRight": "XXXXXXXXXXXX",
            "device_services": "0x980019 < HFP AVRCP A2DP AACP GATT ACL >",
            "device_vendorID": "0x004C"
          }
        }
      ],
      "device_not_connected": [
        {
          "[Example] Soundbar": {
            "device_address": "00:00:00:00:00:00",
            "device_minorType": "Speaker"
          }
        },
        {
          "Example iPad": {
            "device_address": "00:00:00:00:00:00",
            "device_rssi": "-46"
          }
        },
        {
          "Example AirPods": {
            "device_address": "00:00:00:00:00:00",
            "device_caseVersion": "1.208.8",
            "device_firmwareVersion": "6A326",
            "device_minorType": "Headphones",
            "device_productID": "0x2013",
            "device_serialNumber": "XXXXXXXXXXXX",
            "device_serialNumberLeft": "XXXXXXXXXXXX",
            "device_serialNumberRight": "XXXXXXXXXXXX",
            "device_vendorID": "0x004C"
          }
        },
        {
          "Magic Keyboard with Numeric Keypad": {
            "device_address": "00:00:00:00:00:00",
            "device_firmwareVersion": "2.0.6",
            "device_minorType": "Keyboard",
            "device_productID": "0x026C",
            "device_vendorID": "0x004C"
          }
        }
      ]
    }
  ]
});

/**
 * The same real capture with one change: the "Magic Keyboard with Numeric Keypad" entry — itself
 * captured verbatim from this Mac's `device_not_connected` group — moved into `device_connected`.
 *
 * That one move is synthetic and is called out here because it could not be captured live: the
 * keyboard is paired but powered off, and driving a Bluetooth connection needs a helper this
 * machine does not have. Everything about the entry (its attribute set, its `device_minorType`,
 * its nesting) is real; only which group it sits in was edited, and that is exactly the field
 * `parseNearbyDevices` keys off.
 */
const REAL_BLUETOOTH_JSON_INPUT_CONNECTED = JSON.stringify({
  "SPBluetoothDataType": [
    {
      "controller_properties": {
        "controller_address": "00:00:00:00:00:00",
        "controller_chipset": "BCM_4388",
        "controller_discoverable": "attrib_off",
        "controller_firmwareVersion": "24.1.584.4713",
        "controller_productID": "0x4A2F",
        "controller_state": "attrib_on",
        "controller_supportedServices": "0x1390039 < HFP AVRCP A2DP HID LEA AACP GATT SerialPort SCO >",
        "controller_transport": "PCIe",
        "controller_vendorID": "0x004C (Apple)"
      },
      "device_connected": [
        {
          "AirPods Pro": {
            "device_address": "00:00:00:00:00:00",
            "device_batteryLevelCase": "80%",
            "device_batteryLevelLeft": "100%",
            "device_batteryLevelRight": "100%",
            "device_caseVersion": "9A348",
            "device_firmwareVersion": "9A348",
            "device_minorType": "Headphones",
            "device_productID": "0x2014",
            "device_rssi": "-67",
            "device_serialNumber": "XXXXXXXXXXXX",
            "device_serialNumberLeft": "XXXXXXXXXXXX",
            "device_serialNumberRight": "XXXXXXXXXXXX",
            "device_services": "0x980019 < HFP AVRCP A2DP AACP GATT ACL >",
            "device_vendorID": "0x004C"
          }
        },
        {
          "Magic Keyboard with Numeric Keypad": {
            "device_address": "00:00:00:00:00:00",
            "device_firmwareVersion": "2.0.6",
            "device_minorType": "Keyboard",
            "device_productID": "0x026C",
            "device_vendorID": "0x004C"
          }
        }
      ],
      "device_not_connected": [
        {
          "[Example] Soundbar": {
            "device_address": "00:00:00:00:00:00",
            "device_minorType": "Speaker"
          }
        },
        {
          "Example iPad": {
            "device_address": "00:00:00:00:00:00",
            "device_rssi": "-46"
          }
        },
        {
          "Example AirPods": {
            "device_address": "00:00:00:00:00:00",
            "device_caseVersion": "1.208.8",
            "device_firmwareVersion": "6A326",
            "device_minorType": "Headphones",
            "device_productID": "0x2013",
            "device_serialNumber": "XXXXXXXXXXXX",
            "device_serialNumberLeft": "XXXXXXXXXXXX",
            "device_serialNumberRight": "XXXXXXXXXXXX",
            "device_vendorID": "0x004C"
          }
        }
      ]
    }
  ]
});

/**
 * The same real capture with the `device_connected` group removed, which is what macOS emits when
 * nothing is connected: the key is absent entirely rather than present and empty. Identifiers are
 * zeroed as above.
 */
const REAL_BLUETOOTH_JSON_NONE_CONNECTED = JSON.stringify({
  "SPBluetoothDataType": [
    {
      "controller_properties": {
        "controller_address": "00:00:00:00:00:00",
        "controller_chipset": "BCM_4388",
        "controller_discoverable": "attrib_off",
        "controller_firmwareVersion": "24.1.584.4713",
        "controller_productID": "0x4A2F",
        "controller_state": "attrib_on",
        "controller_supportedServices": "0x1390039 < HFP AVRCP A2DP HID LEA AACP GATT SerialPort SCO >",
        "controller_transport": "PCIe",
        "controller_vendorID": "0x004C (Apple)"
      },
      "device_not_connected": [
        {
          "[Example] Soundbar": {
            "device_address": "00:00:00:00:00:00",
            "device_minorType": "Speaker"
          }
        },
        {
          "Example iPad": {
            "device_address": "00:00:00:00:00:00",
            "device_rssi": "-46"
          }
        },
        {
          "Example AirPods": {
            "device_address": "00:00:00:00:00:00",
            "device_caseVersion": "1.208.8",
            "device_firmwareVersion": "6A326",
            "device_minorType": "Headphones",
            "device_productID": "0x2013",
            "device_serialNumber": "XXXXXXXXXXXX",
            "device_serialNumberLeft": "XXXXXXXXXXXX",
            "device_serialNumberRight": "XXXXXXXXXXXX",
            "device_vendorID": "0x004C"
          }
        },
        {
          "Magic Keyboard with Numeric Keypad": {
            "device_address": "00:00:00:00:00:00",
            "device_firmwareVersion": "2.0.6",
            "device_minorType": "Keyboard",
            "device_productID": "0x026C",
            "device_vendorID": "0x004C"
          }
        }
      ]
    }
  ]
});

/**
 * (b) The pre-Ventura `-json SPBluetoothDataType` shape: one flat `device_title` list, with the
 * connection state carried per device as `device_isconnected` rather than by which group the
 * device sits in. Modelled on that macOS generation's output — this machine runs a newer one and
 * cannot emit it — with the same nested single-key-object structure and the same device names,
 * device kinds and attribute spellings the modern capture above uses, so the only thing that
 * differs between the two fixtures is the shape under test. Identifiers are synthetic throughout.
 *
 * Read with the modern keys alone, this payload yields two confident `false` fields and no
 * diagnostic: AirPods that are genuinely connected reported as disconnected, silently.
 */
function legacyBluetoothJson(connected: { airpods: boolean; keyboard: boolean }): string {
  const flag = (on: boolean) => (on ? "attrib_Yes" : "attrib_No");
  return JSON.stringify({
    "SPBluetoothDataType": [
      {
        "local_device_title": {
          "general_address": "00:00:00:00:00:00",
          "general_name": "Example MacBook Pro",
          "general_powerState": "attrib_on",
        },
        "device_title": [
          {
            "AirPods Pro": {
              "device_addr": "00:00:00:00:00:00",
              "device_isconnected": flag(connected.airpods),
              "device_minorType": "Headphones",
              "device_services": "0x980019",
            },
          },
          {
            "Magic Keyboard with Numeric Keypad": {
              "device_addr": "00:00:00:00:00:00",
              "device_isconnected": flag(connected.keyboard),
              "device_minorType": "Keyboard",
            },
          },
          {
            "[Example] Soundbar": {
              "device_addr": "00:00:00:00:00:00",
              "device_isconnected": "attrib_No",
              "device_minorType": "Speaker",
            },
          },
        ],
      },
    ],
  });
}

const LEGACY_BLUETOOTH_JSON_AIRPODS_CONNECTED = legacyBluetoothJson({
  airpods: true,
  keyboard: false,
});
/** The keyboard connected too, so the two fields are shown moving independently. */
const LEGACY_BLUETOOTH_JSON_INPUT_CONNECTED = legacyBluetoothJson({
  airpods: true,
  keyboard: true,
});
/** Nothing connected: a real, earned false rather than a false from an unread shape. */
const LEGACY_BLUETOOTH_JSON_NONE_CONNECTED = legacyBluetoothJson({
  airpods: false,
  keyboard: false,
});

/**
 * (b) Parses as JSON, has the expected top-level key, and carries no device list either shape
 * knows — a stand-in for whatever macOS renames these keys to next. There is no true answer to
 * read out of it, so the only honest output is none.
 */
const BLUETOOTH_JSON_UNRECOGNIZED_SHAPE = JSON.stringify({
  "SPBluetoothDataType": [
    {
      "controller_properties": {
        "controller_address": "00:00:00:00:00:00",
        "controller_state": "attrib_on",
      },
      "devices_by_connection_state": [{ "AirPods Pro": { "device_minorType": "Headphones" } }],
    },
  ],
});

/** Stands in for system_profiler: text by default, JSON when asked for it. */
function fakeSystemProfiler(responses: {
  displayText: string;
  displayJson: string;
  bluetoothText: string;
  bluetoothJson: string;
}): typeof import("../src/sensors/exec.js").run {
  return async (command, args) => {
    if (command !== "system_profiler") return null;
    const json = args.includes("-json");
    if (args.includes("SPDisplaysDataType")) {
      return json ? responses.displayJson : responses.displayText;
    }
    if (args.includes("SPBluetoothDataType")) {
      return json ? responses.bluetoothJson : responses.bluetoothText;
    }
    return null;
  };
}

describe("device context parsing", () => {
  test("counts only non-internal displays", () => {
    expect(parseDisplayCount(REAL_DISPLAY_JSON)).toBe(0);
    expect(parseDisplayCount(DISPLAY_JSON_WITH_EXTERNAL)).toBe(1);
  });

  test("omits rather than guesses a display count it cannot parse", () => {
    expect(parseDisplayCount(REAL_DISPLAY_TEXT)).toBeNull();
    expect(parseDisplayCount("")).toBeNull();
    expect(parseDisplayCount('{"SPDisplaysDataType": "nope"}')).toBeNull();
  });

  /**
   * (c) "No external displays" and "this payload never mentioned displays" are different facts,
   * and only the first one is a zero. Returning 0 for the second put a number the payload never
   * supported in front of the model, and left multi_display false on a machine nothing was
   * measured about.
   */
  test("separates no external displays from a payload that never said", () => {
    // Never said: no adapters at all, or adapters that carry no display list.
    expect(parseDisplayCount(DISPLAY_JSON_NO_ADAPTERS)).toBeNull();
    expect(parseDisplayCount(DISPLAY_JSON_ADAPTER_WITHOUT_DISPLAY_LIST)).toBeNull();

    // Said zero: a display list that is present and empty, and this Mac's real internal-only list.
    expect(parseDisplayCount(DISPLAY_JSON_EMPTY_DISPLAY_LIST)).toBe(0);
    expect(parseDisplayCount(REAL_DISPLAY_JSON)).toBe(0);
  });

  test("reports a diagnostic rather than zero displays for a payload that never said", async () => {
    const sensor = createDevicesSensor({
      isMac: true,
      runCommand: fakeSystemProfiler({
        displayText: REAL_DISPLAY_TEXT,
        displayJson: DISPLAY_JSON_NO_ADAPTERS,
        bluetoothText: BLUETOOTH_TEXT_WITH_CONNECTED,
        bluetoothJson: REAL_BLUETOOTH_JSON_NONE_CONNECTED,
      }),
    });

    const [observation] = await sensor.sample();

    expect(observation.fields.external_display_count).toBeUndefined();
    expect(observation.fields.multi_display).toBeUndefined();
    expect(sensor.diagnose?.()?.reason).toBe("device_profile_parse_failed");
  });

  test("reads connected Bluetooth devices from the grouped modern payload", () => {
    // Real capture, AirPods Pro connected and no input device connected: the two fields must move
    // independently, which a fixture with both connected at once cannot show.
    expect(parseNearbyDevices(REAL_BLUETOOTH_JSON_AIRPODS_CONNECTED)).toEqual({
      airpods_connected: true,
      bluetooth_input_connected: false,
    });
    expect(parseNearbyDevices(REAL_BLUETOOTH_JSON_INPUT_CONNECTED)).toEqual({
      airpods_connected: true,
      bluetooth_input_connected: true,
    });
    expect(parseNearbyDevices(REAL_BLUETOOTH_JSON_NONE_CONNECTED)).toEqual({
      airpods_connected: false,
      bluetooth_input_connected: false,
    });
  });

  /**
   * (b) The pre-Ventura payload puts the connection state on each device instead of grouping by
   * it. Reading only `device_connected` found no such key, fell through to the defaults, and
   * returned two confident `false` fields with diagnose() still null — connected AirPods reported
   * as absent, with nothing anywhere saying the payload had not been read.
   */
  test("reads connected Bluetooth devices from the legacy flat payload", () => {
    expect(parseNearbyDevices(LEGACY_BLUETOOTH_JSON_AIRPODS_CONNECTED)).toEqual({
      airpods_connected: true,
      bluetooth_input_connected: false,
    });
    expect(parseNearbyDevices(LEGACY_BLUETOOTH_JSON_INPUT_CONNECTED)).toEqual({
      airpods_connected: true,
      bluetooth_input_connected: true,
    });
    // Present but flagged not-connected is a real false, not a fallthrough one.
    expect(parseNearbyDevices(LEGACY_BLUETOOTH_JSON_NONE_CONNECTED)).toEqual({
      airpods_connected: false,
      bluetooth_input_connected: false,
    });
  });

  test("omits rather than guesses Bluetooth state it cannot parse", () => {
    expect(parseNearbyDevices(BLUETOOTH_TEXT_WITH_CONNECTED)).toBeNull();
    expect(parseNearbyDevices("")).toBeNull();
  });

  /**
   * (b) A shape neither branch recognises must not fall through to false either. This is the case
   * that makes the recognition explicit rather than relying on "the modern keys were missing, so
   * presumably nothing is connected".
   */
  test("omits Bluetooth state for a shape neither branch recognises", () => {
    expect(parseNearbyDevices(BLUETOOTH_JSON_UNRECOGNIZED_SHAPE)).toBeNull();
    expect(parseNearbyDevices('{"SPBluetoothDataType": [{}]}')).toBeNull();
  });
});

describe("device context acquisition", () => {
  test("does not invent external displays on an Apple silicon machine with none", async () => {
    const sensor = createDevicesSensor({
      isMac: true,
      runCommand: fakeSystemProfiler({
        displayText: REAL_DISPLAY_TEXT,
        displayJson: REAL_DISPLAY_JSON,
        bluetoothText: BLUETOOTH_TEXT_WITH_CONNECTED,
        bluetoothJson: REAL_BLUETOOTH_JSON_NONE_CONNECTED,
      }),
    });

    const [observation] = await sensor.sample();

    expect(observation.fields.external_display_count).toBe(0);
    expect(observation.fields.multi_display).toBe(false);
    expect(sensor.diagnose?.()).toBeNull();
  });

  test("sees Bluetooth devices macOS groups under a Connected section", async () => {
    const sensor = createDevicesSensor({
      isMac: true,
      runCommand: fakeSystemProfiler({
        displayText: REAL_DISPLAY_TEXT,
        displayJson: DISPLAY_JSON_WITH_EXTERNAL,
        bluetoothText: BLUETOOTH_TEXT_WITH_CONNECTED,
        bluetoothJson: REAL_BLUETOOTH_JSON_INPUT_CONNECTED,
      }),
    });

    const [observation] = await sensor.sample();

    expect(observation.fields.external_display_count).toBe(1);
    expect(observation.fields.airpods_connected).toBe(true);
    expect(observation.fields.bluetooth_input_connected).toBe(true);
  });

  test("sees connected devices on a Mac emitting the legacy Bluetooth payload", async () => {
    const sensor = createDevicesSensor({
      isMac: true,
      runCommand: fakeSystemProfiler({
        displayText: REAL_DISPLAY_TEXT,
        displayJson: REAL_DISPLAY_JSON,
        bluetoothText: BLUETOOTH_TEXT_WITH_CONNECTED,
        bluetoothJson: LEGACY_BLUETOOTH_JSON_AIRPODS_CONNECTED,
      }),
    });

    const [observation] = await sensor.sample();

    expect(observation.fields.airpods_connected).toBe(true);
    expect(observation.fields.bluetooth_input_connected).toBe(false);
    expect(sensor.diagnose?.()).toBeNull();
  });

  test("omits Bluetooth fields and says so for a payload shape it does not recognise", async () => {
    const sensor = createDevicesSensor({
      isMac: true,
      runCommand: fakeSystemProfiler({
        displayText: REAL_DISPLAY_TEXT,
        displayJson: REAL_DISPLAY_JSON,
        bluetoothText: BLUETOOTH_TEXT_WITH_CONNECTED,
        bluetoothJson: BLUETOOTH_JSON_UNRECOGNIZED_SHAPE,
      }),
    });

    const [observation] = await sensor.sample();

    // The displays still parsed, so the observation stands; only the unread fields are absent.
    expect(observation.fields.external_display_count).toBe(0);
    expect(observation.fields.airpods_connected).toBeUndefined();
    expect(observation.fields.bluetooth_input_connected).toBeUndefined();
    expect(sensor.diagnose?.()?.reason).toBe("device_profile_parse_failed");
    expect(sensor.diagnose?.()?.detail).toContain("Bluetooth");
  });

  test("omits unparseable fields and says so rather than reporting zeroes", async () => {
    const sensor = createDevicesSensor({
      isMac: true,
      runCommand: async () => "not json at all",
    });

    await expect(sensor.sample()).resolves.toEqual([]);
    expect(sensor.diagnose?.()?.reason).toBe("device_profile_parse_failed");
  });

  /**
   * The same silent-failure class that killed the idle sensor: no output means
   * no fields, and with no diagnostic the sensor reads as healthy while
   * returning nothing. diagnose() exists precisely to make that visible.
   */
  test("reports a diagnostic instead of looking healthy when system_profiler yields nothing", async () => {
    const sensor = createDevicesSensor({
      isMac: true,
      runCommand: async () => null,
    });

    await expect(sensor.sample()).resolves.toEqual([]);
    expect(sensor.diagnose?.()?.reason).toBe("device_profile_unavailable");
    expect(sensor.diagnose?.()?.detail).toContain("SPDisplaysDataType");
    expect(sensor.diagnose?.()?.detail).toContain("SPBluetoothDataType");
  });

  /**
   * (f) The two probes fail independently. A run where one goes silent and the other returns
   * something unreadable used to report only the silent reason, so the parse failure — the one
   * that means this parser has fallen behind the payload shape — vanished from the diagnostic.
   */
  test("reports a silent probe and a parse failure distinctly when both happen at once", async () => {
    const sensor = createDevicesSensor({
      isMac: true,
      runCommand: async (_command, args) =>
        args.includes("SPDisplaysDataType") ? null : "not json at all",
    });

    await expect(sensor.sample()).resolves.toEqual([]);
    const diagnostic = sensor.diagnose?.();
    expect(diagnostic?.reason).toBe("device_profile_unavailable_and_parse_failed");
    expect(diagnostic?.detail).toContain("produced no output");
    expect(diagnostic?.detail).toContain("unexpected format");

    // The single-cause reasons stay exactly as they were.
    const silentOnly = createDevicesSensor({ isMac: true, runCommand: async () => null });
    await silentOnly.sample();
    expect(silentOnly.diagnose?.()?.reason).toBe("device_profile_unavailable");

    const parseOnly = createDevicesSensor({ isMac: true, runCommand: async () => "not json at all" });
    await parseOnly.sample();
    expect(parseOnly.diagnose?.()?.reason).toBe("device_profile_parse_failed");
  });

  test("still reports a diagnostic when only one profiler call goes silent", async () => {
    const sensor = createDevicesSensor({
      isMac: true,
      runCommand: async (command, args) =>
        args.includes("SPDisplaysDataType") ? REAL_DISPLAY_JSON : null,
    });

    const [observation] = await sensor.sample();

    expect(observation.fields.external_display_count).toBe(0);
    expect(observation.fields.airpods_connected).toBeUndefined();
    expect(sensor.diagnose?.()?.reason).toBe("device_profile_unavailable");
    expect(sensor.diagnose?.()?.detail).toContain("SPBluetoothDataType");
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

  /**
   * `networksetup -getairportnetwork` answers "You are not associated with an AirPort network." on
   * a zero exit for several unrelated causes. These pin that the diagnostic names the cause that
   * actually applies rather than asserting the one that sounds actionable.
   */
  function locationSensorWith(
    power: { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean } | null,
  ) {
    return createLocationSensor({
      isMac: true,
      policyEnabled: async () => true,
      runCommand: async () => "You are not associated with an AirPort network.",
      captureCommand: async (_command, args) => {
        if (!args.includes("-getairportpower") || !power) return null;
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...power };
      },
      env: {},
    });
  }

  test("reports a diagnostic when macOS withholds the SSID on a zero exit", async () => {
    const sensor = locationSensorWith({ stdout: "Wi-Fi Power (en0): On" });

    await expect(sensor.sample()).resolves.toEqual([]);
    expect(sensor.diagnose?.()?.reason).toBe("location_ssid_withheld");
  });

  /**
   * (e) The same nameless output means "not on Wi-Fi at all" on a wired Mac or with Wi-Fi off.
   * Telling that user to grant Location Services sends them to a setting that changes nothing.
   */
  test("does not blame a permission when there is no Wi-Fi network to read", async () => {
    const off = locationSensorWith({ stdout: "Wi-Fi Power (en0): Off" });
    await expect(off.sample()).resolves.toEqual([]);
    const offDiagnostic = off.diagnose?.();
    expect(offDiagnostic?.reason).toBe("location_wifi_powered_off");
    expect(offDiagnostic?.detail).toMatch(/turned off/i);
    expect(`${offDiagnostic?.detail} ${offDiagnostic?.fixHint}`).not.toMatch(/Location Services/i);

    /*
     * Captured live from `networksetup -getairportpower en5` on a port that really is not Wi-Fi:
     * the sentence lands on stdout, an "** Error:" line lands on stderr, and the process exits 10.
     * A stdout-only runner that nulls out non-zero exits never sees the sentence at all, which is
     * why this branch has to read the captured result rather than a trimmed stdout string.
     */
    const wired = locationSensorWith({
      stdout: "en0 is not a Wi-Fi interface.",
      stderr: "** Error: Error obtaining wireless information.",
      exitCode: 10,
    });
    await expect(wired.sample()).resolves.toEqual([]);
    const wiredDiagnostic = wired.diagnose?.();
    expect(wiredDiagnostic?.reason).toBe("location_wifi_interface_absent");
    expect(`${wiredDiagnostic?.detail} ${wiredDiagnostic?.fixHint}`).not.toMatch(/Location Services/i);
  });

  /**
   * (a) A power probe that answers nothing establishes nothing. Reporting
   * `location_wifi_interface_absent` for it told a user whose Wi-Fi is on and working that en0 is
   * not a Wi-Fi interface — the same wrong-cause failure, pointed the other way. The honest answer
   * is to say the cause is unknown and name what would settle it.
   */
  test("says the cause is unestablished when the Wi-Fi power probe itself fails", async () => {
    for (const probe of [
      null,
      { stdout: "", stderr: "", exitCode: 1 },
      { stdout: "", stderr: "", exitCode: null as unknown as number, timedOut: true },
      { stdout: "some future networksetup wording", exitCode: 0 },
    ]) {
      const sensor = locationSensorWith(probe);
      await expect(sensor.sample()).resolves.toEqual([]);
      const diagnostic = sensor.diagnose?.();
      const message = `${diagnostic?.detail} ${diagnostic?.fixHint}`;

      expect(diagnostic?.reason).toBe("location_wifi_probe_failed");
      // It must not assert any of the four causes it did not establish.
      expect(message).toMatch(/not established/i);
      expect(message).not.toMatch(/en0 is not a Wi-Fi interface/i);
      expect(message).not.toMatch(/Wi-Fi is turned off/i);
      // And it has to say what would settle it.
      expect(message).toMatch(/networksetup -getairportpower en0/);
    }

    // A timed-out probe says so, since that is the one thing about it that was established.
    const timedOut = locationSensorWith({ stdout: "", timedOut: true });
    await timedOut.sample();
    expect(timedOut.diagnose?.()?.detail).toMatch(/timed out/i);
  });

  /**
   * (e) With Wi-Fi on, a withheld SSID and an unjoined radio are genuinely indistinguishable from
   * this command, so the message has to carry both instead of picking one.
   */
  test("names both causes when Wi-Fi is on and the SSID is still absent", async () => {
    const sensor = locationSensorWith({ stdout: "Wi-Fi Power (en0): On" });
    await sensor.sample();
    const diagnostic = sensor.diagnose?.();
    const message = `${diagnostic?.detail} ${diagnostic?.fixHint}`;

    expect(diagnostic?.reason).toBe("location_ssid_withheld");
    expect(message).toMatch(/not joined/i);
    expect(message).toMatch(/Location Services/i);
    // The permission is offered conditionally, not asserted as the cause.
    expect(message).toMatch(/if you are/i);
  });

  /**
   * Pins the invariant that made classifyLocation's old null branch dead: an
   * absent SSID leaves via the diagnostic above, so classification is only ever
   * reached with a real name. "unknown" is a classification outcome for an
   * unrecognised network, never a stand-in for a missing one.
   */
  test("classifies only when an SSID is actually present", async () => {
    const withheld = createLocationSensor({
      isMac: true,
      policyEnabled: async () => true,
      runCommand: async () => "You are not associated with an AirPort network.",
      // Stubbed so the missing-SSID path never shells out to the real networksetup under test.
      captureCommand: async () => ({ stdout: "Wi-Fi Power (en0): On", stderr: "", exitCode: 0, timedOut: false }),
      env: {},
    });
    const observations = await withheld.sample();
    expect(observations).toEqual([]);
    expect(JSON.stringify(observations)).not.toContain("location_class");

    const associated = createLocationSensor({
      isMac: true,
      policyEnabled: async () => true,
      runCommand: async () => "Current Wi-Fi Network: HomeNet",
      env: { SENSE_HOME_WIFI_SSIDS: "HomeNet" },
    });
    const [observation] = await associated.sample();
    expect(observation.fields.location_class).toBe("home_office");
    expect(JSON.stringify(observation.fields)).not.toContain("HomeNet");
    expect(associated.diagnose?.()).toBeNull();
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
