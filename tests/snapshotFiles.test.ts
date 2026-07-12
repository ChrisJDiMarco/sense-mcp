import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createSnapshotPath,
  finalizeSnapshotFile,
  persistSnapshotBuffer,
} from "../src/snapshotFiles.js";

let tempDir: string | undefined;
let previousSnapshotDir: string | undefined;

async function useSnapshotDir(): Promise<string> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "sense-snapshot-files-test-"));
  const directory = path.join(tempDir, "snapshots");
  previousSnapshotDir = process.env.SENSE_SNAPSHOT_DIR;
  process.env.SENSE_SNAPSHOT_DIR = directory;
  return directory;
}

afterEach(async () => {
  if (previousSnapshotDir === undefined) delete process.env.SENSE_SNAPSHOT_DIR;
  else process.env.SENSE_SNAPSHOT_DIR = previousSnapshotDir;
  previousSnapshotDir = undefined;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("snapshot files", () => {
  test("reserves a private unpredictable regular file before an external capture writes it", async () => {
    const directory = await useSnapshotDir();
    const file = await createSnapshotPath("screen", "2026-07-11T12:00:00.000Z");

    expect(file.startsWith(directory)).toBe(true);
    expect(path.basename(file)).toMatch(/^sense-screen-.+\.png$/);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
  });

  test("persists only bounded PNG data", async () => {
    await useSnapshotDir();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const saved = await persistSnapshotBuffer("camera", png, "2026-07-11T12:00:00.000Z");
    expect(await readFile(saved.path)).toEqual(png);

    await expect(
      persistSnapshotBuffer("camera", Buffer.from("not a png"), "2026-07-11T12:00:00.000Z"),
    ).rejects.toThrow(/png/i);
  });

  test("rejects snapshot directories with symlink ancestors", async () => {
    if (!tempDir) tempDir = await mkdtemp(path.join(os.tmpdir(), "sense-snapshot-files-test-"));
    const actual = path.join(tempDir, "actual", "nested");
    await writeFile(path.join(tempDir, "placeholder"), "x");
    await import("../src/privateFiles.js").then(({ ensurePrivateDirectory }) =>
      ensurePrivateDirectory(actual),
    );
    const linked = path.join(tempDir, "linked");
    await symlink(path.join(tempDir, "actual"), linked, "dir");
    previousSnapshotDir = process.env.SENSE_SNAPSHOT_DIR;
    process.env.SENSE_SNAPSHOT_DIR = path.join(linked, "nested", "snapshots");

    await expect(
      createSnapshotPath("screen", "2026-07-11T12:00:00.000Z"),
    ).rejects.toThrow(/symbolic link/i);
  });

  test("finalizes only a regular PNG created inside the configured snapshot directory", async () => {
    const directory = await useSnapshotDir();
    const outside = path.join(tempDir ?? "", "outside.png");
    await writeFile(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await chmod(outside, 0o600);
    await expect(finalizeSnapshotFile("screen", outside)).rejects.toThrow(/outside/i);

    const reserved = await createSnapshotPath("screen", "2026-07-11T12:00:00.000Z");
    await rm(reserved);
    await symlink(outside, reserved);
    await expect(finalizeSnapshotFile("screen", reserved)).rejects.toThrow(/symbolic link/i);
    expect((await lstat(directory)).isDirectory()).toBe(true);
  });
});
