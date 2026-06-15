import { describe, expect, test } from "vitest";
import { snapshotFailureHint } from "../src/snapshotAdvice.js";

describe("snapshotFailureHint", () => {
  test("returns specific camera setup guidance", () => {
    expect(snapshotFailureHint("camera", "camera_snapshot_not_enabled")).toContain(
      "SENSE_CAMERA_SNAPSHOT=1",
    );
    expect(snapshotFailureHint("camera", "camera_capture_failed_or_denied")).toContain(
      "Camera",
    );
  });

  test("returns specific screen setup guidance", () => {
    expect(snapshotFailureHint("screen", "screen_snapshot_not_enabled")).toContain(
      "SENSE_SCREEN_SNAPSHOT=1",
    );
    expect(snapshotFailureHint("screen", "screen_capture_failed_or_denied")).toContain(
      "Screen Recording",
    );
  });
});
