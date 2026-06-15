import type { Observation, Sensor } from "../types.js";
import { isMac, run } from "./exec.js";

const TTL_MS = 30_000;

const MEDIA_SCRIPT = `
tell application "System Events"
  if exists process "Spotify" then
    tell application "Spotify"
      try
        return "Spotify|" & (player state as string) & "|" & (artist of current track) & "|" & (name of current track)
      on error
        return "Spotify|unknown||"
      end try
    end tell
  end if
  if exists process "Music" then
    tell application "Music"
      try
        return "Music|" & (player state as string) & "|" & (artist of current track) & "|" & (name of current track)
      on error
        return "Music|unknown||"
      end try
    end tell
  end if
end tell
return "NONE"
`;

export function parseMediaState(line: string): Record<string, string> | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed === "NONE") return null;

  const [app, state] = trimmed.split("|");
  if (!app || !state) return null;

  const playback = state.toLowerCase();
  return {
    media_app: app,
    media_playback: playback === "playing" || playback === "paused" ? playback : "unknown",
    media_type: "music",
  };
}

/** Now-playing semantic state only. Track and artist are intentionally dropped. */
export const mediaSensor: Sensor = {
  name: "media",
  intervalMs: 30_000,
  tier: 2,
  capability: "now_playing",
  available: async () => isMac,
  async sample(): Promise<Observation[]> {
    const out = await run("osascript", ["-e", MEDIA_SCRIPT], 4000);
    if (!out) return [];

    const fields = parseMediaState(out);
    if (!fields) return [];

    return [
      {
        sensor: "media",
        domain: "environment",
        fields,
        observedAt: Date.now(),
        ttlMs: TTL_MS,
      },
    ];
  },
};
