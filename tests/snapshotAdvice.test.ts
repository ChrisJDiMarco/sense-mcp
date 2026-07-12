import { describe, expect, test } from "vitest";
import { snapshotFailureHint } from "../src/snapshotAdvice.js";

describe("snapshotFailureHint", () => {
  test("returns specific camera setup guidance", () => {
    expect(snapshotFailureHint("camera", "camera_snapshot_not_enabled")).toContain(
      "sense-mcp enable camera",
    );
    expect(snapshotFailureHint("camera", "camera_capture_failed_or_denied")).toContain(
      "Camera",
    );
  });

  test("returns specific screen setup guidance", () => {
    expect(snapshotFailureHint("screen", "screen_snapshot_not_enabled")).toContain(
      "sense-mcp enable window",
    );
    expect(snapshotFailureHint("screen", "screen_capture_failed_or_denied")).toContain(
      "Screen Recording",
    );
    expect(snapshotFailureHint("screen", "screen_capture_finalize_failed")).toContain(
      "discarded",
    );
  });

  test("does not encourage retry after the local operator denies consent", () => {
    expect(snapshotFailureHint("screen", "window_consent_user_denied")).toContain(
      "Do not retry",
    );
  });

  test("explains policy revocation without claiming an OS-permission failure", () => {
    expect(snapshotFailureHint("camera", "camera_policy_revoked")).toContain("safely cancelled");
    expect(snapshotFailureHint("screen", "window_target_changed")).toContain("changed owners");
  });
});
