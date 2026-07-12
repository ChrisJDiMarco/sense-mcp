import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  consumeConsentReceipt,
  listConsentReceipts,
  requestLocalConsent,
  revokeAllConsent,
  revokeConsent,
  type CaptureConsentRequest,
} from "../src/consent.js";

let tempDir: string | undefined;
const NOW = Date.parse("2026-07-11T12:00:00.000Z");

const windowRequest: CaptureConsentRequest = {
  media_kind: "screen",
  scope: "window_only",
  target: "window:4312:pid:777:app:Codex:bounds:10,20,1200,800",
  reason: "  Inspect   the current app layout.  ",
};

async function useConsentDir(): Promise<string> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "sense-consent-test-"));
  const directory = path.join(tempDir, "consent");
  process.env.SENSE_CONSENT_DIR = directory;
  return directory;
}

afterEach(async () => {
  delete process.env.SENSE_CONSENT_DIR;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("local capture consent", () => {
  test("issues a private, short-lived receipt and consumes it only for the exact request", async () => {
    const directory = await useConsentDir();
    const decision = await requestLocalConsent(windowRequest, {
      now: () => NOW,
      ttlMs: 30_000,
      confirm: async () => true,
    });

    expect(decision.granted).toBe(true);
    if (!decision.granted) throw new Error("expected consent");
    expect(decision.receipt.media_kind).toBe("screen");
    expect(decision.receipt.scope).toBe("window_only");
    expect(decision.receipt.target).toBe(
      "window:4312:pid:777:app:Codex:bounds:10,20,1200,800",
    );
    expect(decision.receipt.expires_at).toBe("2026-07-11T12:00:30.000Z");
    expect(decision.receipt.reason_hash).toBe(
      createHash("sha256").update("Inspect the current app layout.").digest("hex"),
    );
    expect(decision.receipt).not.toHaveProperty("reason");

    const files = await readdir(directory);
    const receiptFile = path.join(directory, files.find((file) => file.endsWith(".json")) ?? "");
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(receiptFile)).mode & 0o777).toBe(0o600);

    const consumed = await consumeConsentReceipt(decision.receipt.id, windowRequest, {
      now: () => NOW + 1_000,
    });
    expect(consumed).toMatchObject({ granted: true });
    expect(await consumeConsentReceipt(decision.receipt.id, windowRequest, { now: () => NOW + 2_000 }))
      .toMatchObject({ granted: false, error: "receipt_not_found" });
  });

  test("fails closed when reason, scope, target, or expiry does not match", async () => {
    await useConsentDir();
    const mismatch = await requestLocalConsent(windowRequest, {
      now: () => NOW,
      confirm: async () => true,
    });
    if (!mismatch.granted) throw new Error("expected consent");

    await expect(
      consumeConsentReceipt(
        mismatch.receipt.id,
        { ...windowRequest, reason: "Inspect a different thing." },
        { now: () => NOW + 1_000 },
      ),
    ).resolves.toMatchObject({ granted: false, error: "receipt_mismatch" });

    const expired = await requestLocalConsent(windowRequest, {
      now: () => NOW,
      ttlMs: 1_000,
      confirm: async () => true,
    });
    if (!expired.granted) throw new Error("expected consent");
    await expect(
      consumeConsentReceipt(expired.receipt.id, windowRequest, { now: () => NOW + 1_001 }),
    ).resolves.toMatchObject({ granted: false, error: "receipt_expired" });
  });

  test("denial creates no receipt and invalid media/scope combinations fail closed", async () => {
    await useConsentDir();
    const denied = await requestLocalConsent(windowRequest, {
      now: () => NOW,
      confirm: async () => false,
    });
    expect(denied).toEqual({ granted: false, error: "user_denied" });
    expect(await listConsentReceipts({ now: () => NOW })).toEqual([]);

    await expect(
      requestLocalConsent(
        { ...windowRequest, media_kind: "camera", scope: "full_screen" },
        { now: () => NOW, confirm: async () => true },
      ),
    ).resolves.toEqual({ granted: false, error: "invalid_request" });
  });

  test("supports targeted and global revocation", async () => {
    await useConsentDir();
    const first = await requestLocalConsent(windowRequest, {
      now: () => NOW,
      confirm: async () => true,
    });
    const second = await requestLocalConsent(
      { media_kind: "camera", scope: "single_capture", target: "device:0", reason: "Check lighting." },
      { now: () => NOW, confirm: async () => true },
    );
    if (!first.granted || !second.granted) throw new Error("expected consent");

    expect(await revokeConsent(first.receipt.id)).toBe(true);
    expect(await listConsentReceipts({ now: () => NOW })).toHaveLength(1);
    expect(await revokeAllConsent()).toBe(1);
    expect(await listConsentReceipts({ now: () => NOW })).toEqual([]);
  });

  test("allows exactly one concurrent consumer", async () => {
    await useConsentDir();
    const decision = await requestLocalConsent(windowRequest, {
      now: () => NOW,
      confirm: async () => true,
    });
    if (!decision.granted) throw new Error("expected consent");

    const results = await Promise.all([
      consumeConsentReceipt(decision.receipt.id, windowRequest, { now: () => NOW + 1 }),
      consumeConsentReceipt(decision.receipt.id, windowRequest, { now: () => NOW + 1 }),
    ]);
    expect(results.filter((result) => result.granted)).toHaveLength(1);
    expect(results.filter((result) => !result.granted)).toHaveLength(1);
  });

  test("caps lease duration and rejects oversized request fields", async () => {
    await useConsentDir();
    const capped = await requestLocalConsent(windowRequest, {
      now: () => NOW,
      ttlMs: 60 * 60_000,
      confirm: async () => true,
    });
    if (!capped.granted) throw new Error("expected consent");
    expect(capped.receipt.expires_at).toBe("2026-07-11T12:02:00.000Z");

    await expect(
      requestLocalConsent(
        { ...windowRequest, reason: "x".repeat(201) },
        { now: () => NOW, confirm: async () => true },
      ),
    ).resolves.toEqual({ granted: false, error: "invalid_request" });
    await expect(
      requestLocalConsent(
        { ...windowRequest, target: `window:${"1".repeat(121)}` },
        { now: () => NOW, confirm: async () => true },
      ),
    ).resolves.toEqual({ granted: false, error: "invalid_request" });
  });
});
