import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyAmbientLight, parseAmbientLight } from "../src/sensors/ambientLight.js";
import { iphoneContextObservation, sanitizeIphoneContextPayload } from "../src/iphoneContext.js";
import {
  classifyNoise,
  parseAvfoundationAudioDevices,
  parseVolumeDetect,
} from "../src/sensors/audioLevel.js";
import { parsePmsetBattery } from "../src/sensors/battery.js";
import {
  calendarDiagnosticFromResult,
  classifyCalendarPressure,
  parseCalendarProbe,
} from "../src/sensors/calendar.js";
import { parseAvfoundationDevices, persistSnapshotBuffer } from "../src/sensors/camera.js";
import { parseDisplayCount, parseNearbyDevices } from "../src/sensors/devices.js";
import { classifyLocation } from "../src/sensors/location.js";
import { parseMediaState } from "../src/sensors/media.js";
import { persistScreenSnapshotBuffer } from "../src/sensors/screenSnapshot.js";
import { parseWorkspaceStatus } from "../src/sensors/workspace.js";

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
});

describe("calendar pressure", () => {
  test("parses an upcoming event without exposing its title", () => {
    const parsed = parseCalendarProbe("UPCOMING|9|Deep Work");
    expect(parsed).toEqual({
      in_meeting: false,
      next_event_label: "calendar event",
      next_event_minutes: 9,
      time_pressure: "high",
      usable_work_minutes: 6,
      work_window: "short",
      meeting_state: "upcoming",
      event_kind: "focus_block",
      prep_window: "now",
    });
  });

  test("classifies no event as no pressure", () => {
    expect(classifyCalendarPressure(null)).toEqual({
      in_meeting: false,
      time_pressure: "none",
      usable_work_minutes: 120,
      work_window: "long",
      meeting_state: "free",
      prep_window: "none",
    });
  });

  test("explains calendar timeouts", () => {
    expect(
      calendarDiagnosticFromResult({
        stdout: "",
        stderr: "",
        exitCode: 1,
        timedOut: true,
      })?.reason,
    ).toBe("calendar_query_timeout");
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
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const saved = await persistSnapshotBuffer(png, "2026-06-15T10:52:06.000Z");
      const info = await stat(saved.path);

      expect(saved.path.startsWith(dir)).toBe(true);
      expect(saved.path.endsWith(".png")).toBe(true);
      expect(saved.markdown_image).toContain(saved.path);
      expect(saved.size_bytes).toBe(4);
      expect(info.mode & 0o077).toBe(0);
      expect(await readFile(saved.path)).toEqual(png);
    } finally {
      if (previous === undefined) delete process.env.SENSE_SNAPSHOT_DIR;
      else process.env.SENSE_SNAPSHOT_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("screen snapshot persistence", () => {
  test("persists explicit screen snapshots to a private local PNG path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-screen-test-"));
    const previous = process.env.SENSE_SNAPSHOT_DIR;
    process.env.SENSE_SNAPSHOT_DIR = dir;

    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const saved = await persistScreenSnapshotBuffer(png, "2026-06-15T10:52:06.000Z");
      const info = await stat(saved.path);

      expect(saved.path.startsWith(dir)).toBe(true);
      expect(saved.path).toContain("sense-screen-");
      expect(saved.markdown_image).toContain(saved.path);
      expect(saved.size_bytes).toBe(4);
      expect(info.mode & 0o077).toBe(0);
      expect(await readFile(saved.path)).toEqual(png);
    } finally {
      if (previous === undefined) delete process.env.SENSE_SNAPSHOT_DIR;
      else process.env.SENSE_SNAPSHOT_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
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
});

describe("media state parsing", () => {
  test("keeps now-playing semantic by default", () => {
    expect(parseMediaState("Spotify|playing|artist|title")).toEqual({
      media_app: "Spotify",
      media_playback: "playing",
      media_type: "music",
    });
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
