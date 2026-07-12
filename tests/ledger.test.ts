import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ledgerPath, readAccessLedger, recordAccess } from "../src/ledger.js";

let tempDir: string | undefined;

async function useTempLedger(): Promise<void> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "sense-ledger-test-"));
  process.env.SENSE_LEDGER_PATH = path.join(tempDir, "ledger.jsonl");
}

afterEach(async () => {
  delete process.env.SENSE_LEDGER_PATH;
  delete process.env.SENSE_LEDGER_DISABLED;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("access ledger", () => {
  test("records a fixed summary and hash without persisting caller reason text", async () => {
    await useTempLedger();

    await recordAccess({
      tool: "take_screen_snapshot",
      status: "completed",
      reason: "Need this screen; password is 123456 and email me@example.com at https://example.test/private",
      media_captured: true,
      context_domains: ["screen"],
      artifact_paths: ["/tmp/sense-screen.png"],
      budget_mode: "visual",
      max_tokens: 120,
    });

    const entries = await readAccessLedger();
    expect(entries).toHaveLength(1);
    expect(entries[0].tool).toBe("take_screen_snapshot");
    expect(entries[0].media_captured).toBe(true);
    expect(entries[0].reason).toBe("Explicit media capture completed.");
    expect(entries[0].reason_hash).toMatch(/^[0-9a-f]{64}$/);
    const stored = await readFile(ledgerPath(), "utf8");
    expect(stored).not.toMatch(/123456|me@example\.com|example\.test/);
    expect(ledgerPath()).toBe(path.join(tempDir ?? "", "ledger.jsonl"));
  });

  test("never persists arbitrary secrets, credentials, codes, or URLs from reasons", async () => {
    await useTempLedger();

    await recordAccess({
      tool: "take_window_snapshot",
      status: "completed",
      reason:
        "Inspect login layout; password is open sesame; Authorization: Basic dXNlcjpwYXNz; one-time code 1234; HTTPS://EXAMPLE.TEST/SECRET; unique phrase violet-canoe-ember-91.",
      media_captured: true,
      context_domains: ["screen"],
    });

    const [entry] = await readAccessLedger();
    expect(entry.reason).toBe("Explicit media capture completed.");
    const stored = await readFile(ledgerPath(), "utf8");
    expect(stored).not.toMatch(
      /open sesame|dXNlcjpwYXNz|1234|EXAMPLE\.TEST|violet-canoe-ember-91/i,
    );
  });

  test("migrates legacy plaintext reasons and errors under the ledger lock", async () => {
    await useTempLedger();
    const legacy = {
      id: "00000000-0000-4000-8000-000000000099",
      observed_at: "2026-07-11T12:00:00.000Z",
      tool: "take_window_snapshot",
      status: "failed",
      reason: "password is legacy secret phrase",
      media_captured: false,
      context_domains: ["screen"],
      error: "Authorization: Basic bGVnYWN5OnNlY3JldA==",
    };
    await writeFile(ledgerPath(), `${JSON.stringify(legacy)}\n`);

    const [entry] = await readAccessLedger();
    expect(entry.reason).toBe("Semantic context access failed for screen.");
    expect(entry.error).toBe("tool_error");
    expect(entry.reason_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.error_hash).toMatch(/^[0-9a-f]{64}$/);
    const migrated = await readFile(ledgerPath(), "utf8");
    expect(migrated).not.toMatch(/legacy secret phrase|bGVnYWN5OnNlY3JldA/);
  });

  test("can be disabled with SENSE_LEDGER_DISABLED", async () => {
    await useTempLedger();
    process.env.SENSE_LEDGER_DISABLED = "1";

    await recordAccess({
      tool: "get_context_frame",
      status: "completed",
      reason: "Requested full context frame.",
      media_captured: false,
      context_domains: ["screen", "user"],
    });

    expect(await readAccessLedger()).toEqual([]);
  });

  test("serializes concurrent records without losing or corrupting entries", async () => {
    await useTempLedger();

    await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        recordAccess({
          tool: `tool-${index}`,
          status: "completed",
          reason: `Concurrent record ${index}`,
          media_captured: false,
          context_domains: ["screen"],
        }),
      ),
    );

    const entries = await readAccessLedger(100);
    expect(entries).toHaveLength(80);
    expect(new Set(entries.map((entry) => entry.tool)).size).toBe(80);
    const file = ledgerPath();
    expect((await lstat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
  });

  test("caps all caller-controlled metadata", async () => {
    await useTempLedger();
    await recordAccess({
      tool: "t".repeat(500),
      status: "failed",
      reason: "r".repeat(1_000),
      media_captured: false,
      context_domains: ["screen", "user", "environment", "schedule", "secret-domain"],
      plan_intent: "p".repeat(500),
      expected_value: "e".repeat(500),
      budget_mode: "b".repeat(500),
      external_context_needed: Array.from({ length: 20 }, () => "x".repeat(500)),
      artifact_paths: Array.from({ length: 20 }, () => "/" + "a".repeat(500)),
      error: "password secret " + "z".repeat(500),
      max_tokens: Number.MAX_SAFE_INTEGER,
      privacy_tier: 99,
    });

    const [entry] = await readAccessLedger();
    expect(entry.tool.length).toBeLessThanOrEqual(80);
    expect(entry.reason.length).toBeLessThanOrEqual(220);
    expect(entry.context_domains).toEqual(["screen", "user", "environment", "schedule"]);
    expect(entry.plan_intent).toBeUndefined();
    expect(entry.expected_value).toBeUndefined();
    expect(entry.budget_mode).toBeUndefined();
    expect(entry.external_context_needed).toBeUndefined();
    expect(entry.artifact_paths).toHaveLength(4);
    expect(entry.error).toBe("tool_error");
    expect(entry.error_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(ledgerPath(), "utf8")).not.toContain("z".repeat(20));
    expect(entry.max_tokens).toBeLessThanOrEqual(1_000_000);
    expect(entry.privacy_tier).toBe(3);
  });

  test("never follows a ledger symlink", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "sense-ledger-test-"));
    const victim = path.join(tempDir, "victim.txt");
    const linkedLedger = path.join(tempDir, "ledger.jsonl");
    await writeFile(victim, "do not replace");
    await symlink(victim, linkedLedger);
    process.env.SENSE_LEDGER_PATH = linkedLedger;

    await recordAccess({
      tool: "take_window_snapshot",
      status: "completed",
      reason: "Inspect the app window.",
      media_captured: true,
      context_domains: [],
    });

    expect(await readAccessLedger()).toEqual([]);
    expect(await readFile(victim, "utf8")).toBe("do not replace");
  });
});
