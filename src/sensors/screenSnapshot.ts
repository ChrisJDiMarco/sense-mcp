import { readFile } from "node:fs/promises";
import type { PersistedSnapshot } from "../snapshotFiles.js";
import {
  createSnapshotPath,
  finalizeSnapshotFile,
  persistSnapshotBuffer as persistSnapshotFileBuffer,
} from "../snapshotFiles.js";
import { isMac, runCapture } from "./exec.js";

export type ScreenSnapshotMode =
  | "screen_debug"
  | "ui_feedback"
  | "screen_summary"
  | "reading_help"
  | "general_screen";

export interface ScreenSnapshot {
  ok: boolean;
  generated_at: string;
  mode: ScreenSnapshotMode;
  mimeType?: "image/png";
  data?: string;
  path?: string;
  markdown_image?: string;
  size_bytes?: number;
  error?: string;
}

export function screenSnapshotEnabled(): boolean {
  return process.env.SENSE_SCREEN_SNAPSHOT === "1";
}

export async function persistScreenSnapshotBuffer(
  buffer: Buffer,
  generatedAt: string,
): Promise<PersistedSnapshot> {
  return persistSnapshotFileBuffer("screen", buffer, generatedAt);
}

export async function takeScreenSnapshot(
  mode: ScreenSnapshotMode = "general_screen",
): Promise<ScreenSnapshot> {
  const generatedAt = new Date().toISOString();

  if (!screenSnapshotEnabled()) {
    return {
      ok: false,
      generated_at: generatedAt,
      mode,
      error: "screen_snapshot_not_enabled",
    };
  }
  if (!isMac) {
    return {
      ok: false,
      generated_at: generatedAt,
      mode,
      error: "screen_snapshot_unavailable",
    };
  }

  const file = await createSnapshotPath("screen", generatedAt);
  const result = await runCapture("screencapture", ["-x", "-t", "png", file], 8000);
  if (!result || result.exitCode !== 0) {
    return {
      ok: false,
      generated_at: generatedAt,
      mode,
      error: "screen_capture_failed_or_denied",
    };
  }

  const buffer = await readFile(file).catch(() => null);
  if (!buffer || buffer.length === 0) {
    return {
      ok: false,
      generated_at: generatedAt,
      mode,
      error: "screen_capture_empty",
    };
  }

  const persisted = await finalizeSnapshotFile("screen", file);
  return {
    ok: true,
    generated_at: generatedAt,
    mode,
    mimeType: "image/png",
    data: buffer.toString("base64"),
    ...persisted,
  };
}
