import type { Observation, Sensor, SensorDiagnostic } from "../types.js";
import { policyEnabled } from "../policy.js";
import { isMac, runCapture, type CommandResult } from "./exec.js";

const TTL_MS = 20_000;
const SAMPLE_SECONDS = 1;

export interface AudioDevice {
  index: number;
  label: string;
}

function classifyAudioLabel(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("blackhole") || lower.includes("boom") || lower.includes("zoom")) {
    return "virtual_audio_device";
  }
  if (lower.includes("iphone")) return "phone_microphone";
  if (lower.includes("microphone") || lower.includes("mic")) return "built_in_microphone";
  return "audio_device";
}

export function parseAvfoundationAudioDevices(output: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  let inAudio = false;

  for (const line of output.split("\n")) {
    if (line.includes("AVFoundation audio devices")) {
      inAudio = true;
      continue;
    }
    if (!inAudio) continue;

    const match = line.match(/\[(\d+)]\s+(.+)$/);
    if (!match) continue;
    devices.push({ index: Number(match[1]), label: classifyAudioLabel(match[2]) });
  }

  return devices;
}

interface AudioLevelDependencies {
  isMac: boolean;
  policyEnabled: () => Promise<boolean>;
  runCommand: (
    command: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<CommandResult | null>;
  env: Record<string, string | undefined>;
}

async function defaultAudioDeviceIndex(
  dependencies: AudioLevelDependencies,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await dependencies.runCommand(
    "ffmpeg",
    ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
    5000,
    signal,
  );
  if (!result) return null;

  const devices = parseAvfoundationAudioDevices(`${result.stdout}\n${result.stderr}`);
  const preferred =
    devices.find((device) => device.label === "built_in_microphone") ??
    devices.find((device) => device.label === "phone_microphone") ??
    devices.find((device) => device.label !== "virtual_audio_device") ??
    devices[0];
  return preferred ? String(preferred.index) : null;
}

export function parseVolumeDetect(output: string): number | null {
  const mean = output.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/)?.[1];
  const max = output.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/)?.[1];
  const value = mean ?? max;
  if (!value) return null;

  const db = Number(value);
  return Number.isFinite(db) ? db : null;
}

export function classifyNoise(db: number | null): string {
  if (db === null) return "unknown";
  if (db <= -55) return "silent";
  if (db <= -40) return "quiet";
  if (db <= -25) return "moderate";
  return "noisy";
}

export function createAudioLevelSensor(
  overrides: Partial<AudioLevelDependencies> = {},
): Sensor {
  const dependencies: AudioLevelDependencies = {
    isMac,
    policyEnabled: () => policyEnabled("mic_level"),
    runCommand: runCapture,
    env: process.env,
    ...overrides,
  };
  let diagnostic: SensorDiagnostic | null = null;

  return {
    name: "audio-level",
    intervalMs: 30_000,
    tier: 2,
    capability: "microphone_level",
    domains: ["environment"],
    async available(): Promise<boolean> {
      const allowed = dependencies.isMac && (await dependencies.policyEnabled());
      diagnostic = allowed
        ? null
        : {
            reason: "disabled_by_policy",
            detail: "Microphone level sampling is disabled in the Sense policy.",
            fixHint: "Run sense-mcp enable mic if a one-second volume class is wanted.",
          };
      return allowed;
    },
    async sample(signal): Promise<Observation[]> {
      if (!(await dependencies.policyEnabled())) {
        diagnostic = {
          reason: "disabled_by_policy",
          detail: "Microphone level sampling is disabled in the Sense policy.",
          fixHint: "Run sense-mcp enable mic if a one-second volume class is wanted.",
        };
        return [];
      }

      const deviceIndex =
        dependencies.env.SENSE_MIC_DEVICE_INDEX ??
        (await defaultAudioDeviceIndex(dependencies, signal));
      if (!deviceIndex) {
        diagnostic = {
          reason: "audio_device_unavailable",
          detail: "No AVFoundation audio input device was found.",
          fixHint: "Check macOS input devices or configure a valid ffmpeg audio-device index.",
        };
        return [];
      }
      const result = await dependencies.runCommand(
        "ffmpeg",
        [
          "-hide_banner",
          "-f",
          "avfoundation",
          "-t",
          String(SAMPLE_SECONDS),
          "-i",
          `:${deviceIndex}`,
          "-af",
          "volumedetect",
          "-f",
          "null",
          "-",
        ],
        5000,
        signal,
      );
      if (!result || result.exitCode !== 0 || result.timedOut) {
        diagnostic = {
          reason: result?.timedOut ? "audio_level_timeout" : "audio_capture_failed",
          detail: "Microphone level capture failed without retaining audio.",
          fixHint: "Grant Microphone permission to the app running Sense or configure a valid input.",
        };
        return [];
      }

      const db = parseVolumeDetect(`${result.stdout}\n${result.stderr}`);
      if (db === null) {
        diagnostic = {
          reason: "audio_level_parse_failed",
          detail: "The local volume analyzer did not return a reading.",
          fixHint: "Configure a valid microphone input.",
        };
        return [];
      }
      diagnostic = null;

      return [
        {
          sensor: "audio-level",
          domain: "environment",
          fields: {
            noise_class: classifyNoise(db),
            microphone_level_db: Math.round(db * 10) / 10,
            microphone_level_sample_ms: SAMPLE_SECONDS * 1000,
          },
          observedAt: Date.now(),
          ttlMs: TTL_MS,
        },
      ];
    },
    diagnose: () => diagnostic,
  };
}

/** Opt-in microphone level only. No audio content is stored or returned. */
export const audioLevelSensor = createAudioLevelSensor();
