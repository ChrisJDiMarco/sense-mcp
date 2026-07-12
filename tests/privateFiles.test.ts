import { chmod, lstat, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  readPrivateFile,
  readPrivateText,
  removePrivateFile,
  withPrivateFileLock,
} from "../src/privateFiles.js";

let tempDir: string | undefined;

async function useTempDir(): Promise<string> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "sense-private-files-test-"));
  return tempDir;
}

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("private file primitives", () => {
  test("creates private directories and atomically replaces private files", async () => {
    const root = await useTempDir();
    const directory = path.join(root, "private");
    const file = path.join(directory, "state.json");

    await ensurePrivateDirectory(directory);
    await atomicWritePrivateFile(file, "first");
    await atomicWritePrivateFile(file, "second");

    expect(await readPrivateText(file, 32)).toBe("second");
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
  });

  test("rejects symlink directories and files instead of following them", async () => {
    const root = await useTempDir();
    const realDirectory = path.join(root, "real");
    const linkedDirectory = path.join(root, "linked");
    await ensurePrivateDirectory(realDirectory);
    await symlink(realDirectory, linkedDirectory, "dir");
    await expect(ensurePrivateDirectory(linkedDirectory)).rejects.toThrow(/symbolic link/i);

    const realFile = path.join(realDirectory, "real.txt");
    const linkedFile = path.join(realDirectory, "linked.txt");
    await writeFile(realFile, "private");
    await chmod(realFile, 0o600);
    await symlink(realFile, linkedFile);
    await expect(readPrivateFile(linkedFile, 32)).rejects.toThrow(/symbolic link/i);
    await expect(removePrivateFile(linkedFile)).rejects.toThrow(/symbolic link/i);
    expect(await readFile(realFile, "utf8")).toBe("private");
  });

  test("rejects a symlink hidden in an earlier path component", async () => {
    const root = await useTempDir();
    const realDirectory = path.join(root, "actual", "nested");
    await ensurePrivateDirectory(realDirectory);
    const linkedRoot = path.join(root, "linked-root");
    await symlink(path.join(root, "actual"), linkedRoot, "dir");

    await expect(
      ensurePrivateDirectory(path.join(linkedRoot, "nested", "private")),
    ).rejects.toThrow(/symbolic link/i);
  });

  test("bounds reads even if a file is larger than its declared limit", async () => {
    const root = await useTempDir();
    const file = path.join(root, "large.txt");
    await atomicWritePrivateFile(file, "123456789");

    await expect(readPrivateFile(file, 8)).rejects.toThrow(/maximum size/i);
  });

  test("serializes concurrent updates through a private lock", async () => {
    const root = await useTempDir();
    const file = path.join(root, "counter.txt");
    const lock = path.join(root, "counter.lock");
    await atomicWritePrivateFile(file, "0");

    await Promise.all(
      Array.from({ length: 20 }, () =>
        withPrivateFileLock(lock, async () => {
          const current = Number(await readPrivateText(file, 32));
          await atomicWritePrivateFile(file, String(current + 1));
        }),
      ),
    );

    expect(await readPrivateText(file, 32)).toBe("20");
  });

  test("does not reap an old lock while its owner process is alive", async () => {
    const root = await useTempDir();
    const lock = path.join(root, "live.lock");
    await atomicWritePrivateFile(
      lock,
      `${JSON.stringify({ pid: process.pid, created_at: "2000-01-01T00:00:00.000Z" })}\n`,
    );
    await utimes(lock, new Date(0), new Date(0));

    await expect(
      withPrivateFileLock(lock, async () => undefined, { timeoutMs: 40, staleMs: 10 }),
    ).rejects.toThrow(/timed out acquiring/i);
    expect((await lstat(lock)).isFile()).toBe(true);
  });
});
