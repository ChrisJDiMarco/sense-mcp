import { mkdtemp, rm } from "node:fs/promises";
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
  test("records bounded metadata and scrubs sensitive reason text", async () => {
    await useTempLedger();

    await recordAccess({
      tool: "take_screen_snapshot",
      status: "completed",
      reason: "Need this screen; password is 123456 and email me@example.com",
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
    expect(entries[0].reason).toContain("[sensitive]");
    expect(entries[0].reason).toContain("[email]");
    expect(entries[0].reason).not.toContain("123456");
    expect(ledgerPath()).toBe(path.join(tempDir ?? "", "ledger.jsonl"));
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
});
