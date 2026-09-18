import type { CaptureConsentRequest, ConsentDecision } from "../consent.js";
import { consumeConsentReceipt, requestLocalConsent } from "../consent.js";
import { policyEnabled } from "../policy.js";
import { removePrivateFile } from "../privateFiles.js";
import {
  persistSnapshotBuffer as persistSnapshotFileBuffer,
  type PersistedSnapshot,
} from "../snapshotFiles.js";
import type { Observation, Sensor, SensorDiagnostic } from "../types.js";
import { isMac, runBuffer, runCapture } from "./exec.js";

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

interface CameraCaptureDependencies {
  isMac: boolean;
  policyEnabled: () => Promise<boolean>;
  requestConsent: (request: CaptureConsentRequest) => Promise<ConsentDecision>;
  consumeConsent: (id: string, request: CaptureConsentRequest) => Promise<ConsentDecision>;
  listDevices: (signal?: AbortSignal) => Promise<CameraDevice[]>;
  captureBuffer: (deviceIndex: number, signal?: AbortSignal) => Promise<Buffer | null>;
  persist: (buffer: Buffer, generatedAt: string) => Promise<PersistedSnapshot>;
  cleanup: (file: string) => Promise<unknown>;
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

async function listCameraDevices(signal?: AbortSignal): Promise<CameraDevice[]> {
  const result = await runCapture(
    "ffmpeg",
    ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
    5_000,
    signal,
  );
  if (!result) return [];
  return parseAvfoundationDevices(`${result.stdout}\n${result.stderr}`);
}

async function captureCameraBuffer(deviceIndex: number, signal?: AbortSignal): Promise<Buffer | null> {
  return runBuffer(
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
      `${deviceIndex}:none`,
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "-",
    ],
    8_000,
    8 * 1024 * 1024,
    signal,
  );
}

export async function cameraSnapshotEnabled(): Promise<boolean> {
  return isMac && policyEnabled("camera_snapshot");
}

export async function persistSnapshotBuffer(
  buffer: Buffer,
  generatedAt: string,
): Promise<PersistedSnapshot> {
  return persistSnapshotFileBuffer("camera", buffer, generatedAt);
}

function consentError(decision: Extract<ConsentDecision, { granted: false }>): string {
  return `camera_consent_${decision.error}`;
}

export function createCameraSnapshotCapture(
  overrides: Partial<CameraCaptureDependencies> = {},
): (
  deviceIndex?: number,
  mode?: CameraSnapshotMode,
  reason?: string,
  signal?: AbortSignal,
) => Promise<CameraSnapshot> {
  const dependencies: CameraCaptureDependencies = {
    isMac,
    policyEnabled: () => policyEnabled("camera_snapshot"),
    requestConsent: requestLocalConsent,
    consumeConsent: consumeConsentReceipt,
    listDevices: listCameraDevices,
    captureBuffer: captureCameraBuffer,
    persist: persistSnapshotBuffer,
    cleanup: removePrivateFile,
    ...overrides,
  };

  return async (
    deviceIndex = 0,
    mode: CameraSnapshotMode = "general_visual",
    reason = "Explicit camera snapshot requested by the local user.",
    signal?: AbortSignal,
  ): Promise<CameraSnapshot> => {
    const generatedAt = new Date().toISOString();
    if (!dependencies.isMac || !(await dependencies.policyEnabled())) {
      return { ok: false, generated_at: generatedAt, mode, error: "camera_snapshot_not_enabled" };
    }

    const consentRequest: CaptureConsentRequest = {
      media_kind: "camera",
      scope: "single_capture",
      target: `device:${deviceIndex}`,
      reason,
    };
    const consent = await dependencies.requestConsent(consentRequest);
    if (!consent.granted) {
      return { ok: false, generated_at: generatedAt, mode, error: consentError(consent) };
    }
    const consumed = await dependencies.consumeConsent(consent.receipt.id, consentRequest);
    if (!consumed.granted) {
      return { ok: false, generated_at: generatedAt, mode, error: consentError(consumed) };
    }
    if (!(await dependencies.policyEnabled())) {
      return { ok: false, generated_at: generatedAt, mode, error: "camera_policy_revoked" };
    }

    // The receipt is consumed before camera enumeration or capture. The exact
    // device in the prompt is the only device Sense will open.
    const devices = await dependencies.listDevices(signal);
    const selected = devices.find((device) => device.index === deviceIndex);
    if (!selected) {
      return { ok: false, generated_at: generatedAt, mode, error: "camera_unavailable" };
    }
    if (!(await dependencies.policyEnabled())) {
      return { ok: false, generated_at: generatedAt, mode, error: "camera_policy_revoked" };
    }

    const buffer = await dependencies.captureBuffer(selected.index, signal);
    if (!buffer) {
      return {
        ok: false,
        generated_at: generatedAt,
        mode,
        device_label: selected.label,
        error: "camera_capture_failed_or_denied",
      };
    }
    if (!(await dependencies.policyEnabled())) {
      return { ok: false, generated_at: generatedAt, mode, error: "camera_policy_revoked" };
    }

    const persisted = await dependencies.persist(buffer, generatedAt);
    if (!(await dependencies.policyEnabled().catch(() => false))) {
      await dependencies.cleanup(persisted.path).catch(() => undefined);
      return { ok: false, generated_at: generatedAt, mode, error: "camera_policy_revoked" };
    }
    return {
      ok: true,
      generated_at: generatedAt,
      mode,
      mimeType: "image/png",
      data: buffer.toString("base64"),
      ...persisted,
      device_label: selected.label,
    };
  };
}

export const takeCameraSnapshot = createCameraSnapshotCapture();

export function createCameraSensor(
  overrides: {
    isMac?: boolean;
    policyEnabled?: () => Promise<boolean>;
  } = {},
): Sensor {
  const platformIsMac = overrides.isMac ?? isMac;
  const enabled = overrides.policyEnabled ?? (() => policyEnabled("camera_snapshot"));
  let diagnostic: SensorDiagnostic | null = null;
  return {
    name: "camera",
    intervalMs: 120_000,
    tier: 3,
    capability: "camera_snapshot",
    domains: ["environment"],
    samplingMode: "on_demand",
    async available(): Promise<boolean> {
      const allowed = platformIsMac && (await enabled());
      diagnostic = allowed
        ? null
        : {
            reason: "disabled_by_policy",
            detail: "Camera capture is disabled in the Sense policy.",
            fixHint: "Run sense-mcp enable camera to permit allow-once prompts.",
          };
      return allowed;
    },
    async sample(): Promise<Observation[]> {
      if (!(await enabled())) {
        diagnostic = {
          reason: "disabled_by_policy",
          detail: "Camera capture is disabled in the Sense policy.",
          fixHint: "Run sense-mcp enable camera to permit allow-once prompts.",
        };
        return [];
      }
      diagnostic = null;
      return [
        {
          sensor: "camera",
          domain: "environment",
          fields: { camera_capture_enabled: true, camera_requires_local_consent: true },
          observedAt: Date.now(),
          ttlMs: TTL_MS,
        },
      ];
    },
    diagnose: () => diagnostic,
  };
}

/** Policy availability only. Hardware opens only inside the explicit capture tool. */
export const cameraSensor = createCameraSensor();
