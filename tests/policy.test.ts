import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  SensePolicyStore,
  loadSensePolicy,
  policyEnabled,
  policyPath,
  updateSensePolicy,
} from "../src/policy.js";
import { atomicWritePrivateFile } from "../src/privateFiles.js";

let tempDir: string | undefined;

async function usePolicyPath(): Promise<string> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "sense-policy-test-"));
  const file = path.join(tempDir, "private", "policy.json");
  process.env.SENSE_POLICY_PATH = file;
  return file;
}

afterEach(async () => {
  delete process.env.SENSE_POLICY_PATH;
  delete process.env.SENSE_CALENDAR;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("central Sense policy", () => {
  test("uses strict defaults and per-key environment migration fallbacks", async () => {
    await usePolicyPath();
    const snapshot = await loadSensePolicy({
      SENSE_CALENDAR: "1",
      SENSE_LOCATION: "0",
      SENSE_MIC_LEVEL: "1",
      SENSE_CAMERA_SNAPSHOT: "0",
      SENSE_SCREEN_SNAPSHOT: "1",
      SENSE_FULL_SCREEN_SNAPSHOT: "1",
      SENSE_RAW_TITLES: "0",
    });

    expect(snapshot.values).toEqual({
      calendar: true,
      location: false,
      mic_level: true,
      camera_snapshot: false,
      window_snapshot: true,
      full_screen_snapshot: true,
      raw_titles: false,
    });
    expect(snapshot.sources.calendar).toBe("environment");
    expect(snapshot.sources.location).toBe("environment");
    expect(snapshot.valid).toBe(true);
  });

  test("file values are authoritative per key while absent keys still use env fallback", async () => {
    const file = await usePolicyPath();
    await atomicWritePrivateFile(
      file,
      JSON.stringify({
        version: 1,
        updated_at: "2026-07-11T12:00:00.000Z",
        capabilities: { calendar: false, camera_snapshot: true },
      }),
    );

    const snapshot = await loadSensePolicy({ SENSE_CALENDAR: "1", SENSE_MIC_LEVEL: "1" });
    expect(snapshot.values.calendar).toBe(false);
    expect(snapshot.values.camera_snapshot).toBe(true);
    expect(snapshot.values.mic_level).toBe(true);
    expect(snapshot.sources.calendar).toBe("file");
    expect(snapshot.sources.mic_level).toBe("environment");
  });

  test("reloads when the atomically replaced policy inode changes", async () => {
    const file = await usePolicyPath();
    const store = new SensePolicyStore(file, {});
    await store.update({ calendar: false });
    expect((await store.load()).values.calendar).toBe(false);

    await atomicWritePrivateFile(
      file,
      JSON.stringify({
        version: 1,
        updated_at: "2026-07-11T12:01:00.000Z",
        capabilities: { calendar: true },
      }),
    );
    expect((await store.load()).values.calendar).toBe(true);
  });

  test("serializes concurrent partial updates without losing keys", async () => {
    await usePolicyPath();
    await Promise.all([
      updateSensePolicy({ calendar: true }),
      updateSensePolicy({ location: true }),
      updateSensePolicy({ camera_snapshot: true }),
    ]);

    const snapshot = await loadSensePolicy({});
    expect(snapshot.values.calendar).toBe(true);
    expect(snapshot.values.location).toBe(true);
    expect(snapshot.values.camera_snapshot).toBe(true);
    expect((await lstat(path.dirname(policyPath()))).mode & 0o777).toBe(0o700);
    expect((await lstat(policyPath())).mode & 0o777).toBe(0o600);
  });

  test("fails closed on malformed or symlinked policy storage", async () => {
    const file = await usePolicyPath();
    await atomicWritePrivateFile(file, "not json");
    const malformed = await loadSensePolicy({ SENSE_CALENDAR: "1" });
    expect(malformed.valid).toBe(false);
    expect(malformed.values.calendar).toBe(false);
    expect(malformed.error).toMatch(/invalid/i);

    await rm(file);
    const victim = path.join(tempDir ?? "", "victim.json");
    await writeFile(victim, JSON.stringify({ capabilities: { calendar: true } }));
    await symlink(victim, file);
    const linked = await loadSensePolicy({ SENSE_CALENDAR: "1" });
    expect(linked.valid).toBe(false);
    expect(linked.values.calendar).toBe(false);
    expect(await readFile(victim, "utf8")).toContain("calendar");
  });

  test("fails closed when an earlier policy path component is a symlink", async () => {
    if (!tempDir) tempDir = await mkdtemp(path.join(os.tmpdir(), "sense-policy-test-"));
    const actual = path.join(tempDir, "actual");
    await atomicWritePrivateFile(
      path.join(actual, "policy.json"),
      JSON.stringify({
        version: 1,
        updated_at: "2026-07-11T12:00:00.000Z",
        capabilities: { calendar: true },
      }),
    );
    const linked = path.join(tempDir, "linked");
    await symlink(actual, linked, "dir");
    process.env.SENSE_POLICY_PATH = path.join(linked, "policy.json");
    const snapshot = await loadSensePolicy({ SENSE_CALENDAR: "1" });
    expect(snapshot.valid).toBe(false);
    expect(snapshot.values.calendar).toBe(false);
  });

  test("supports clearing a file override back to the environment fallback", async () => {
    await usePolicyPath();
    const store = new SensePolicyStore(policyPath(), { SENSE_CALENDAR: "1" });
    await store.update({ calendar: false });
    expect((await store.load()).values.calendar).toBe(false);
    await store.update({ calendar: null });
    expect((await store.load()).values.calendar).toBe(true);
  });

  test("provides a cached sensor helper that follows path changes and fails closed", async () => {
    const first = await usePolicyPath();
    await updateSensePolicy({ calendar: true });
    expect(await policyEnabled("calendar")).toBe(true);

    const second = path.join(tempDir ?? "", "other", "policy.json");
    process.env.SENSE_POLICY_PATH = second;
    expect(await policyEnabled("calendar")).toBe(false);
    await atomicWritePrivateFile(second, "invalid");
    process.env.SENSE_CALENDAR = "1";
    expect(await policyEnabled("calendar")).toBe(false);
    delete process.env.SENSE_CALENDAR;
    expect(first).not.toBe(second);
  });
});
