import { randomUUID } from "node:crypto";
import { chmod, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  listPrivateFiles,
  readPrivateFile,
  removePrivateFile,
} from "./privateFiles.js";

const SNAPSHOT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type SnapshotKind = "camera" | "screen";

export interface PersistedSnapshot {
  path: string;
  markdown_image: string;
  size_bytes: number;
}

export function snapshotDirectory(): string {
  return path.resolve(
    process.env.SENSE_SNAPSHOT_DIR || path.join(os.tmpdir(), `sense-mcp-${process.getuid?.() ?? "user"}`, "snapshots"),
  );
}

function snapshotFilename(kind: SnapshotKind, generatedAt: string): string {
  const safeTimestamp = generatedAt.replace(/[^0-9A-Za-z]/g, "-").slice(0, 64);
  return `sense-${kind}-${safeTimestamp}-${randomUUID()}.png`;
}

function isPng(buffer: Buffer): boolean {
  return buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function requirePng(buffer: Buffer): void {
  if (!isPng(buffer)) throw new Error("Sense snapshot data is not a PNG image");
}

function requireSnapshotPath(kind: SnapshotKind, file: string): string {
  const resolved = path.resolve(file);
  const directory = snapshotDirectory();
  if (path.dirname(resolved) !== directory) {
    throw new Error("Refusing to finalize a snapshot outside the configured private directory");
  }
  const pattern = new RegExp(`^sense-${kind}-.+\\.png$`);
  if (!pattern.test(path.basename(resolved))) {
    throw new Error("Refusing an invalid Sense snapshot filename");
  }
  return resolved;
}

async function cleanupOldSnapshots(directory: string, now = Date.now()): Promise<void> {
  const files = await listPrivateFiles(directory, {
    pattern: /^sense-(camera|screen)-.+\.png$/,
    maxEntries: 256,
  }).catch(() => []);
  await Promise.all(
    files.map(async (file) => {
      const info = await lstat(file).catch(() => undefined);
      if (!info || info.isSymbolicLink() || !info.isFile()) return;
      if (now - Number(info.mtimeMs) <= SNAPSHOT_MAX_AGE_MS) return;
      await removePrivateFile(file).catch(() => undefined);
    }),
  );
}

/** Reserve a private regular file before passing the path to a capture utility. */
export async function createSnapshotPath(
  kind: SnapshotKind,
  generatedAt: string,
): Promise<string> {
  const directory = snapshotDirectory();
  await ensurePrivateDirectory(directory);
  await cleanupOldSnapshots(directory);
  const file = path.join(directory, snapshotFilename(kind, generatedAt));
  await atomicWritePrivateFile(file, Buffer.alloc(0), { maxBytes: MAX_SNAPSHOT_BYTES });
  return file;
}

export async function persistSnapshotBuffer(
  kind: SnapshotKind,
  buffer: Buffer,
  generatedAt: string,
): Promise<PersistedSnapshot> {
  requirePng(buffer);
  if (buffer.length > MAX_SNAPSHOT_BYTES) {
    throw new Error(`Sense snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
  }
  const file = await createSnapshotPath(kind, generatedAt);
  try {
    await atomicWritePrivateFile(file, buffer, { maxBytes: MAX_SNAPSHOT_BYTES });
  } catch (error) {
    await removePrivateFile(file).catch(() => undefined);
    throw error;
  }

  return {
    path: file,
    markdown_image: `![Sense ${kind} snapshot](${file})`,
    size_bytes: buffer.length,
  };
}

export async function finalizeSnapshotFile(
  kind: SnapshotKind,
  file: string,
): Promise<PersistedSnapshot> {
  const resolved = requireSnapshotPath(kind, file);
  const buffer = await readPrivateFile(resolved, MAX_SNAPSHOT_BYTES);
  requirePng(buffer);
  await chmod(resolved, 0o600);

  return {
    path: resolved,
    markdown_image: `![Sense ${kind} snapshot](${resolved})`,
    size_bytes: buffer.length,
  };
}
