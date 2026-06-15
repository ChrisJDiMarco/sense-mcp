import type { Observation, Sensor } from "../types.js";
import { isMac, runCapture } from "./exec.js";

const TTL_MS = 20_000;
const SAMPLE_SECONDS = 1;

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
    if (process.env.SENSE_MIC_LEVEL !== "1") return [];

    const deviceIndex = process.env.SENSE_MIC_DEVICE_INDEX ?? "0";
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
    if (!result) return [];

    const db = parseVolumeDetect(`${result.stdout}\n${result.stderr}`);
    if (db === null) return [];

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
};
