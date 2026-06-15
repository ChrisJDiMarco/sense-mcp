import type { SnapshotKind } from "./snapshotFiles.js";

const CAMERA_HINTS: Record<string, string> = {
  camera_snapshot_not_enabled:
    "Enable camera snapshots with SENSE_CAMERA_SNAPSHOT=1 or turn on Camera Snapshot in the Sense panel, then restart the MCP client.",
  camera_unavailable:
    "No usable camera device was found. Check that a camera is connected and that ffmpeg can list AVFoundation devices.",
  camera_capture_failed_or_denied:
    "macOS may be blocking Camera access. Open System Settings > Privacy & Security > Camera and allow the MCP client or terminal host.",
};

const SCREEN_HINTS: Record<string, string> = {
  screen_snapshot_not_enabled:
    "Enable screen snapshots with SENSE_SCREEN_SNAPSHOT=1 or turn on Screen Snapshot in the Sense panel, then restart the MCP client.",
  screen_snapshot_unavailable: "Screen snapshots are currently supported on macOS only.",
  screen_capture_failed_or_denied:
    "macOS may be blocking Screen Recording. Open System Settings > Privacy & Security > Screen Recording and allow the MCP client or terminal host.",
  screen_capture_empty:
    "The screen capture returned an empty file. Retry once, then check Screen Recording permission if it repeats.",
};

export function snapshotFailureHint(kind: SnapshotKind, error?: string): string {
  const hints = kind === "camera" ? CAMERA_HINTS : SCREEN_HINTS;
  return (
    (error ? hints[error] : undefined) ??
    `Run sense-mcp doctor for setup checks, then retry the explicit ${kind} snapshot request.`
  );
}
