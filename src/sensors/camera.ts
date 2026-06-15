import type { Observation, Sensor } from "../types.js";
import { isMac, runBuffer, runCapture } from "./exec.js";
import {
  persistSnapshotBuffer as persistSnapshotFileBuffer,
  type PersistedSnapshot,
} from "../snapshotFiles.js";

const TTL_MS = 120_000;

export interface CameraDevice {
  index: number;
  label: string;
}

export type CameraSnapshotMode =
  | "appearance_check"
  | "hair_check"
  | "outfit_check"
  | "lighting_check"
  | "desk_check"
  | "object_identification"
  | "general_visual";

export interface CameraSnapshot {
  ok: boolean;
  generated_at: string;
  mode: CameraSnapshotMode;
  mimeType?: "image/png";
  data?: string;
  path?: string;
  markdown_image?: string;
  size_bytes?: number;
  device_label?: string;
  error?: string;
}

function classifyCameraLabel(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("obs") || lower.includes("virtual")) return "virtual_camera";
  if (lower.includes("desk view")) return "desk_camera";
  if (lower.includes("iphone")) return "phone_camera";
  if (lower.includes("facetime") || lower.includes("built-in") || lower.includes("hd camera")) {
    return "built_in_camera";
  }
  if (lower.includes("capture screen")) return "screen_capture";
  return "camera";
}

export function parseAvfoundationDevices(output: string): CameraDevice[] {
  const devices: CameraDevice[] = [];
  let inVideo = false;

  for (const line of output.split("\n")) {
    if (line.includes("AVFoundation video devices")) {
      inVideo = true;
      continue;
    }
    if (line.includes("AVFoundation audio devices")) break;
    if (!inVideo) continue;

    const match = line.match(/\[(\d+)]\s+(.+)$/);
    if (!match) continue;

    const label = classifyCameraLabel(match[2]);
    if (label === "screen_capture") continue;
    devices.push({ index: Number(match[1]), label });
  }

  return devices;
}

async function listCameraDevices(): Promise<CameraDevice[]> {
  const result = await runCapture(
    "ffmpeg",
    ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
    5000,
  );
  if (!result) return [];
  return parseAvfoundationDevices(`${result.stdout}\n${result.stderr}`);
}

export function cameraSnapshotEnabled(): boolean {
  return process.env.SENSE_CAMERA_SNAPSHOT === "1";
}

export async function persistSnapshotBuffer(
  buffer: Buffer,
  generatedAt: string,
): Promise<PersistedSnapshot> {
  return persistSnapshotFileBuffer("camera", buffer, generatedAt);
}

export async function takeCameraSnapshot(
  deviceIndex = 0,
  mode: CameraSnapshotMode = "general_visual",
): Promise<CameraSnapshot> {
  const generatedAt = new Date().toISOString();
  if (!cameraSnapshotEnabled()) {
    return {
      ok: false,
      generated_at: generatedAt,
      mode,
      error: "camera_snapshot_not_enabled",
    };
  }

  const devices = await listCameraDevices();
  const selected = devices.find((device) => device.index === deviceIndex) ?? devices[0];
  if (!selected) {
    return {
      ok: false,
      generated_at: generatedAt,
      mode,
      error: "camera_unavailable",
    };
  }

  const buffer = await runBuffer(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "avfoundation",
      "-framerate",
      "30",
      "-i",
      `${selected.index}:none`,
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "-",
    ],
    8000,
  );

  if (!buffer) {
    return {
      ok: false,
      generated_at: generatedAt,
      mode,
      device_label: selected.label,
      error: "camera_capture_failed_or_denied",
    };
  }

  const persisted = await persistSnapshotBuffer(buffer, generatedAt);

  return {
    ok: true,
    generated_at: generatedAt,
    mode,
    mimeType: "image/png",
    data: buffer.toString("base64"),
    ...persisted,
    device_label: selected.label,
  };
}

/** Camera availability only. The actual image capture is an explicit MCP tool. */
export const cameraSensor: Sensor = {
  name: "camera",
  intervalMs: 120_000,
  tier: 3,
  capability: "camera_snapshot",
  available: async () => isMac,
  async sample(): Promise<Observation[]> {
    const devices = await listCameraDevices();
    if (devices.length === 0) return [];

    return [
      {
        sensor: "camera",
        domain: "environment",
        fields: {
          camera_available: true,
          camera_device_count: devices.length,
          camera_default_label: devices[0].label,
        },
        observedAt: Date.now(),
        ttlMs: TTL_MS,
      },
    ];
  },
};
