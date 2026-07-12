import type { SnapshotKind } from "./snapshotFiles.js";

const CAMERA_HINTS: Record<string, string> = {
  camera_snapshot_not_enabled:
    "Run sense-mcp enable camera or turn on Camera Snapshot in the Sense panel, then retry.",
  camera_unavailable:
    "No usable camera device was found. Check that a camera is connected and that ffmpeg can list AVFoundation devices.",
  camera_capture_failed_or_denied:
    "macOS may be blocking Camera access. Open System Settings > Privacy & Security > Camera and allow the MCP client or terminal host.",
  camera_policy_revoked:
    "Camera policy was disabled while the allow-once prompt was open, so Sense safely cancelled the capture.",
};

const SCREEN_HINTS: Record<string, string> = {
  screen_snapshot_not_enabled:
    "Run sense-mcp enable window or turn on Window Snapshot in the Sense panel, then retry.",
  window_snapshot_not_enabled:
    "Run sense-mcp enable window or turn on Window Snapshot in the Sense panel, then retry.",
  full_screen_snapshot_not_enabled:
    "Run sense-mcp enable full-screen or turn on Full-Screen Snapshot in the Sense panel, then retry.",
  window_capture_unavailable:
    "No capturable frontmost app window was found. Bring the intended window forward or pass its CoreGraphics window id.",
  window_capture_failed_or_denied:
    "macOS may be blocking Screen Recording. Allow the MCP client or terminal host, then retry the same window.",
  window_policy_revoked:
    "Window-capture policy was disabled while the allow-once prompt was open, so Sense safely cancelled the capture.",
  window_target_changed:
    "The selected app window disappeared or changed owners while consent was open. Ask for a fresh capture of the intended app window.",
  full_screen_capture_failed_or_denied:
    "macOS may be blocking Screen Recording. Allow the MCP client or terminal host, then retry the main-display capture.",
  full_screen_policy_revoked:
    "Full-screen policy was disabled while the allow-once prompt was open, so Sense safely cancelled the capture.",
  screen_snapshot_unavailable: "Screen snapshots are currently supported on macOS only.",
  screen_capture_failed_or_denied:
    "macOS may be blocking Screen Recording. Open System Settings > Privacy & Security > Screen Recording and allow the MCP client or terminal host.",
  screen_capture_empty:
    "The screen capture returned an empty file. Retry once, then check Screen Recording permission if it repeats.",
  screen_capture_finalize_failed:
    "Sense discarded the snapshot because private-file validation or finalization failed. Run sense-mcp doctor before retrying.",
};

export function snapshotFailureHint(kind: SnapshotKind, error?: string): string {
  const hints = kind === "camera" ? CAMERA_HINTS : SCREEN_HINTS;
  if (error?.includes("consent_user_denied")) {
    return "The local operator denied or did not approve this one capture. Do not retry unless they ask again.";
  }
  if (error?.includes("consent_")) {
    return "The allow-once consent receipt was unavailable, expired, invalid, or mismatched. Ask for a fresh explicit capture and retry once.";
  }
  return (
    (error ? hints[error] : undefined) ??
    `Run sense-mcp doctor for setup checks, then retry the explicit ${kind} snapshot request.`
  );
}
