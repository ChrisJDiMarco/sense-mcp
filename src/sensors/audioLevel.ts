import type { Observation, Sensor, SensorDiagnostic } from "../types.js";
import { isMac, runCapture } from "./exec.js";

const TTL_MS = 20_000;
const SAMPLE_SECONDS = 1;
let lastAudioDiagnostic: SensorDiagnostic | null = null;

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

async function defaultAudioDeviceIndex(): Promise<string | null> {
  const result = await runCapture(
    "ffmpeg",
    ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
    5000,
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

/** Opt-in microphone level only. No audio content is stored or returned. */
export const audioLevelSensor: Sensor = {
  name: "audio-level",
  intervalMs: 30_000,
  tier: 2,
  capability: "microphone_level",
  available: async () => isMac,
  async sample(): Promise<Observation[]> {
    if (process.env.SENSE_MIC_LEVEL !== "1") {
      lastAudioDiagnostic = {
        reason: "disabled_by_env",
        detail: "Mic level sampling is disabled because SENSE_MIC_LEVEL is not 1.",
        fixHint: "Run sense-mcp enable mic, restart the MCP client, and grant Microphone permission if prompted.",
      };
      return [];
    }

    const deviceIndex = process.env.SENSE_MIC_DEVICE_INDEX ?? (await defaultAudioDeviceIndex());
    if (!deviceIndex) {
      lastAudioDiagnostic = {
        reason: "audio_device_unavailable",
        detail: "No AVFoundation audio input device was found.",
        fixHint: "Check macOS input devices or set SENSE_MIC_DEVICE_INDEX to a valid ffmpeg audio device.",
      };
      return [];
    }
    const result = await runCapture(
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
    );
    if (!result || result.exitCode !== 0 || result.timedOut) {
      lastAudioDiagnostic = {
        reason: result?.timedOut ? "audio_level_timeout" : "audio_capture_failed",
        detail: result?.stderr || result?.errorMessage || "Mic level capture failed.",
        fixHint:
          "Grant Microphone permission to the app running Sense, or set SENSE_MIC_DEVICE_INDEX to the built-in microphone.",
      };
      return [];
    }

    const db = parseVolumeDetect(`${result.stdout}\n${result.stderr}`);
    if (db === null) {
      lastAudioDiagnostic = {
        reason: "audio_level_parse_failed",
        detail: "ffmpeg did not return a volume reading.",
        fixHint: "Set SENSE_MIC_DEVICE_INDEX to a valid microphone input.",
      };
      return [];
    }
    lastAudioDiagnostic = null;

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
  diagnose: () => lastAudioDiagnostic,
};
